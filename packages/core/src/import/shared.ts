import { checkBlock, checkFilter, checkHeaderMod, checkMock, checkRedirect } from '../items.js';
import type { HeaderMod, Profile, RedirectRule, UrlFilter } from '../model.js';
import { newId } from '../model.js';
import { checkExactUrl, normalizeDomain } from '../validate.js';
import type { ReportBuilder } from './report.js';

export const DYNAMIC_VALUE = /^\s*(async\s+)?function\s*\(/;

export interface SimpleFilter {
  kind: 'domain' | 'urlFilter';
  value: string;
  /** What the filter now matches, for the import report. */
  description: string;
}

/**
 * Turns a simple ModHeader host regex into a narrower filter, so the profile only needs access to
 * that site instead of all sites:
 * - `.*://api\.example\.com/.*` (any scheme, no port) → domain `api.example.com`
 * - `https?://localhost:3000/.*` (any scheme, a port) → urlFilter `||localhost:3000/`
 * - `^https://api\.example\.com(:8443)?/.*` (one scheme) → urlFilter `|https://api.example.com/`
 * - `^https://api\.example\.com/$` (one scheme, `$` right after the host's `/`) → urlFilter
 *   `|https://api.example.com/|`, which matches that exact address and nothing below it
 * Returns null if the regex is anything more than "this host (and port), any path" or "this
 * site's root address", or if the conversion would match more than the regex: subdomains of a
 * single-scheme host, a root address for any scheme or with subdomains, and a host with `$` but
 * no path (no URL matches that, since Chrome always gives one).
 */
export function regexToFilter(regex: string): SimpleFilter | null {
  let rest = regex.replace(/^\^/, '');
  // An unescaped trailing `$`; it only narrows the match when the path before it is fixed.
  const endAnchored = /(?:^|[^\\])(?:\\\\)*\$$/.test(rest);
  if (endAnchored) rest = rest.slice(0, -1);
  const scheme =
    /^(\.\*|https\?|https|http|\(https\?\)|\(https\|http\)|\(http\|https\))?(?::\\\/\\\/|:\/\/)/.exec(
      rest,
    );
  if (!scheme) return null;
  rest = rest.slice(scheme[0].length);
  const fixedScheme = scheme[1] === 'https' || scheme[1] === 'http' ? scheme[1] : null;
  const subdomains = /^(?:\.\*\\\.|\(\.\*\\\.\)\?)/.exec(rest);
  if (subdomains) rest = rest.slice(subdomains[0].length);
  const hostMatch = /^[a-z0-9-]+(?:(?:\\\.|\.)[a-z0-9-]+)*/i.exec(rest);
  if (!hostMatch) return null;
  const tail = /^(?::(\d+))?(\\?\/\.\*|\\?\/|\.\*)?$/.exec(rest.slice(hostMatch[0].length));
  if (!tail) return null;
  const host = normalizeDomain(hostMatch[0].replace(/\\\./g, '.'));
  if (!host) return null;
  const port = tail[1];
  const path = tail[2];
  if (endAnchored && !path?.endsWith('.*')) {
    if (path === undefined || fixedScheme === null || subdomains) return null;
    const value = `|${fixedScheme}://${host}${port === undefined ? '' : `:${port}`}/|`;
    return {
      kind: 'urlFilter',
      value,
      description: `the URL filter ${value} (only that exact address)`,
    };
  }
  if (fixedScheme === null && port === undefined) {
    return {
      kind: 'domain',
      value: host,
      description: `the domain filter ${host} (it also covers subdomains)`,
    };
  }
  if (fixedScheme === null) {
    const value = `||${host}:${port}/`;
    return {
      kind: 'urlFilter',
      value,
      description: `the URL filter ${value} (port ${port} only, any scheme, also subdomains)`,
    };
  }
  // `|https://host/` cannot also cover subdomains without a wildcard that matches far more.
  if (subdomains) return null;
  const value = `|${fixedScheme}://${host}${port === undefined ? '' : `:${port}`}/`;
  return {
    kind: 'urlFilter',
    value,
    description: `the URL filter ${value} (${fixedScheme} only${port === undefined ? '' : `, port ${port} only`})`,
  };
}

/** A regex include/exclude filter, converted to a domain or URL filter when the regex is that simple. */
export function regexFilter(
  regex: string,
  enabled: boolean,
  exclude: boolean,
  profile: string,
  report: ReportBuilder,
): UrlFilter {
  const simple = regexToFilter(regex);
  if (simple) {
    report.info(
      profile,
      `Filter ${regex} became ${simple.description}, so Headerbench asks for access to that site instead of every site.`,
    );
    return { id: newId(), enabled, kind: simple.kind, value: simple.value, exclude };
  }
  return { id: newId(), enabled, kind: 'regex', value: regex, exclude };
}

export interface RawHeader {
  enabled: boolean;
  name: string;
  value: string;
  comment: string;
}

/** Builds a header row, importing function-valued (dynamic) values switched off. */
export function headerRow(
  raw: RawHeader,
  op: HeaderMod['op'],
  profile: string,
  report: ReportBuilder,
): HeaderMod {
  const mod: HeaderMod = {
    id: newId(),
    enabled: raw.enabled,
    name: raw.name,
    value: raw.value,
    op,
    comment: raw.comment,
  };
  if (DYNAMIC_VALUE.test(raw.value)) {
    report.warn(
      profile,
      `${raw.name}: the dynamic function value was imported switched off. Chrome rules can only send fixed values.`,
    );
    return { ...mod, enabled: false, op: 'set' };
  }
  return mod;
}

/** Redirect kind for a source: an exact URL if it is plainly one, otherwise a regex. */
export function redirectFromSource(
  from: string,
  to: string,
  enabled: boolean,
  comment: string,
): RedirectRule {
  const plainUrl = checkExactUrl(from) === null && !/[\\()[\]{}+$]|\.\*/.test(from);
  return { id: newId(), enabled, kind: plainUrl ? 'url' : 'regex', from, to, comment };
}

function itemLabel(kind: string, text: string): string {
  return `${kind} ${text.length > 60 ? `${text.slice(0, 57)}...` : text}`;
}

/**
 * Switches off every enabled item that would not compile, with a report line per item, so an
 * imported profile never carries a broken active rule.
 */
export function finalizeProfile(profile: Profile, report: ReportBuilder): Profile {
  const guard = <T extends { enabled: boolean }>(
    item: T,
    problem: string | null,
    label: string,
  ): T => {
    if (!item.enabled || problem === null) return item;
    report.warn(profile.name, `${label} was imported switched off: ${problem}`);
    return { ...item, enabled: false };
  };
  return {
    ...profile,
    requestHeaders: profile.requestHeaders.map((m) =>
      guard(m, checkHeaderMod(m), itemLabel('Request header', m.name)),
    ),
    responseHeaders: profile.responseHeaders.map((m) =>
      guard(m, checkHeaderMod(m), itemLabel('Response header', m.name)),
    ),
    filters: profile.filters.map((f) => guard(f, checkFilter(f), itemLabel('Filter', f.value))),
    redirects: profile.redirects.map((r) =>
      guard(r, checkRedirect(r), itemLabel('Redirect', r.from)),
    ),
    blocks: profile.blocks.map((b) => guard(b, checkBlock(b), itemLabel('Block', b.pattern))),
    mocks: profile.mocks.map((m) => guard(m, checkMock(m), itemLabel('Mock', m.pattern))),
  };
}

export function hexColor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(v);
  return short ? `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}` : null;
}

/** `appendMode` values that mean "replace the value", which ModHeader writes for its default. */
const SET_MODES: readonly unknown[] = [undefined, null, false, '', 'false'];

/**
 * ModHeader's `appendMode`: `true` (older exports) or `"comma"` mean append; the default values
 * mean set. Any other value is imported as set, with an info line in the report.
 */
export function isAppendMode(value: unknown, profile: string, report: ReportBuilder): boolean {
  if (value === true || value === 'comma') return true;
  if (!SET_MODES.includes(value)) {
    report.infoOnce(
      profile,
      `appendMode ${JSON.stringify(value) ?? String(value)} is not one Headerbench knows, so those headers replace the value instead of appending to it.`,
    );
  }
  return false;
}

export function asString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}
