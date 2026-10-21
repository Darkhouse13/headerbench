import { beforeEach, describe, expect, it } from 'vitest';
import {
  ALL_ORIGINS,
  hostAccessFrom,
  originsFor,
  pageOrigin,
  patternGrants,
  urlFilterOrigins,
} from '../src/index.js';
import { block, filter, header, mock, profile, redirect, resetIds } from './helpers.js';

beforeEach(resetIds);

const withHeaders = (filters: ReturnType<typeof filter>[]) =>
  profile('P', { requestHeaders: [header('X-A', '1')], filters });

describe('originsFor', () => {
  it('maps a domain filter to the host and its subdomains', () => {
    expect(originsFor(withHeaders([filter('domain', 'API.example.com')]))).toEqual([
      'http://*.api.example.com/*',
      'http://api.example.com/*',
      'https://*.api.example.com/*',
      'https://api.example.com/*',
    ]);
  });

  it('parses ||host^ and scheme://host url filters', () => {
    expect(
      originsFor(
        withHeaders([
          filter('urlFilter', '||cdn.example.com^'),
          filter('urlFilter', '|https://app.example.com:8443/x'),
        ]),
      ),
    ).toEqual([
      'http://*.cdn.example.com/*',
      'http://cdn.example.com/*',
      'https://*.cdn.example.com/*',
      'https://app.example.com/*',
      'https://cdn.example.com/*',
    ]);
  });

  it('needs all sites for regexes, loose url filters and profiles without includes', () => {
    expect(originsFor(withHeaders([filter('regex', '^https://x\\.test/')]))).toEqual([
      ...ALL_ORIGINS,
    ]);
    expect(originsFor(withHeaders([filter('urlFilter', '/api/')]))).toEqual([...ALL_ORIGINS]);
    expect(originsFor(withHeaders([]))).toEqual([...ALL_ORIGINS]);
    expect(originsFor(withHeaders([filter('domain', 'x.test', true)]))).toEqual([...ALL_ORIGINS]);
  });

  it('ignores disabled filters and header filters when there are no enabled headers', () => {
    const p = profile('P', {
      requestHeaders: [header('X-A', '1', 'set', { enabled: false })],
      filters: [filter('regex', '.*')],
      redirects: [
        redirect('url', 'https://cdn.test/app.js', 'http://localhost:3000/app.js'),
        redirect('regex', '.*', 'x', { enabled: false }),
      ],
      mocks: [mock('urlFilter', '||api.test/me', '{}')],
      blocks: [block('regex', '.*')],
    });
    expect(originsFor(p)).toEqual([
      'http://*.api.test/*',
      'http://api.test/*',
      'https://*.api.test/*',
      'https://api.test/*',
      'https://cdn.test/*',
    ]);
  });

  it('counts regex redirect sources as all sites', () => {
    const p = profile('P', {
      redirects: [redirect('regex', '^https://prod\\.test/(.*)', 'http://localhost/$1')],
    });
    expect(originsFor(p)).toEqual([...ALL_ORIGINS]);
  });

  it('returns nothing for a block-only profile', () => {
    expect(originsFor(profile('P', { blocks: [block('urlFilter', '||ads.test^')] }))).toEqual([]);
  });
});

describe('urlFilterOrigins', () => {
  it('handles edge cases', () => {
    expect(urlFilterOrigins('||x.test')).toEqual([
      'https://x.test/*',
      'http://x.test/*',
      'https://*.x.test/*',
      'http://*.x.test/*',
    ]);
    expect(urlFilterOrigins('||*.x.test')).toBeNull();
    expect(urlFilterOrigins('https://x.test')).toEqual(['https://x.test/*']);
    expect(urlFilterOrigins('*://x.test/')).toEqual(['https://x.test/*', 'http://x.test/*']);
    expect(urlFilterOrigins('ftp://x.test/')).toBeNull();
  });
});

describe('pageOrigin', () => {
  it('gives the host pattern of an http(s) page, for every port and path', () => {
    expect(pageOrigin('http://localhost:5173/app?x=1')).toBe('http://localhost/*');
    expect(pageOrigin('https://App.Example.com/')).toBe('https://app.example.com/*');
  });

  it('is null for other schemes and junk', () => {
    expect(pageOrigin('chrome://extensions/')).toBeNull();
    expect(pageOrigin('file:///tmp/a.html')).toBeNull();
    expect(pageOrigin('not a url')).toBeNull();
  });
});

describe('patternGrants / hostAccessFrom', () => {
  it('matches Chrome host-permission patterns', () => {
    expect(patternGrants('http://127.0.0.1/*', 'http://127.0.0.1:8080/x')).toBe(true);
    expect(patternGrants('http://127.0.0.1/*', 'http://localhost:8080/x')).toBe(false);
    expect(patternGrants('https://*/*', 'https://a.test/')).toBe(true);
    expect(patternGrants('https://*/*', 'http://a.test/')).toBe(false);
    expect(patternGrants('*://*.example.com/*', 'https://example.com/')).toBe(true);
    expect(patternGrants('*://*.example.com/*', 'http://api.example.com/')).toBe(true);
    expect(patternGrants('*://*.example.com/*', 'https://badexample.com/')).toBe(false);
    expect(patternGrants('<all_urls>', 'https://a.test/')).toBe(true);
    expect(patternGrants('<all_urls>', 'chrome://newtab/')).toBe(false);
  });

  it('checks a URL against every granted pattern', () => {
    const granted = hostAccessFrom(['http://127.0.0.1/*', '*://*.example.com/*']);
    expect(granted('http://127.0.0.1:3000/')).toBe(true);
    expect(granted('https://api.example.com/v1')).toBe(true);
    expect(granted('http://localhost:3000/')).toBe(false);
  });
});

describe('IPv6, wildcard and port-qualified hosts', () => {
  it('parses IPv6 literals instead of asking for every site', () => {
    expect(urlFilterOrigins('|http://[::1]:3000/api')).toEqual(['http://[::1]/*']);
    expect(urlFilterOrigins('*://[::1]/')).toEqual(['https://[::1]/*', 'http://[::1]/*']);
    expect(urlFilterOrigins('||[::1]:8080/')).toEqual(['https://[::1]/*', 'http://[::1]/*']);
    expect(urlFilterOrigins('|http://[0:0:0:0:0:0:0:1]/')).toEqual(['http://[::1]/*']);
    expect(urlFilterOrigins('|http://[nope]/')).toBeNull();
  });

  it('parses wildcard hosts', () => {
    expect(urlFilterOrigins('|https://*.Example.com/api/')).toEqual(['https://*.example.com/*']);
    expect(urlFilterOrigins('*://*.example.com/')).toEqual([
      'https://*.example.com/*',
      'http://*.example.com/*',
    ]);
    expect(urlFilterOrigins('https://*/x')).toEqual(['https://*/*']);
    expect(urlFilterOrigins('https://*example.com/')).toBeNull();
  });

  it('gives IP literals no subdomain pattern', () => {
    expect(originsFor(withHeaders([filter('domain', '127.0.0.1')]))).toEqual([
      'http://127.0.0.1/*',
      'https://127.0.0.1/*',
    ]);
    expect(urlFilterOrigins('||127.0.0.1:5173/')).toEqual([
      'https://127.0.0.1/*',
      'http://127.0.0.1/*',
    ]);
  });

  it('asks for the narrow host of port-qualified url filters', () => {
    expect(urlFilterOrigins('||localhost:3000/')).toEqual([
      'https://localhost/*',
      'http://localhost/*',
      'https://*.localhost/*',
      'http://*.localhost/*',
    ]);
    expect(urlFilterOrigins('|https://api.example.com:8443/')).toEqual([
      'https://api.example.com/*',
    ]);
  });

  it('gives the page origin of an IPv6 page', () => {
    expect(pageOrigin('http://[::1]:5173/app')).toBe('http://[::1]/*');
  });

  it('honours ports and IPv6 hosts in granted patterns', () => {
    expect(patternGrants('http://localhost:3000/*', 'http://localhost:3000/x')).toBe(true);
    expect(patternGrants('http://localhost:3000/*', 'http://localhost:3001/x')).toBe(false);
    expect(patternGrants('http://localhost:3000/*', 'http://localhost/x')).toBe(false);
    expect(patternGrants('http://localhost:80/*', 'http://localhost/x')).toBe(true);
    expect(patternGrants('https://example.com:443/*', 'https://example.com/')).toBe(true);
    expect(patternGrants('http://localhost:*/*', 'http://localhost:9999/')).toBe(true);
    expect(patternGrants('http://localhost/*', 'http://localhost:9999/')).toBe(true);
    expect(patternGrants('http://[::1]/*', 'http://[::1]:3000/')).toBe(true);
    expect(patternGrants('http://[::1]:3000/*', 'http://[::1]:3000/')).toBe(true);
    expect(patternGrants('http://[::1]:3000/*', 'http://[::1]:4000/')).toBe(false);
    expect(patternGrants('http://[::1]/*', 'http://127.0.0.1/')).toBe(false);
    expect(hostAccessFrom(['http://localhost:5173/*'])('http://localhost:5173/app')).toBe(true);
  });
});

/**
 * Chrome's containment rule for permissions.request: a requested pattern is granted only if one
 * manifest entry contains it (same or `*` scheme, host equal or covered by `*` / `*.domain`).
 */
function contains(entry: string, requested: string): boolean {
  const parse = (p: string) => /^(\*|https?):\/\/([^/]+)\/(.*)$/.exec(p);
  const e = parse(entry);
  const r = parse(requested);
  if (!e || !r) return false;
  if (e[1] !== '*' && e[1] !== r[1]) return false;
  if (e[1] !== '*' && r[1] === '*') return false;
  const eh = e[2] as string;
  const rh = r[2] as string;
  if (eh === '*') return true;
  if (eh.startsWith('*.')) return rh === eh || rh.endsWith(eh.slice(1)) || rh === eh.slice(2);
  return eh === rh;
}

describe('manifest compatibility', () => {
  it('only asks for patterns a single optional_host_permissions entry contains', () => {
    const p = withHeaders([
      filter('domain', 'example.com'),
      filter('domain', '127.0.0.1'),
      filter('urlFilter', '|http://[::1]:3000/'),
      filter('urlFilter', '*://*.example.org/'),
      filter('urlFilter', '||localhost:3000/'),
      filter('urlFilter', '|https://api.example.net:8443/'),
    ]);
    const origins = originsFor(p);
    expect(origins).not.toEqual([...ALL_ORIGINS]);
    for (const o of origins) {
      expect(
        ALL_ORIGINS.some((entry) => contains(entry, o)),
        o,
      ).toBe(true);
    }
  });

  // Chrome grants a requested pattern only if one optional_host_permissions entry contains it.
  it('never asks for a *:// pattern, which no single https:// or http:// entry contains', () => {
    const p = withHeaders([filter('domain', 'httpbin.org'), filter('urlFilter', '*://x.test/v1')]);
    for (const o of originsFor(p)) expect(o).toMatch(/^https?:\/\//);
  });
});
