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

/** An IPv4 or bracketed IPv6 literal: it has no subdomains. */
function isIpLiteral(host: string): boolean {
  return host.startsWith('[') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
}

/** A host and, unless it is an IP literal, its subdomains. */
function domainOrigins(host: string): string[] {
  const own = schemeOrigins('*', host);
  return isIpLiteral(host) ? own : [...own, ...schemeOrigins('*', `*.${host}`)];
}

/** A host as written after `scheme://` or `||`: `[IPv6]`, `*`, `*.domain`, a domain or IPv4. */
const HOST = String.raw`(\[[0-9a-f:.]+\]|\*(?:\.[^/:?#*^|]+)?|[^/:?#*^|\[]+)(?=[/:?#^|]|$)`;

/** The host-permission form of a parsed host, or null if it is not a valid host. */
function hostPattern(raw: string): string | null {
  if (raw === '*') return '*';
  if (raw.startsWith('*.')) {
    const domain = normalizeDomain(raw.slice(2));
    return domain ? `*.${domain}` : null;
  }
  if (raw.startsWith('[')) {
    try {
      return new URL(`http://${raw}/`).hostname;
    } catch {
      return null;
    }
  }
  return normalizeDomain(raw);
}

/** Origins for an absolute URL prefix such as `https://api.example.com:8443/v1` or `https://*.example.com/`. */
function urlPrefixOrigins(text: string): string[] | null {
  const match = new RegExp(`^(https?|\\*)://${HOST}`, 'i').exec(text);
  if (!match) return null;
  const host = hostPattern(match[2] as string);
  if (!host) return null;
  return schemeOrigins((match[1] as string).toLowerCase(), host);
}

/**
 * `||host^…` or `||host:3000/` → host and subdomains; `|https://host:port/…` or
 * `https://host/…` → that scheme and host (any port); else null (= all).
 */
export function urlFilterOrigins(filter: string): string[] | null {
  if (filter.startsWith('||')) {
    const match = new RegExp(`^\\|\\|${HOST}`, 'i').exec(filter);
    const raw = match?.[1];
    if (raw === undefined || raw.startsWith('*')) return null;
    const host = hostPattern(raw);
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
 * Whether a host-permission match pattern (`<scheme>://<host>[:<port>]/<path>`, `*` scheme = http
 * and https, `*.` host prefix = domain and subdomains, `[IPv6]` hosts, `<all_urls>`) grants
 * access to `url`. A pattern without a port (or with `:*`) covers every port; paths are ignored,
 * as Chrome does for host permissions.
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
  const match = /^(\*|https?):\/\/(\[[^\]/]*\]|[^/:]*)(?::(\d+|\*))?\//.exec(pattern);
  if (!match) return false;
  if (match[1] !== '*' && match[1] !== scheme) return false;
  const port = match[3];
  if (port !== undefined && port !== '*') {
    const effective = parsed.port || (scheme === 'https' ? '443' : '80');
    if (Number(port) !== Number(effective)) return false;
  }
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
