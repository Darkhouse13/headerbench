/**
 * A matcher for DNR `urlFilter` syntax, used by the URL tester and loop checks.
 *
 * - `||` at the start anchors to the start of the host or of any of its subdomain labels.
 * - `|` at the start anchors to the start of the URL; `|` at the end anchors to the end.
 * - `*` matches any run of characters.
 * - `^` matches one separator (anything except a letter, digit, `_`, `-`, `.` or `%`)
 *   or the end of the URL.
 * - Matching is case-insensitive unless `caseSensitive` is set (DNR's default since Chrome 118).
 */

const SCHEME_AND_USERINFO = '^[a-z][a-z0-9+.-]*:\\/\\/(?:[^/?#@]*@)?';

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

export function urlFilterToRegExp(filter: string, caseSensitive = false): RegExp {
  let rest = filter;
  let prefix = '';
  if (rest.startsWith('||')) {
    prefix = `${SCHEME_AND_USERINFO}(?:[^/?#]*\\.)?`;
    rest = rest.slice(2);
  } else if (rest.startsWith('|')) {
    prefix = '^';
    rest = rest.slice(1);
  }
  let suffix = '';
  if (rest.endsWith('|')) {
    suffix = '$';
    rest = rest.slice(0, -1);
  }
  let body = '';
  for (const ch of rest) {
    if (ch === '*') body += '.*';
    else if (ch === '^') body += '(?:[^a-z0-9_.%-]|$)';
    else body += escapeRegex(ch);
  }
  return new RegExp(prefix + body + suffix, caseSensitive ? '' : 'i');
}

/** Canonicalises like Chrome before matching (lower-case scheme and host, punycode, default ports). */
export function canonicalUrl(url: string): string | null {
  try {
    return new URL(url).href;
  } catch {
    return null;
  }
}

export function matchesUrlFilter(filter: string, url: string, caseSensitive = false): boolean {
  const canonical = canonicalUrl(url);
  if (canonical === null) return false;
  return urlFilterToRegExp(filter, caseSensitive).test(canonical);
}

/** DNR `requestDomains` semantics: the host equals the domain or is a subdomain of it. */
export function hostMatchesDomain(host: string, domain: string): boolean {
  const h = host.toLowerCase();
  const d = domain.toLowerCase();
  return h === d || h.endsWith(`.${d}`);
}
