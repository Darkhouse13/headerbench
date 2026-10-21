/**
 * Upgrades and repairs stored state. Anything without `schemaVersion` is treated as v0: a loose,
 * possibly partial version of the v1 shape. Every field is coerced to its type with a default,
 * and items that cannot be repaired are dropped.
 */
import type {
  Activation,
  BlockRule,
  EnvTag,
  HeaderMod,
  HeaderOp,
  Method,
  MockRule,
  Profile,
  RedirectRule,
  ResourceType,
  ReviewState,
  Settings,
  State,
  Theme,
  UrlFilter,
  Variable,
} from './model.js';
import {
  ENV_TAGS,
  METHODS,
  RESOURCE_TYPES,
  SCHEMA_VERSION,
  badgeFor,
  defaultSettings,
  defaultState,
  newId,
  PROFILE_COLORS,
} from './model.js';
import { VARIABLE_NAME } from './validate.js';

type Raw = Record<string, unknown>;

export function isRecord(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);
const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;
const numOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(v as T) ? (v as T) : fallback;
const id = (v: unknown): string => (typeof v === 'string' && v.length > 0 ? v : newId());

function list<T>(v: unknown, item: (raw: Raw) => T | null): T[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const out = item(entry);
    return out === null ? [] : [out];
  });
}

/** Lists of ids get fresh ids for duplicates so the UI and compiler can key by id. */
function uniqueIds<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.map((item) => {
    if (!seen.has(item.id)) {
      seen.add(item.id);
      return item;
    }
    const copy = { ...item, id: newId() };
    seen.add(copy.id);
    return copy;
  });
}

const HEADER_OPS: readonly HeaderOp[] = ['set', 'append', 'remove'];

export function sanitizeHeaderMod(raw: Raw): HeaderMod {
  return {
    id: id(raw.id),
    enabled: bool(raw.enabled, true),
    name: str(raw.name).trim(),
    value: str(raw.value),
    op: oneOf(raw.op, HEADER_OPS, 'set'),
    comment: str(raw.comment),
  };
}

export function sanitizeFilter(raw: Raw): UrlFilter | null {
  const value = str(raw.value).trim();
  if (value.length === 0) return null;
  return {
    id: id(raw.id),
    enabled: bool(raw.enabled, true),
    kind: oneOf(raw.kind, ['domain', 'urlFilter', 'regex'] as const, 'urlFilter'),
    value,
    exclude: bool(raw.exclude, false),
  };
}

export function sanitizeRedirect(raw: Raw): RedirectRule | null {
  const from = str(raw.from).trim();
  if (from.length === 0) return null;
  return {
    id: id(raw.id),
    enabled: bool(raw.enabled, true),
    kind: oneOf(raw.kind, ['url', 'urlFilter', 'regex'] as const, 'url'),
    from,
    to: str(raw.to).trim(),
    comment: str(raw.comment),
  };
}

export function sanitizeBlock(raw: Raw): BlockRule | null {
  const pattern = str(raw.pattern).trim();
  if (pattern.length === 0) return null;
  return {
    id: id(raw.id),
    enabled: bool(raw.enabled, true),
    kind: oneOf(raw.kind, ['urlFilter', 'regex'] as const, 'urlFilter'),
    pattern,
    comment: str(raw.comment),
  };
}

export function sanitizeMock(raw: Raw): MockRule | null {
  const pattern = str(raw.pattern).trim();
  if (pattern.length === 0) return null;
  return {
    id: id(raw.id),
    enabled: bool(raw.enabled, true),
    kind: oneOf(raw.kind, ['urlFilter', 'regex'] as const, 'urlFilter'),
    pattern,
    contentType: str(raw.contentType, 'application/json').trim() || 'application/json',
    body: str(raw.body),
    comment: str(raw.comment),
  };
}

export function sanitizeProfile(raw: Raw, index: number, now: number): Profile {
  const name = str(raw.name).trim() || `Profile ${index + 1}`;
  const badge = str(raw.badge).trim().slice(0, 2) || badgeFor(name);
  const color = /^#[0-9a-f]{6}$/i.test(str(raw.color))
    ? str(raw.color).toLowerCase()
    : (PROFILE_COLORS[index % PROFILE_COLORS.length] as string);
  const createdAt = num(raw.createdAt, now);
  const filter = <T>(v: unknown, allowed: readonly T[]): T[] =>
    Array.isArray(v) ? [...new Set(v.filter((x): x is T => allowed.includes(x as T)))] : [];
  return {
    id: id(raw.id),
    name,
    badge,
    color,
    env: oneOf<EnvTag>(raw.env, ENV_TAGS, 'none'),
    requestHeaders: uniqueIds(list(raw.requestHeaders, sanitizeHeaderMod)),
    responseHeaders: uniqueIds(list(raw.responseHeaders, sanitizeHeaderMod)),
    filters: uniqueIds(list(raw.filters, sanitizeFilter)),
    resourceTypes: filter<ResourceType>(raw.resourceTypes, RESOURCE_TYPES),
    methods: filter<Method>(raw.methods, METHODS),
    redirects: uniqueIds(list(raw.redirects, sanitizeRedirect)),
    blocks: uniqueIds(list(raw.blocks, sanitizeBlock)),
    mocks: uniqueIds(list(raw.mocks, sanitizeMock)),
    createdAt,
    updatedAt: num(raw.updatedAt, createdAt),
  };
}

export function sanitizeVariables(v: unknown): Variable[] {
  const seen = new Set<string>();
  return list(v, (raw) => {
    const name = str(raw.name).trim();
    if (!VARIABLE_NAME.test(name) || seen.has(name)) return null;
    seen.add(name);
    return { id: id(raw.id), name, value: str(raw.value) };
  });
}

function sanitizeSettings(raw: unknown, profileIds: Set<string>): Settings {
  const defaults = defaultSettings();
  if (!isRecord(raw)) return defaults;
  const activations = list<Activation>(raw.activations, (a) => {
    const profileId = str(a.profileId);
    if (!profileIds.has(profileId)) return null;
    const tabId = numOrNull(a.tabId);
    return {
      profileId,
      tabId: tabId === null ? null : Math.trunc(tabId),
      pauseAt: numOrNull(a.pauseAt),
    };
  });
  const seen = new Set<string>();
  const review = isRecord(raw.review) ? raw.review : {};
  return {
    paused: bool(raw.paused, defaults.paused),
    activations: activations.filter((a) => {
      const key = `${a.profileId}|${a.tabId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
    variables: sanitizeVariables(raw.variables),
    sync: bool(raw.sync, defaults.sync),
    theme: oneOf<Theme>(raw.theme, ['system', 'light', 'dark'], defaults.theme),
    trialStartedAt: numOrNull(raw.trialStartedAt),
    licenseKey:
      typeof raw.licenseKey === 'string' && raw.licenseKey.length > 0 ? raw.licenseKey : null,
    review: {
      activeDays: Array.isArray(review.activeDays)
        ? review.activeDays
            .filter((d): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d))
            .slice(-3)
        : [],
      state: oneOf<ReviewState>(
        review.state,
        ['pending', 'shown', 'dismissed', 'rated'],
        'pending',
      ),
    },
  };
}

export type MigrateResult =
  { ok: true; state: State } | { ok: false; reason: 'not_an_object' | 'newer_schema' };

/** Upgrades a stored blob of schema version `n` to version `n + 1`. */
export type Migration = (raw: Raw) => Raw;

/**
 * The version ladder: `MIGRATIONS[n]` turns version n into n + 1, and there is a step for every
 * version below SCHEMA_VERSION. A schema bump adds its step here and raises SCHEMA_VERSION.
 * v0 (no `schemaVersion`) is a loose v1: the sanitizer that runs after the ladder repairs it.
 */
export const MIGRATIONS: Readonly<Record<number, Migration>> = {
  0: (raw) => raw,
};

function climb(raw: Raw, from: number): Raw {
  let out = raw;
  for (let v = from; v < SCHEMA_VERSION; v++) {
    const step = MIGRATIONS[v];
    if (!step) throw new Error(`No migration from schema version ${v}.`);
    out = step(out);
  }
  return out;
}

/**
 * Upgrades `raw` (from storage) to the current schema. Fails only when there is nothing usable
 * (not an object) or the data comes from a newer Headerbench, so the caller can fall back to the
 * backup and keep the raw blob.
 */
export function tryMigrate(input: unknown, now: number = Date.now()): MigrateResult {
  if (!isRecord(input)) return { ok: false, reason: 'not_an_object' };
  const version = num(input.schemaVersion, 0);
  if (version > SCHEMA_VERSION) return { ok: false, reason: 'newer_schema' };
  const raw = climb(input, Math.max(0, Math.floor(version)));
  const profiles = uniqueIds(
    Array.isArray(raw.profiles)
      ? raw.profiles.filter(isRecord).map((p, i) => sanitizeProfile(p, i, now))
      : [],
  );
  const state: State = {
    schemaVersion: SCHEMA_VERSION,
    profiles,
    settings: sanitizeSettings(raw.settings, new Set(profiles.map((p) => p.id))),
  };
  return { ok: true, state };
}

/** Like `tryMigrate`, but returns a fresh default state when the input is unusable. */
export function migrate(raw: unknown, now: number = Date.now()): State {
  const result = tryMigrate(raw, now);
  return result.ok ? result.state : defaultState();
}
