import { checkBlock, checkFilter, checkHeaderMod, checkMock, checkRedirect } from '../items.js';
import type { HeaderMod, Profile, RedirectRule, UrlFilter } from '../model.js';
import { newId } from '../model.js';
import { checkExactUrl, normalizeDomain } from '../validate.js';
import type { ReportBuilder } from './report.js';

export const DYNAMIC_VALUE = /^\s*(async\s+)?function\s*\(/;

/**
 * Turns a simple ModHeader host regex such as `.*://api\.example\.com/.*` into a domain filter,
 * so the profile only needs access to that site instead of all sites. Returns null if the regex
 * is anything more than "this host, any path".
 */
export function regexToDomain(regex: string): string | null {
  let rest = regex.replace(/^\^/, '').replace(/\$$/, '');
  const scheme =
    /^(?:\.\*|https\?|https|http|\(https\?\)|\(https\|http\)|\(http\|https\))?(?::\\\/\\\/|:\/\/)/.exec(
      rest,
    );
  if (!scheme) return null;
  rest = rest.slice(scheme[0].length);
  rest = rest.replace(/^(?:\.\*\\\.|\(\.\*\\\.\)\?)/, '');
  const host = /^[a-z0-9-]+(?:(?:\\\.|\.)[a-z0-9-]+)*/i.exec(rest);
  if (!host) return null;
  const tail = rest.slice(host[0].length);
  if (!/^(?::\d+)?(?:\\?\/\.\*|\\?\/|\.\*)?$/.test(tail)) return null;
  return normalizeDomain(host[0].replace(/\\\./g, '.'));
}

/** A regex include/exclude filter, converted to a domain filter when the regex is that simple. */
export function regexFilter(
  regex: string,
  enabled: boolean,
  exclude: boolean,
  profile: string,
  report: ReportBuilder,
): UrlFilter {
  const domain = regexToDomain(regex);
  if (domain) {
    report.info(
      profile,
      `Filter ${regex} became the domain filter ${domain} (it also covers subdomains), so Headerbench asks for access to that site instead of every site.`,
    );
    return { id: newId(), enabled, kind: 'domain', value: domain, exclude };
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

/** ModHeader's `appendMode`: `true` (older exports) or `"comma"` mean append; anything else sets. */
export function isAppendMode(value: unknown): boolean {
  return value === true || value === 'comma';
}

export function asString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}
