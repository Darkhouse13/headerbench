/**
 * Format B: the open-source ModHeader v2 clone. Either a wrapper
 * `{ modheader: 2, exportedAt, profiles: [...] }` or a single profile with `sections`.
 * Schema: research/04-competitors.md "Format B". Rule fields beyond name/value/enabled are not
 * documented, so `op`/`operation` and `from`/`to` are accepted when present.
 */
import type {
  HeaderMod,
  HeaderOp,
  Method,
  Profile,
  RedirectRule,
  ResourceType,
  UrlFilter,
} from '../model.js';
import { METHODS, RESOURCE_TYPES, badgeFor, newId, PROFILE_COLORS } from '../model.js';
import { isRecord } from '../migrate.js';
import type { ReportBuilder } from './report.js';
import {
  asString,
  finalizeProfile,
  headerRow,
  hexColor,
  isAppendMode,
  redirectFromSource,
} from './shared.js';

type Raw = Record<string, unknown>;

const PROFILE_KEYS = ['id', 'name', 'enabled', 'color', 'sections', 'filters', 'appendMode'];
const SECTION_KEYS = ['enabled', 'rules'];
const RULE_KEYS = [
  'id',
  'enabled',
  'name',
  'value',
  'comment',
  'op',
  'operation',
  'appendMode',
  'from',
  'to',
];
const FILTER_KEYS = ['id', 'enabled', 'mode', 'type', 'value'];
const KNOWN_SECTIONS = ['request', 'response', 'cookies', 'redirects', 'csp'];
const OPS: readonly HeaderOp[] = ['set', 'append', 'remove'];

export function isModHeaderB(json: unknown): boolean {
  if (!isRecord(json)) return false;
  return ('modheader' in json && Array.isArray(json.profiles)) || isRecord(json.sections);
}

interface Section {
  enabled: boolean;
  rules: Raw[];
}

function section(sections: Raw, key: string, report: ReportBuilder): Section {
  const raw = sections[key];
  if (!isRecord(raw)) return { enabled: true, rules: [] };
  report.unknownKeys(raw, SECTION_KEYS);
  const rules = Array.isArray(raw.rules) ? raw.rules.filter(isRecord) : [];
  rules.forEach((r) => report.unknownKeys(r, RULE_KEYS));
  return { enabled: raw.enabled !== false, rules };
}

/** `appendMode` on the profile applies to every rule without its own `op` or `appendMode`. */
function headers(
  s: Section,
  profileAppend: boolean,
  profile: string,
  report: ReportBuilder,
): HeaderMod[] {
  return s.rules.flatMap((r) => {
    const name = asString(r.name).trim();
    if (name.length === 0) return [];
    const append =
      r.appendMode === undefined ? profileAppend : isAppendMode(r.appendMode, profile, report);
    const op = OPS.find((o) => o === r.op || o === r.operation) ?? (append ? 'append' : 'set');
    return [
      headerRow(
        {
          enabled: s.enabled && r.enabled !== false,
          name,
          value: asString(r.value),
          comment: asString(r.comment),
        },
        op,
        profile,
        report,
      ),
    ];
  });
}

function redirects(s: Section): RedirectRule[] {
  return s.rules.flatMap((r) => {
    const from = asString(r.from ?? r.name).trim();
    if (from.length === 0) return [];
    return [
      redirectFromSource(
        from,
        asString(r.to ?? r.value).trim(),
        s.enabled && r.enabled !== false,
        asString(r.comment),
      ),
    ];
  });
}

interface Filters {
  filters: UrlFilter[];
  resourceTypes: ResourceType[];
  methods: Method[];
}

/** include values (or everything if none), minus exclude values; "everything" collapses to []. */
function narrow<T extends string>(all: readonly T[], include: T[], exclude: T[]): T[] {
  const base = include.length > 0 ? include : [...all];
  const out = [...new Set(base.filter((v) => !exclude.includes(v)))];
  return out.length === all.length ? [] : out;
}

function filters(raw: unknown, profile: string, report: ReportBuilder): Filters {
  const types = { include: [] as ResourceType[], exclude: [] as ResourceType[] };
  const methods = { include: [] as Method[], exclude: [] as Method[] };
  const out: UrlFilter[] = [];
  const entries = Array.isArray(raw) ? raw.filter(isRecord) : [];
  for (const f of entries) {
    report.unknownKeys(f, FILTER_KEYS);
    const exclude = f.mode === 'exclude';
    const enabled = f.enabled !== false;
    const value = asString(f.value).trim();
    if (value.length === 0) continue;
    switch (f.type) {
      case 'url':
      case 'regex':
        out.push({
          id: newId(),
          enabled,
          kind: f.type === 'url' ? 'urlFilter' : 'regex',
          value,
          exclude,
        });
        break;
      case 'resource':
      case 'method': {
        if (!enabled) continue;
        const values = value.split(',').map((v) => v.trim().toLowerCase());
        const target = f.type === 'resource' ? types : methods;
        const allowed: readonly string[] = f.type === 'resource' ? RESOURCE_TYPES : METHODS;
        for (const v of values) {
          if (allowed.includes(v)) (exclude ? target.exclude : target.include).push(v as never);
          else
            report.warn(
              profile,
              `${f.type === 'resource' ? 'Resource type' : 'Method'} "${v}" is not supported and was skipped.`,
            );
        }
        break;
      }
      case 'tab':
        report.warn(
          profile,
          'A tab filter was not imported. Turn on "This tab only" when you activate the profile instead.',
        );
        break;
      default:
        report.warn(profile, `A filter of unknown type "${asString(f.type)}" was skipped.`);
    }
  }
  return {
    filters: out,
    resourceTypes: narrow(RESOURCE_TYPES, types.include, types.exclude),
    methods: narrow(METHODS, methods.include, methods.exclude),
  };
}

function convertProfile(raw: Raw, index: number, now: number, report: ReportBuilder): Profile {
  report.unknownKeys(raw, PROFILE_KEYS);
  const name = asString(raw.name).trim() || `Profile ${index + 1}`;
  const sections = isRecord(raw.sections) ? raw.sections : {};
  report.unknownKeys(sections, KNOWN_SECTIONS);
  const cookies = section(sections, 'cookies', report);
  if (cookies.rules.length > 0) {
    report.warn(
      name,
      `${cookies.rules.length} cookie rule(s) were not imported. Headerbench edits headers: add a Cookie request header instead.`,
    );
  }
  const csp = section(sections, 'csp', report);
  if (csp.rules.length > 0) {
    report.warn(
      name,
      `${csp.rules.length} CSP rule(s) were not imported. Use the "Remove CSP" response header preset instead.`,
    );
  }
  const f = filters(raw.filters, name, report);
  const append = isAppendMode(raw.appendMode, name, report);
  const profile: Profile = {
    id: newId(),
    name,
    badge: badgeFor(name),
    color: hexColor(raw.color) ?? (PROFILE_COLORS[index % PROFILE_COLORS.length] as string),
    env: 'none',
    requestHeaders: headers(section(sections, 'request', report), append, name, report),
    responseHeaders: headers(section(sections, 'response', report), append, name, report),
    filters: f.filters,
    resourceTypes: f.resourceTypes,
    methods: f.methods,
    redirects: redirects(section(sections, 'redirects', report)),
    blocks: [],
    mocks: [],
    createdAt: now,
    updatedAt: now,
  };
  return finalizeProfile(profile, report);
}

export function importModHeaderB(json: Raw, report: ReportBuilder, now: number): Profile[] {
  if (!('sections' in json)) report.unknownKeys(json, ['modheader', 'exportedAt', 'profiles']);
  const entries: unknown[] = 'sections' in json ? [json] : (json.profiles as unknown[]);
  const profiles: Profile[] = [];
  entries.forEach((entry, i) => {
    if (isRecord(entry)) profiles.push(convertProfile(entry, i, now, report));
    else report.error(`Profile ${i + 1} in the file is not an object.`);
  });
  return profiles;
}
