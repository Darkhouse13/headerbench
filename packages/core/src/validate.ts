/**
 * Field validation shared by the compiler, the importers and the UI.
 * Each `check*` function returns `null` when valid, or a short user-facing reason.
 */

/**
 * Request headers Chrome lets DNR `append` to. Anything else must use `set`.
 * Source: chrome.declarativeNetRequest docs, verified in research/06-pareto.md §1.
 */
export const APPENDABLE_REQUEST_HEADERS: readonly string[] = [
  'accept',
  'accept-encoding',
  'accept-language',
  'access-control-request-headers',
  'cache-control',
  'connection',
  'content-language',
  'cookie',
  'forwarded',
  'if-match',
  'if-none-match',
  'keep-alive',
  'range',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'user-agent',
  'via',
  'want-digest',
  'x-forwarded-for',
];

export function isAppendableRequestHeader(name: string): boolean {
  return APPENDABLE_REQUEST_HEADERS.includes(name.trim().toLowerCase());
}

/**
 * Request headers the browser manages itself. Setting or appending them makes requests fail
 * (Chrome 151: `transfer-encoding` and `expect` break fetches) or behave unpredictably.
 */
export const FRAGILE_REQUEST_HEADERS: readonly string[] = [
  'connection',
  'content-length',
  'expect',
  'host',
  'keep-alive',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

/** The HEADER_BREAKS_REQUESTS message for a request set/append of `name`, or null. */
export function fragileRequestHeaderWarning(name: string): string | null {
  if (!FRAGILE_REQUEST_HEADERS.includes(name.trim().toLowerCase())) return null;
  return `Requests may fail when ${name.trim()} is changed. The browser manages this header itself.`;
}

/** RFC 7230 `token`. */
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export function checkHeaderName(name: string): string | null {
  if (name.length === 0) return 'Header name is empty.';
  if (!TOKEN.test(name)) {
    return `"${name}" is not a valid header name. Use letters, digits and - _ . ! # $ % & ' * + ^ \` | ~ only.`;
  }
  return null;
}

export function checkHeaderValue(value: string): string | null {
  if (/[\r\n\0]/.test(value)) return 'Header values cannot contain line breaks.';
  return null;
}

export const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function checkVariableName(name: string): string | null {
  if (!VARIABLE_NAME.test(name)) {
    return 'Variable names start with a letter or _ and contain only letters, digits and _.';
  }
  return null;
}

/** DNR urlFilter: ASCII only, must not start with `||*`, `|` only at either end. */
export function checkUrlFilter(filter: string): string | null {
  if (filter.length === 0) return 'Pattern is empty.';
  if (!/^[\x20-\x7e]+$/.test(filter)) {
    return 'URL patterns must be plain ASCII. Use the punycode form for international domains.';
  }
  if (filter.startsWith('||*')) return 'A URL pattern cannot start with ||*. Drop the * after ||.';
  const body = filter.replace(/^\|\|?/, '').replace(/\|$/, '');
  if (body.includes('|'))
    return '| is only allowed at the start (| or ||) or the end of a pattern.';
  return null;
}

/**
 * Normalises a user-entered domain for DNR `requestDomains`: trims, lower-cases, drops a
 * leading `*.` or `.`, and converts international names to punycode. Returns `null` if invalid.
 */
export function normalizeDomain(input: string): string | null {
  const trimmed = input
    .trim()
    .toLowerCase()
    .replace(/^\*?\./, '');
  if (trimmed.length === 0 || /[/:@?#*\s]/.test(trimmed)) return null;
  let host: string;
  try {
    host = new URL(`http://${trimmed}/`).hostname;
  } catch {
    return null;
  }
  if (!/^[a-z0-9.-]+$/.test(host)) return null;
  if (host.startsWith('.') || host.endsWith('.') || host.includes('..')) return null;
  return host;
}

export function checkDomain(input: string): string | null {
  return normalizeDomain(input) === null
    ? `"${input}" is not a domain. Enter a host name such as api.example.com, without https:// or a path.`
    : null;
}

/** An absolute http(s) URL, or a `data:` URL. */
export function checkTargetUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:', 'data:'].includes(parsed.protocol)) {
      return 'Redirect targets must be http://, https:// or data: URLs.';
    }
    return null;
  } catch {
    return `"${url}" is not an absolute URL. Include the scheme, e.g. https://localhost:3000/app.js.`;
  }
}

/** For `url` redirects: an absolute http(s) URL with no urlFilter special characters. */
export function checkExactUrl(url: string): string | null {
  const target = checkTargetUrl(url);
  if (target) return target;
  if (url.startsWith('data:'))
    return 'The source of a redirect must be an http:// or https:// URL.';
  if (/[*^|]/.test(url)) {
    return 'Exact URLs cannot contain *, ^ or |. Use a URL pattern redirect instead.';
  }
  return null;
}

const MEDIA_TYPE =
  /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(;[a-z0-9!#$&^_.+-]+=[a-z0-9!#$&^_.+-]+)*$/i;

export function checkContentType(contentType: string): string | null {
  const compact = contentType.replace(/\s+/g, '');
  if (!MEDIA_TYPE.test(compact)) {
    return `"${contentType}" is not a valid content type. Example: application/json.`;
  }
  return null;
}

export function checkColor(color: string): string | null {
  return /^#[0-9a-f]{6}$/i.test(color) ? null : 'Colours use the #rrggbb form.';
}
