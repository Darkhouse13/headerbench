/**
 * Structural validation of a `State` sent by a page. Unlike core's `tryMigrate`, it never repairs
 * or drops rows: a blank row the user just added must survive the round trip. Content checks
 * (header syntax, regexes) are the compiler's job and only produce warnings.
 */
import type { State } from '@headerbench/core';
import { ENV_TAGS, METHODS, RESOURCE_TYPES, SCHEMA_VERSION } from '@headerbench/core';

type Raw = Record<string, unknown>;
type Check = (value: unknown, path: string) => string | null;

const isObj = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);

const str: Check = (v, p) => (typeof v === 'string' ? null : `${p} must be text`);
const bool: Check = (v, p) => (typeof v === 'boolean' ? null : `${p} must be true or false`);
const time: Check = (v, p) =>
  typeof v === 'number' && Number.isFinite(v) ? null : `${p} must be a number`;
const nullable =
  (check: Check): Check =>
  (v, p) =>
    v === null ? null : check(v, p);
const id: Check = (v, p) =>
  typeof v === 'string' && v.length > 0 ? null : `${p} must be a non-empty id`;
const oneOf =
  (allowed: readonly string[]): Check =>
  (v, p) =>
    typeof v === 'string' && allowed.includes(v)
      ? null
      : `${p} must be one of ${allowed.join(', ')}`;
const int: Check = (v, p) => (Number.isInteger(v) ? null : `${p} must be a whole number`);

function shape(fields: Record<string, Check>): Check {
  return (v, p) => {
    if (!isObj(v)) return `${p} must be an object`;
    for (const [key, check] of Object.entries(fields)) {
      const problem = check(v[key], `${p}.${key}`);
      if (problem) return problem;
    }
    return null;
  };
}

function listOf(item: Check, options: { unique?: boolean } = {}): Check {
  return (v, p) => {
    if (!Array.isArray(v)) return `${p} must be a list`;
    for (let i = 0; i < v.length; i++) {
      const problem = item(v[i], `${p}[${i}]`);
      if (problem) return problem;
    }
    if (options.unique) {
      const ids = v.map((x: Raw) => x.id);
      if (new Set(ids).size !== ids.length) return `${p} has duplicate ids`;
    }
    return null;
  };
}

const enumList = (allowed: readonly string[]): Check => listOf(oneOf(allowed));

const headerMod = shape({
  id,
  enabled: bool,
  name: str,
  value: str,
  op: oneOf(['set', 'append', 'remove']),
  comment: str,
});

const profile = shape({
  id,
  name: str,
  badge: (v, p) => (typeof v === 'string' && v.length <= 2 ? null : `${p} must be 0–2 characters`),
  color: (v, p) =>
    typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? null : `${p} must be a #rrggbb colour`,
  env: oneOf(ENV_TAGS),
  requestHeaders: listOf(headerMod, { unique: true }),
  responseHeaders: listOf(headerMod, { unique: true }),
  filters: listOf(
    shape({
      id,
      enabled: bool,
      kind: oneOf(['domain', 'urlFilter', 'regex']),
      value: str,
      exclude: bool,
    }),
    { unique: true },
  ),
  resourceTypes: enumList(RESOURCE_TYPES),
  methods: enumList(METHODS),
  redirects: listOf(
    shape({
      id,
      enabled: bool,
      kind: oneOf(['url', 'urlFilter', 'regex']),
      from: str,
      to: str,
      comment: str,
    }),
    { unique: true },
  ),
  blocks: listOf(
    shape({ id, enabled: bool, kind: oneOf(['urlFilter', 'regex']), pattern: str, comment: str }),
    { unique: true },
  ),
  mocks: listOf(
    shape({
      id,
      enabled: bool,
      kind: oneOf(['urlFilter', 'regex']),
      pattern: str,
      contentType: str,
      body: str,
      comment: str,
    }),
    { unique: true },
  ),
  createdAt: time,
  updatedAt: time,
});

const settings = shape({
  paused: bool,
  activations: listOf(shape({ profileId: id, tabId: nullable(int), pauseAt: nullable(time) })),
  variables: listOf(shape({ id, name: str, value: str }), { unique: true }),
  sync: bool,
  theme: oneOf(['system', 'light', 'dark']),
  trialStartedAt: nullable(time),
  licenseKey: nullable(str),
  review: shape({
    activeDays: listOf(str),
    state: oneOf(['pending', 'shown', 'dismissed', 'rated']),
  }),
});

/** Returns null when `raw` is a well-formed current-schema State, else the first problem found. */
export function stateProblem(raw: unknown): string | null {
  if (!isObj(raw)) return 'state must be an object';
  if (raw.schemaVersion !== SCHEMA_VERSION) return `state.schemaVersion must be ${SCHEMA_VERSION}`;
  return (
    listOf(profile, { unique: true })(raw.profiles, 'state.profiles') ??
    settings(raw.settings, 'state.settings')
  );
}

export function isValidState(raw: unknown): raw is State {
  return stateProblem(raw) === null;
}

/**
 * Drops activations of missing profiles and duplicates: a profile keeps at most one global
 * activation and one activation per tab (the first one listed wins).
 */
export function normalizeState(state: State): State {
  const ids = new Set(state.profiles.map((p) => p.id));
  const seen = new Set<string>();
  const activations = state.settings.activations.filter((a) => {
    const key = `${a.profileId}|${a.tabId ?? 'all'}`;
    if (!ids.has(a.profileId) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { ...state, settings: { ...state.settings, activations } };
}
