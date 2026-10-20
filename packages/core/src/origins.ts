/**
 * Host-permission patterns a profile needs. DNR `modifyHeaders` and `redirect` silently do
 * nothing without host access; `block` works without it, so blocks need no origin.
 */
import type { FilterKind, Profile } from './model.js';
import { normalizeDomain } from './validate.js';

export const ALL_ORIGINS: readonly string[] = ['https://*/*', 'http://*/*'];

// Explicit http and https patterns, never a `*` scheme. Chrome grants a requested pattern only
// when a single manifest entry contains it, and neither the https nor the http entry of
// ALL_ORIGINS contains a `*` scheme pattern. So such a request fails with "Only permissions
// specified in the manifest may be requested", and a check for it stays false even after the
// user grants all sites.
function schemeOrigins(scheme: string, host: string): string[] {
  return scheme === '*' ? [`https://${host}/*`, `http://${host}/*`] : [`${scheme}://${host}/*`];
}

function domainOrigins(domain: string): string[] {
  return [...schemeOrigins('*', domain), ...schemeOrigins('*', `*.${domain}`)];
}

/** Origins for an absolute URL prefix such as `https://api.example.com/v1`. */
function urlPrefixOrigins(text: string): string[] | null {
  const match = /^(https?|\*):\/\/([^/:?#*^|]+)(?=[/:?#^|]|$)/i.exec(text);
  if (!match) return null;
  const host = normalizeDomain(match[2] as string);
  if (!host) return null;
  return schemeOrigins((match[1] as string).toLowerCase(), host);
}

/** `||host^…` → host and subdomains; `|https://host/…` or `https://host/…` → that origin; else null (= all). */
export function urlFilterOrigins(filter: string): string[] | null {
  if (filter.startsWith('||')) {
    const match = /^\|\|([^/:?#*^|]+)(?=[/:?#^|]|$)/.exec(filter);
    const host = match ? normalizeDomain(match[1] as string) : null;
    return host ? domainOrigins(host) : null;
  }
  return urlPrefixOrigins(filter.startsWith('|') ? filter.slice(1) : filter);
}

function patternOrigins(kind: FilterKind | 'url', value: string): string[] | null {
  switch (kind) {
    case 'domain': {
      const host = normalizeDomain(value);
      return host ? domainOrigins(host) : null;
    }
    case 'url':
      return urlPrefixOrigins(value);
    case 'urlFilter':
      return urlFilterOrigins(value);
    case 'regex':
      return null;
  }
}

export function originsFor(profile: Profile): string[] {
  const origins = new Set<string>();
  let all = false;
  const addPattern = (kind: FilterKind | 'url', value: string): void => {
    const found = patternOrigins(kind, value);
    if (found === null) all = true;
    else found.forEach((o) => origins.add(o));
  };

  const hasHeaders = [...profile.requestHeaders, ...profile.responseHeaders].some((m) => m.enabled);
  if (hasHeaders) {
    const includes = profile.filters.filter((f) => f.enabled && !f.exclude);
    if (includes.length === 0) all = true;
    for (const filter of includes) addPattern(filter.kind, filter.value);
  }
  for (const redirect of profile.redirects) {
    if (redirect.enabled) addPattern(redirect.kind, redirect.from);
  }
  for (const mock of profile.mocks) {
    if (mock.enabled) addPattern(mock.kind, mock.pattern);
  }
  return all ? [...ALL_ORIGINS] : [...origins].sort();
}

/**
 * The host-permission pattern for the page a request comes from (its initiator), e.g.
 * `http://localhost/*` for `http://localhost:5173/app`. Chrome applies `modifyHeaders` and
 * `redirect` only when Headerbench has access to both the request URL and its initiator.
 * Null for anything but http(s).
 */
export function pageOrigin(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return `${parsed.protocol}//${parsed.hostname}/*`;
}

/**
 * Whether a host-permission match pattern (`<scheme>://<host>/<path>`, `*` scheme = http and
 * https, `*.` host prefix = domain and subdomains, `<all_urls>`) grants access to `url`.
 * Ports and paths are ignored, as Chrome does for host permissions with `/*` paths.
 */
export function patternGrants(pattern: string, url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const scheme = parsed.protocol.slice(0, -1);
  if (scheme !== 'http' && scheme !== 'https') return false;
  if (pattern === '<all_urls>') return true;
  const match = /^(\*|https?):\/\/([^/]+)\//.exec(pattern);
  if (!match) return false;
  if (match[1] !== '*' && match[1] !== scheme) return false;
  const host = (match[2] as string).toLowerCase();
  const target = parsed.hostname.toLowerCase();
  if (host === '*') return true;
  if (host.startsWith('*.')) {
    const domain = host.slice(2);
    return target === domain || target.endsWith(`.${domain}`);
  }
  return target === host;
}

/** A host-access check for `testUrl`, from the origins Chrome has granted. */
export function hostAccessFrom(granted: readonly string[]): (url: string) => boolean {
  return (url) => granted.some((pattern) => patternGrants(pattern, url));
}
