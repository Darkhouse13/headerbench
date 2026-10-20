import { describe, expect, it } from 'vitest';
import { canonicalUrl, hostMatchesDomain, matchesUrlFilter } from '../src/index.js';

/** Cases from the chrome.declarativeNetRequest docs, "URL filter syntax". */
const DOCS_CASES: [string, string[], string[]][] = [
  ['abc', ['https://abcd.com', 'https://example.com/abcd'], ['https://ab.com']],
  ['abc*d', ['https://abcd.com', 'https://example.com/abcxyzd'], ['https://abc.com']],
  [
    '||a.example.com',
    ['https://a.example.com/', 'https://b.a.example.com/xyz', 'https://a.example.company'],
    ['https://example.com/'],
  ],
  ['|https*', ['https://example.com'], ['http://example.com/', 'http://https.com']],
  [
    'example*^123|',
    ['https://example.com/123', 'http://abc.com/example?123'],
    ['https://example.com/1234', 'https://abc.com/example0123'],
  ],
];

describe('matchesUrlFilter', () => {
  for (const [filter, yes, no] of DOCS_CASES) {
    it(`"${filter}" matches the documented URLs`, () => {
      for (const url of yes) expect(matchesUrlFilter(filter, url), url).toBe(true);
      for (const url of no) expect(matchesUrlFilter(filter, url), url).toBe(false);
    });
  }

  it('treats ^ as a separator or the end of the URL', () => {
    expect(matchesUrlFilter('||api.example.com^', 'https://api.example.com')).toBe(true);
    expect(matchesUrlFilter('||api.example.com^', 'https://api.example.com:8443/x')).toBe(true);
    expect(matchesUrlFilter('||api.example.com^', 'https://api.example.com.evil.net/')).toBe(false);
    expect(matchesUrlFilter('||example.com', 'https://notexample.com/')).toBe(false);
  });

  it('is case-insensitive by default and case-sensitive on request', () => {
    expect(matchesUrlFilter('/API/', 'https://x.test/api/users')).toBe(true);
    expect(matchesUrlFilter('/API/', 'https://x.test/api/users', true)).toBe(false);
  });

  it('escapes regex characters and anchors both ends', () => {
    expect(matchesUrlFilter('|https://x.test/a.js?v=1|', 'https://x.test/a.js?v=1')).toBe(true);
    expect(matchesUrlFilter('|https://x.test/a.js?v=1|', 'https://x.test/aXjs?v=1')).toBe(false);
    expect(matchesUrlFilter('|https://x.test/a.js|', 'https://x.test/a.js?v=1')).toBe(false);
  });

  it('skips user info when anchoring to a domain, and rejects invalid URLs', () => {
    expect(matchesUrlFilter('||x.test^', 'https://user:pw@x.test/')).toBe(true);
    expect(matchesUrlFilter('abc', 'not a url')).toBe(false);
  });
});

describe('canonicalUrl and hostMatchesDomain', () => {
  it('canonicalises like Chrome', () => {
    expect(canonicalUrl('HTTPS://Example.COM:443/a')).toBe('https://example.com/a');
    expect(canonicalUrl('nope')).toBeNull();
  });

  it('matches a domain and its subdomains only', () => {
    expect(hostMatchesDomain('api.example.com', 'example.com')).toBe(true);
    expect(hostMatchesDomain('example.com', 'example.com')).toBe(true);
    expect(hostMatchesDomain('badexample.com', 'example.com')).toBe(false);
  });
});
