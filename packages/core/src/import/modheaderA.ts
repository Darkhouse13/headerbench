/**
 * ModHeader Format A: a JSON array of profile objects (or one profile object), `version: 2`.
 * Profiles without `version` are v1 and keep their filters in one `filters[]` list.
 * Schema: research/04-competitors.md "Format A".
 */
import type { HeaderMod, Profile, RedirectRule, ResourceType, UrlFilter } from '../model.js';
import { RESOURCE_TYPES, badgeFor, newId, PROFILE_COLORS } from '../model.js';
import { isRecord } from '../migrate.js';
import type { ImportFormat, ReportBuilder } from './report.js';
import {
  asString,
  finalizeProfile,
  headerRow,
  hexColor,
  isAppendMode,
  regexFilter,
} from './shared.js';

type Raw = Record<string, unknown>;

const PROFILE_KEYS = [
  'version',
  'title',
  'shortTitle',
  'hideComment',
  'backgroundColor',
  'textColor',
  'appendMode',
  'sendEmptyHeader',
  'headers',
  'respHeaders',
  'urlFilters',
  'excludeUrlFilters',
  'resourceFilters',
  'urlReplacements',
  'filters',
];
const ROW_KEYS = ['enabled', 'name', 'value', 'comment'];
const FILTER_KEYS = ['enabled', 'urlRegex', 'resourceType', 'comment', 'type'];

function looksLikeProfile(value: unknown): value is Raw {
  return (
    isRecord(value) && ('headers' in value || 'respHeaders' in value) && !('sections' in value)
  );
}

/** A top-level array of profile objects, or a single profile object. */
export function isModHeaderA(json: unknown): boolean {
  if (Array.isArray(json)) return json.length > 0 && json.some(looksLikeProfile);
  return looksLikeProfile(json);
}

function rows(
  value: unknown,
  field: string,
  profile: string,
  report: ReportBuilder,
  known: string[],
): Raw[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    report.warn(profile, `"${field}" is not a list, so it was skipped.`);
    return [];
  }
  const out = value.filter(isRecord);
  if (out.length < value.length)
    report.warn(
      profile,
      `${value.length - out.length} malformed entries in "${field}" were skipped.`,
    );
  out.forEach((row) => report.unknownKeys(row, known));
  return out;
}

function headers(
  raw: Raw,
  field: 'headers' | 'respHeaders',
  profile: string,
  report: ReportBuilder,
): HeaderMod[] {
  const append = isAppendMode(raw.appendMode, profile, report);
  const sendEmpty = raw.sendEmptyHeader === true;
  let empty = 0;
  const out: HeaderMod[] = [];
  for (const row of rows(raw[field], field, profile, report, ROW_KEYS)) {
    const name = asString(row.name).trim();
    if (name.length === 0) {
      empty++;
      continue;
    }
    const value = asString(row.value);
    const op = value.length === 0 && !sendEmpty ? 'remove' : append ? 'append' : 'set';
    out.push(
      headerRow(
        { enabled: row.enabled !== false, name, value, comment: asString(row.comment) },
        op,
        profile,
        report,
      ),
    );
  }
  if (empty > 0)
    report.info(
      profile,
      `${empty} ${field === 'headers' ? 'request' : 'response'} header rows with no name were skipped.`,
    );
  return out;
}

interface FilterLists {
  includes: Raw[];
  excludes: Raw[];
  types: Raw[];
}

function filterLists(raw: Raw, v1: boolean, profile: string, report: ReportBuilder): FilterLists {
  const lists: FilterLists = {
    includes: rows(raw.urlFilters, 'urlFilters', profile, report, FILTER_KEYS),
    excludes: rows(raw.excludeUrlFilters, 'excludeUrlFilters', profile, report, FILTER_KEYS),
    types: rows(raw.resourceFilters, 'resourceFilters', profile, report, FILTER_KEYS),
  };
  if (v1) {
    for (const f of rows(raw.filters, 'filters', profile, report, FILTER_KEYS)) {
      if (f.type === 'urls') lists.includes.push(f);
      else if (f.type === 'excludeUrls') lists.excludes.push(f);
      else if (f.type === 'types') lists.types.push(f);
      else report.warn(profile, `A filter of unknown type "${asString(f.type)}" was skipped.`);
    }
  }
  return lists;
}

function urlFilters(lists: FilterLists, profile: string, report: ReportBuilder): UrlFilter[] {
  const convert = (f: Raw, exclude: boolean): UrlFilter[] => {
    const regex = asString(f.urlRegex).trim();
    return regex.length === 0
      ? []
      : [regexFilter(regex, f.enabled !== false, exclude, profile, report)];
  };
  return [
    ...lists.includes.flatMap((f) => convert(f, false)),
    ...lists.excludes.flatMap((f) => convert(f, true)),
  ];
}

function resourceTypes(types: Raw[], profile: string, report: ReportBuilder): ResourceType[] {
  const out = new Set<ResourceType>();
  for (const f of types) {
    if (f.enabled === false) continue;
    const listed = Array.isArray(f.resourceType) ? f.resourceType : [f.resourceType];
    for (const t of listed) {
      if (RESOURCE_TYPES.includes(t as ResourceType)) out.add(t as ResourceType);
      else
        report.warn(
          profile,
          `Resource type "${asString(t)}" is not supported by Chrome rules and was skipped.`,
        );
    }
  }
  return out.size === RESOURCE_TYPES.length ? [] : [...out];
}

function redirects(raw: Raw, profile: string, report: ReportBuilder): RedirectRule[] {
  const out = rows(raw.urlReplacements, 'urlReplacements', profile, report, ROW_KEYS).flatMap(
    (r) => {
      const from = asString(r.name).trim();
      if (from.length === 0) return [];
      return [
        {
          id: newId(),
          enabled: r.enabled !== false,
          kind: 'regex' as const,
          from,
          to: asString(r.value).trim(),
          comment: asString(r.comment),
        },
      ];
    },
  );
  if (out.length > 0) {
    report.info(
      profile,
      out.length === 1
        ? '1 URL replacement became a regex redirect. It runs with Pro or during the trial.'
        : `${out.length} URL replacements became regex redirects. They run with Pro or during the trial.`,
    );
  }
  return out;
}

function convertProfile(raw: Raw, index: number, now: number, report: ReportBuilder): Profile {
  report.unknownKeys(raw, PROFILE_KEYS);
  const name = asString(raw.title).trim() || `Profile ${index + 1}`;
  const v1 = raw.version === undefined;
  const lists = filterLists(raw, v1, name, report);
  const profile: Profile = {
    id: newId(),
    name,
    badge: asString(raw.shortTitle).trim().slice(0, 2) || badgeFor(name),
    color:
      hexColor(raw.backgroundColor) ?? (PROFILE_COLORS[index % PROFILE_COLORS.length] as string),
    env: 'none',
    requestHeaders: headers(raw, 'headers', name, report),
    responseHeaders: headers(raw, 'respHeaders', name, report),
    filters: urlFilters(lists, name, report),
    resourceTypes: resourceTypes(lists.types, name, report),
    methods: [],
    redirects: redirects(raw, name, report),
    blocks: [],
    mocks: [],
    createdAt: now,
    updatedAt: now,
  };
  return finalizeProfile(profile, report);
}

export function importModHeaderA(
  json: unknown,
  report: ReportBuilder,
  now: number,
): { format: ImportFormat; profiles: Profile[] } {
  const entries = Array.isArray(json) ? json : [json];
  const profiles: Profile[] = [];
  let v1 = false;
  entries.forEach((entry, i) => {
    if (!isRecord(entry)) {
      report.error(`Entry ${i + 1} in the file is not a profile object.`);
      return;
    }
    if (entry.version === undefined) v1 = true;
    profiles.push(convertProfile(entry, i, now, report));
  });
  return { format: v1 ? 'modheader-a-v1' : 'modheader-a-v2', profiles };
}
