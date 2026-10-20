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

describe('manifest compatibility', () => {
  // Chrome grants a requested pattern only if one optional_host_permissions entry contains it.
  it('never asks for a *:// pattern, which no single https:// or http:// entry contains', () => {
    const p = withHeaders([filter('domain', 'httpbin.org'), filter('urlFilter', '*://x.test/v1')]);
    for (const o of originsFor(p)) expect(o).toMatch(/^https?:\/\//);
  });
});
