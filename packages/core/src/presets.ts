/** Autocomplete names and value presets for the header editor. */
import type { HeaderOp } from './model.js';

export const REQUEST_HEADER_NAMES: readonly string[] = [
  'Accept',
  'Accept-Encoding',
  'Accept-Language',
  'Authorization',
  'Cache-Control',
  'Content-Type',
  'Cookie',
  'DNT',
  'Forwarded',
  'Host',
  'If-Match',
  'If-Modified-Since',
  'If-None-Match',
  'Origin',
  'Pragma',
  'Range',
  'Referer',
  'Sec-Fetch-Dest',
  'Sec-Fetch-Mode',
  'Sec-Fetch-Site',
  'Sec-GPC',
  'User-Agent',
  'X-Api-Key',
  'X-Correlation-Id',
  'X-CSRF-Token',
  'X-Debug',
  'X-Feature-Flag',
  'X-Forwarded-For',
  'X-Forwarded-Host',
  'X-Forwarded-Proto',
  'X-Real-IP',
  'X-Request-Id',
  'X-Requested-With',
  'traceparent',
];

export const RESPONSE_HEADER_NAMES: readonly string[] = [
  'Access-Control-Allow-Credentials',
  'Access-Control-Allow-Headers',
  'Access-Control-Allow-Methods',
  'Access-Control-Allow-Origin',
  'Access-Control-Expose-Headers',
  'Access-Control-Max-Age',
  'Cache-Control',
  'Content-Disposition',
  'Content-Security-Policy',
  'Content-Security-Policy-Report-Only',
  'Content-Type',
  'Cross-Origin-Embedder-Policy',
  'Cross-Origin-Opener-Policy',
  'Cross-Origin-Resource-Policy',
  'ETag',
  'Expires',
  'Location',
  'Permissions-Policy',
  'Referrer-Policy',
  'Set-Cookie',
  'Strict-Transport-Security',
  'Timing-Allow-Origin',
  'Vary',
  'X-Content-Type-Options',
  'X-Frame-Options',
  'X-Robots-Tag',
];

export interface ValuePreset {
  id: string;
  label: string;
  value: string;
}

/**
 * Current stable releases as of 2026-10-12: Chrome 156 (chromiumdash), Firefox 157
 * (product-details.mozilla.org). Safari strings follow Safari 26's format, where iOS reports a
 * frozen OS version. Chrome-family strings use the reduced form Chrome itself sends.
 */
export const USER_AGENT_PRESETS: readonly ValuePreset[] = [
  {
    id: 'chrome-windows',
    label: 'Chrome 156 on Windows',
    value:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',
  },
  {
    id: 'chrome-mac',
    label: 'Chrome 156 on macOS',
    value:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',
  },
  {
    id: 'edge-windows',
    label: 'Edge 156 on Windows',
    value:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0',
  },
  {
    id: 'firefox-windows',
    label: 'Firefox 157 on Windows',
    value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:157.0) Gecko/20100101 Firefox/157.0',
  },
  {
    id: 'firefox-mac',
    label: 'Firefox 157 on macOS',
    value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:157.0) Gecko/20100101 Firefox/157.0',
  },
  {
    id: 'safari-mac',
    label: 'Safari 26 on macOS',
    value:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
  },
  {
    id: 'safari-iphone',
    label: 'Safari 26 on iPhone',
    value:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
  },
  {
    id: 'chrome-android',
    label: 'Chrome 156 on Android',
    value:
      'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36',
  },
  {
    id: 'googlebot',
    label: 'Googlebot (smartphone)',
    value:
      'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  },
];

/** Value presets keyed by lower-case header name. */
export const VALUE_PRESETS: Readonly<Record<string, readonly ValuePreset[]>> = {
  'user-agent': USER_AGENT_PRESETS,
  authorization: [
    { id: 'bearer', label: 'Bearer token', value: 'Bearer ' },
    { id: 'basic', label: 'Basic auth (base64 user:password)', value: 'Basic ' },
  ],
  'cache-control': [
    { id: 'no-cache', label: 'no-cache', value: 'no-cache' },
    { id: 'no-store', label: 'no-store', value: 'no-store' },
  ],
  pragma: [{ id: 'no-cache', label: 'no-cache', value: 'no-cache' }],
  'accept-language': [
    { id: 'en-us', label: 'English (US)', value: 'en-US,en;q=0.9' },
    { id: 'en-gb', label: 'English (UK)', value: 'en-GB,en;q=0.9' },
    { id: 'fr', label: 'French', value: 'fr-FR,fr;q=0.9,en;q=0.8' },
    { id: 'de', label: 'German', value: 'de-DE,de;q=0.9,en;q=0.8' },
    { id: 'es', label: 'Spanish', value: 'es-ES,es;q=0.9,en;q=0.8' },
    { id: 'ja', label: 'Japanese', value: 'ja-JP,ja;q=0.9,en;q=0.8' },
    { id: 'pt-br', label: 'Portuguese (Brazil)', value: 'pt-BR,pt;q=0.9,en;q=0.8' },
  ],
  'content-type': [
    { id: 'json', label: 'JSON', value: 'application/json' },
    { id: 'form', label: 'Form', value: 'application/x-www-form-urlencoded' },
  ],
};

export function valuePresetsFor(headerName: string): readonly ValuePreset[] {
  return VALUE_PRESETS[headerName.trim().toLowerCase()] ?? [];
}

export interface HeaderPresetRow {
  name: string;
  op: HeaderOp;
  value: string;
  /** Shown next to the row so the user knows what it does and its limits. */
  note: string;
}

export interface HeaderPreset {
  id: string;
  label: string;
  direction: 'request' | 'response';
  rows: readonly HeaderPresetRow[];
}

export const CORS_PRESET: HeaderPreset = {
  id: 'cors',
  label: 'Allow CORS',
  direction: 'response',
  rows: [
    {
      name: 'Access-Control-Allow-Origin',
      op: 'set',
      value: '*',
      note: 'Any origin may read the response. Browsers ignore * when the request sends cookies; put your app origin here instead (e.g. http://localhost:3000).',
    },
    {
      name: 'Access-Control-Allow-Methods',
      op: 'set',
      value: 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      note: 'Methods allowed in preflight responses.',
    },
    {
      name: 'Access-Control-Allow-Headers',
      op: 'set',
      value: '*',
      note: 'Request headers allowed in preflight responses. * does not cover Authorization; list it explicitly if you send it.',
    },
    {
      name: 'Access-Control-Allow-Credentials',
      op: 'set',
      value: 'true',
      note: 'Only valid with a specific origin above, not *. Switch this row off if you keep *.',
    },
  ],
};

export const REMOVE_CSP_PRESET: HeaderPreset = {
  id: 'remove-csp',
  label: 'Remove Content Security Policy',
  direction: 'response',
  rows: [
    {
      name: 'Content-Security-Policy',
      op: 'remove',
      value: '',
      note: 'Removes the CSP header. A CSP set in a <meta> tag in the page still applies.',
    },
    {
      name: 'Content-Security-Policy-Report-Only',
      op: 'remove',
      value: '',
      note: 'Stops report-only CSP violation reports.',
    },
  ],
};

export const HEADER_PRESETS: readonly HeaderPreset[] = [CORS_PRESET, REMOVE_CSP_PRESET];
