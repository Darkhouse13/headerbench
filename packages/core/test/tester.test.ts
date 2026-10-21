import { beforeEach, describe, expect, it } from 'vitest';
import {
  MOCK_CSP_NOTE,
  REGEX_PREVIEW_NOTE,
  hostAccessFrom,
  needsInitiatorAccess,
  testUrl,
} from '../src/index.js';
import type { Match, TestRequest } from '../src/index.js';
import {
  FREE,
  PRO,
  block,
  filter,
  header,
  mock,
  profile,
  redirect,
  resetIds,
  stateWith,
} from './helpers.js';

beforeEach(resetIds);

const xhr = (url: string, extra: Partial<TestRequest> = {}): TestRequest => ({
  url,
  resourceType: 'xmlhttprequest',
  method: 'get',
  ...extra,
});
const summary = (matches: Match[]): string[] =>
  matches.map((m) => {
    const e = m.effect;
    const what =
      e.type === 'header'
        ? `${e.direction} ${e.header} ${e.operation}${e.value !== undefined ? `=${e.value}` : ''}`
        : e.type === 'redirect'
          ? `redirect ${e.to}`
          : e.type === 'mock'
            ? `mock ${e.contentType} ${e.bytes}B`
            : e.type;
    return `${m.profileName}: ${what} ${m.applied ? 'applied' : `NOT (${m.reason})`}`;
  });

describe('testUrl', () => {
  it('reports header ops for a matching domain and nothing for others', () => {
    const state = stateWith([
      profile('Staging', {
        requestHeaders: [header('X-Api-Key', 'k')],
        responseHeaders: [header('X-Frame-Options', '', 'remove')],
        filters: [filter('domain', 'api.example.com')],
      }),
    ]);
    expect(summary(testUrl(state, FREE, xhr('https://v2.api.example.com/users')))).toEqual([
      'Staging: request X-Api-Key set=k applied',
      'Staging: response X-Frame-Options remove applied',
    ]);
    const m = testUrl(state, FREE, xhr('https://v2.api.example.com/users'))[0]!;
    expect(m).toMatchObject({
      profileId: 'p-staging',
      list: 'dynamic',
      ruleId: 1,
      kind: 'headers',
      itemId: 'h1',
      warnings: [],
    });
    expect(testUrl(state, FREE, xhr('https://example.com/'))).toEqual([]);
  });

  it('respects resource types and methods', () => {
    const state = stateWith([
      profile('P', {
        requestHeaders: [header('X-A', '1')],
        resourceTypes: ['xmlhttprequest'],
        methods: ['post'],
      }),
    ]);
    expect(testUrl(state, FREE, xhr('https://x.test/', { method: 'post' }))).toHaveLength(1);
    expect(testUrl(state, FREE, xhr('https://x.test/'))).toEqual([]);
    expect(
      testUrl(state, FREE, { url: 'https://x.test/', resourceType: 'image', method: 'post' }),
    ).toEqual([]);
  });

  it('lets the higher-priority profile win a conflicting set', () => {
    const a = profile('A', {
      requestHeaders: [header('X-Env', 'a'), header('Accept-Language', 'fr', 'append')],
    });
    const b = profile('B', {
      requestHeaders: [header('x-env', 'b'), header('Accept-Language', 'de', 'append')],
    });
    const state = stateWith([a, b]);
    expect(summary(testUrl(state, FREE, xhr('https://x.test/')))).toEqual([
      'A: request X-Env set=a applied',
      'A: request Accept-Language append=fr applied',
      'B: request x-env set=b NOT (Overridden by "A", which has higher priority.)',
      'B: request Accept-Language append=de applied',
    ]);
    state.settings.activations.reverse();
    expect(summary(testUrl(state, FREE, xhr('https://x.test/')))[0]).toBe(
      'B: request x-env set=b applied',
    );
  });

  it('applies the documented header conflict rules for remove and append', () => {
    const a = profile('A', {
      requestHeaders: [header('Cookie', '', 'remove')],
      responseHeaders: [header('X-R', '1', 'append')],
    });
    const b = profile('B', {
      requestHeaders: [header('Cookie', 'x=1', 'append')],
      responseHeaders: [header('X-R', '2', 'append'), header('X-S', 's')],
    });
    const c = profile('C', { responseHeaders: [header('X-R', '3'), header('X-S', 't', 'append')] });
    expect(summary(testUrl(stateWith([a, b, c]), FREE, xhr('https://x.test/')))).toEqual([
      'A: request Cookie remove applied',
      'A: response X-R append=1 applied',
      'B: request Cookie append=x=1 NOT (Already removed by "A", which has higher priority.)',
      'B: response X-R append=2 applied',
      'B: response X-S set=s applied',
      'C: response X-R set=3 NOT (Overridden by "A", which has higher priority.)',
      'C: response X-S append=t applied',
    ]);
  });

  it('shows an exclude and the header it suppressed', () => {
    const p = profile('P', {
      requestHeaders: [header('X-A', '1')],
      filters: [filter('urlFilter', '/health', true)],
    });
    const low = profile('Low', { requestHeaders: [header('X-Low', '1')] });
    const matches = testUrl(stateWith([p, low]), FREE, xhr('https://x.test/health'));
    expect(summary(matches)).toEqual([
      'P: exclude applied',
      'P: request X-A set=1 NOT (Excluded by an exclude pattern in "P".)',
      'Low: request X-Low set=1 NOT (Excluded by an exclude pattern in "P".)',
    ]);
    expect(matches[0]?.warnings.map((w) => w.code)).toEqual(['EXCLUDE_ALLOW_SCOPE']);
    expect(testUrl(stateWith([p, low]), FREE, xhr('https://x.test/other'))).toHaveLength(2);
  });

  it('applies an exclude only below its own priority', () => {
    const top = profile('Top', { requestHeaders: [header('X-Top', '1')] });
    const p = profile('P', {
      requestHeaders: [header('X-A', '1')],
      filters: [filter('regex', 'health', true)],
    });
    expect(summary(testUrl(stateWith([top, p]), FREE, xhr('https://x.test/health')))).toEqual([
      'Top: request X-Top set=1 applied',
      'P: exclude applied',
      'P: request X-A set=1 NOT (Excluded by an exclude pattern in "P".)',
    ]);
  });

  it('ranks redirect (base + 3) over block (base + 2) inside a profile, and stops header rules', () => {
    const p = profile('P', {
      requestHeaders: [header('X-A', '1')],
      blocks: [block('urlFilter', '||ads.test^')],
      redirects: [redirect('urlFilter', '||ads.test/', 'https://other.test/')],
    });
    expect(summary(testUrl(stateWith([p]), FREE, xhr('https://ads.test/x.js')))).toEqual([
      'P: redirect https://other.test/ applied',
      'P: block NOT (The request is redirected by "P" first.)',
      'P: request X-A set=1 NOT (The request is redirected by "P" first.)',
    ]);
  });

  it('lets a block in a higher profile beat a redirect in a lower one', () => {
    const top = profile('Top', { blocks: [block('urlFilter', '||ads.test^')] });
    const low = profile('Low', {
      redirects: [redirect('urlFilter', '||ads.test/', 'https://other.test/')],
    });
    expect(summary(testUrl(stateWith([top, low]), FREE, xhr('https://ads.test/x.js')))).toEqual([
      'Top: block applied',
      'Low: redirect https://other.test/ NOT (The request is blocked by "Top" first.)',
    ]);
  });

  it('resolves regex redirect targets and mock sizes', () => {
    const p = profile('P', {
      redirects: [redirect('regex', '^https://prod\\.test/(.*)$', 'http://localhost:3000/$1')],
      mocks: [mock('urlFilter', '||api.test/me', '{"name":"zoë"}')],
    });
    const state = stateWith([p]);
    expect(
      summary(
        testUrl(state, PRO, {
          url: 'https://prod.test/js/app.js?v=2',
          resourceType: 'script',
          method: 'get',
        }),
      ),
    ).toEqual(['P: redirect http://localhost:3000/js/app.js?v=2 applied']);
    expect(summary(testUrl(state, PRO, xhr('https://api.test/me')))).toEqual([
      'P: mock application/json 15B applied',
    ]);
    expect(
      testUrl(state, PRO, {
        url: 'https://api.test/me',
        resourceType: 'main_frame',
        method: 'get',
      }),
    ).toEqual([]);
    expect(testUrl(state, FREE, xhr('https://api.test/me'))).toEqual([]);
  });

  it('matches tab-scoped rules only in their tab', () => {
    const p = profile('P', { requestHeaders: [header('X-Tab', '1')] });
    const state = stateWith([p], [{ profileId: p.id, tabId: 5, pauseAt: null }]);
    expect(testUrl(state, FREE, xhr('https://x.test/', { tabId: 5 }))[0]?.list).toBe('session');
    expect(testUrl(state, FREE, xhr('https://x.test/', { tabId: 6 }))).toEqual([]);
    expect(testUrl(state, FREE, xhr('https://x.test/'))).toEqual([]);
  });

  it('marks header and redirect rules as not applied without site access, but blocks still work', () => {
    const p = profile('P', {
      requestHeaders: [header('X-A', '1')],
      redirects: [redirect('url', 'https://x.test/a', 'https://x.test/b')],
      blocks: [block('urlFilter', '/blocked')],
    });
    const state = stateWith([p]);
    const reason = 'No site access for x.test. Grant access so Chrome applies this rule.';
    expect(
      testUrl(state, FREE, xhr('https://x.test/a', { hasHostAccess: () => false })).map((m) => [
        m.kind,
        m.applied,
        m.reason,
      ]),
    ).toEqual([
      ['redirect', false, reason],
      ['headers', false, reason],
    ]);
    expect(
      testUrl(state, FREE, xhr('https://x.test/blocked', { hasHostAccess: () => false })).map(
        (m) => [m.kind, m.applied],
      ),
    ).toEqual([
      ['block', true],
      ['headers', false],
    ]);
  });

  it('needs access to the page that sends the request as well as the request URL', () => {
    const p = profile('Local API', {
      requestHeaders: [header('X-Debug', '1')],
      redirects: [redirect('url', 'http://127.0.0.1:8080/a', 'http://127.0.0.1:8080/b')],
      filters: [filter('domain', '127.0.0.1')],
    });
    const state = stateWith([p]);
    const granted = hostAccessFrom(['http://127.0.0.1/*']);
    const fromLocalhost = xhr('http://127.0.0.1:8080/a', {
      initiator: 'http://localhost:5173/app',
      hasHostAccess: granted,
    });
    const reason =
      'Chrome needs access to the page that sends this request (http://localhost:5173).';
    expect(testUrl(state, FREE, fromLocalhost).map((m) => [m.kind, m.applied, m.reason])).toEqual([
      ['redirect', false, reason],
      ['headers', false, reason],
    ]);

    const sameSite = { ...fromLocalhost, initiator: 'http://127.0.0.1:3000/' };
    expect(testUrl(state, FREE, sameSite).map((m) => m.applied)).toEqual([true, false]);
    // A typed-in navigation or a non-web initiator needs only the request URL.
    expect(
      testUrl(state, FREE, { ...fromLocalhost, initiator: 'chrome-extension://abc/app.html' }).map(
        (m) => m.applied,
      ),
    ).toEqual([true, false]);
    const { initiator: _omit, ...typed } = fromLocalhost;
    expect(testUrl(state, FREE, typed)[0]?.applied).toBe(true);
    // The request URL's own reason comes first.
    expect(testUrl(state, FREE, { ...fromLocalhost, hasHostAccess: () => false })[0]?.reason).toBe(
      'No site access for 127.0.0.1. Grant access so Chrome applies this rule.',
    );
  });

  it('matches exact-URL redirects on the canonical URL', () => {
    const p = profile('P', {
      redirects: [redirect('url', 'HTTPS://CDN.Example.com:443', 'https://localhost:3000/')],
    });
    const state = stateWith([p]);
    expect(testUrl(state, FREE, xhr('https://cdn.example.com/'))[0]?.applied).toBe(true);
    expect(testUrl(state, FREE, xhr('https://cdn.example.com'))[0]?.applied).toBe(true);
    expect(testUrl(state, FREE, xhr('https://cdn.example.com/x'))).toEqual([]);
  });

  it('shows request header names as typed, although Chrome gets them lowercase', () => {
    const p = profile('P', { requestHeaders: [header('Accept-Language', 'fr', 'append')] });
    const [m] = testUrl(stateWith([p]), FREE, xhr('https://x.test/'));
    expect(m?.effect).toMatchObject({ header: 'Accept-Language', operation: 'append' });
  });

  it('attaches compile warnings to the matching item', () => {
    const p = profile('P', { requestHeaders: [header('X-Custom', 'v', 'append')] });
    const [m] = testUrl(stateWith([p]), FREE, xhr('https://x.test/'));
    expect(m?.effect).toEqual({
      type: 'header',
      direction: 'request',
      header: 'X-Custom',
      operation: 'set',
      value: 'v',
    });
    expect(m?.warnings.map((w) => w.code)).toEqual(['APPEND_NOT_ALLOWED']);
  });

  it('returns nothing for invalid URLs or when the rule budget is exceeded', () => {
    const filters = Array.from({ length: 4501 }, (_, i) => filter('urlFilter', `||h${i}.test^`));
    const state = stateWith([profile('P', { requestHeaders: [header('X-A', '1')], filters })]);
    expect(testUrl(state, FREE, xhr('https://h1.test/'))).toEqual([]);
    expect(testUrl(state, FREE, xhr('not a url'))).toEqual([]);
  });

  it('applies header and redirect rules to page and frame loads without initiator access', () => {
    const p = profile('Staging', {
      requestHeaders: [header('X-Debug', '1')],
      redirects: [redirect('url', 'https://app.test/old', 'https://app.test/new')],
    });
    const state = stateWith([p]);
    const granted = hostAccessFrom(['https://app.test/*']);
    const from = {
      initiator: 'https://other.test/page',
      hasHostAccess: granted,
      method: 'get' as const,
    };
    for (const resourceType of ['main_frame', 'sub_frame'] as const) {
      expect(
        testUrl(state, FREE, { url: 'https://app.test/old', resourceType, ...from }).map((m) => [
          m.kind,
          m.applied,
        ]),
      ).toEqual([
        ['redirect', true],
        ['headers', false],
      ]);
      expect(
        testUrl(state, FREE, { url: 'https://app.test/x', resourceType, ...from }).map(
          (m) => m.applied,
        ),
      ).toEqual([true]);
    }
    // A fetch from a page without access is still not modified.
    expect(testUrl(state, FREE, xhr('https://app.test/x', from)).map((m) => m.reason)).toEqual([
      'Chrome needs access to the page that sends this request (https://other.test).',
    ]);
    expect(needsInitiatorAccess('main_frame')).toBe(false);
    expect(needsInitiatorAccess('sub_frame')).toBe(false);
    expect(needsInitiatorAccess('script')).toBe(true);
  });

  it('redirects a page load with a #fragment, but matches subresources without it', () => {
    const p = profile('P', {
      redirects: [redirect('url', 'https://x.test/old', 'https://x.test/new')],
    });
    const state = stateWith([p]);
    const page = (url: string) =>
      testUrl(state, FREE, { url, resourceType: 'main_frame', method: 'get' });
    expect(summary(page('https://x.test/old#top'))).toEqual([
      'P: redirect https://x.test/new applied',
    ]);
    expect(summary(page('https://x.test/old'))).toEqual(['P: redirect https://x.test/new applied']);
    expect(page('https://x.test/older#top')).toEqual([]);
    // Chrome strips the fragment from subresource URLs before matching.
    expect(summary(testUrl(state, FREE, xhr('https://x.test/old#top')))).toEqual([
      'P: redirect https://x.test/new applied',
    ]);
    const anchored = profile('A', {
      requestHeaders: [header('X-A', '1')],
      filters: [filter('urlFilter', '|https://x.test/old|')],
    });
    expect(testUrl(stateWith([anchored]), FREE, xhr('https://x.test/old#top'))).toHaveLength(1);
    expect(
      testUrl(stateWith([anchored]), FREE, {
        url: 'https://x.test/old#top',
        resourceType: 'main_frame',
        method: 'get',
      }),
    ).toEqual([]);
  });

  it('notes on every mock match that a page CSP can refuse it', () => {
    const p = profile('P', { mocks: [mock('urlFilter', '||api.test/me', '{}')] });
    const [m] = testUrl(stateWith([p]), PRO, xhr('https://api.test/me'));
    expect(m).toMatchObject({ kind: 'mock', applied: true, notes: [MOCK_CSP_NOTE] });
    expect(MOCK_CSP_NOTE).toMatch(/Remove Content Security Policy preset/);
    const headers = profile('H', { requestHeaders: [header('X-A', '1')] });
    expect(testUrl(stateWith([headers]), FREE, xhr('https://api.test/me'))[0]?.notes).toEqual([]);
  });

  it('simulates RE2-only syntax such as (?i), (?P<name>) and \\p{L}', () => {
    const p = profile('P', {
      requestHeaders: [header('X-A', '1')],
      filters: [filter('regex', '(?-i)^https://x\\.test/(?P<word>\\p{L}+)$')],
      redirects: [redirect('regex', '^https://r\\.test/(?P<path>.*)$', 'https://s.test/$1')],
    });
    const state = stateWith([p]);
    expect(testUrl(state, PRO, xhr('https://x.test/abc'))).toHaveLength(1);
    expect(testUrl(state, PRO, xhr('https://x.test/ABC'))).toHaveLength(1);
    expect(testUrl(state, PRO, xhr('https://x.test/a1'))).toEqual([]);
    expect(summary(testUrl(state, PRO, xhr('https://r.test/a/b')))).toEqual([
      'P: redirect https://s.test/a/b applied',
    ]);
  });

  it('says it cannot preview a regex JS cannot express, instead of guessing', () => {
    const p = profile('P', {
      requestHeaders: [header('X-A', '1')],
      filters: [filter('regex', '^https://x\\.test/(?i)ADMIN')],
      redirects: [redirect('regex', '^https://r\\.test/(?U)(.*)$', 'https://s.test/$1')],
    });
    const state = stateWith([p]);
    // The redirect's regex can't run either, so it is listed as unknown for every URL.
    const all = testUrl(state, PRO, xhr('https://x.test/admin'));
    expect(all.map((m) => [m.kind, m.previewed])).toEqual([
      ['redirect', false],
      ['headers', false],
    ]);
    const headerMatch = all.filter((m) => m.kind === 'headers');
    expect(headerMatch).toEqual([
      expect.objectContaining({
        kind: 'headers',
        applied: false,
        previewed: false,
        reason: REGEX_PREVIEW_NOTE,
        effect: expect.objectContaining({ header: 'X-A', operation: 'set', value: '1' }),
      }),
    ]);
    const redirectMatch = testUrl(state, PRO, xhr('https://r.test/a')).find(
      (m) => m.kind === 'redirect',
    );
    expect(redirectMatch).toMatchObject({
      kind: 'redirect',
      previewed: false,
      reason: REGEX_PREVIEW_NOTE,
      effect: { type: 'redirect', to: 'https://s.test/$1' },
    });
    // Non-regex conditions still rule it out.
    const typed = profile('T', {
      requestHeaders: [header('X-A', '1')],
      filters: [filter('regex', 'a(?i)b')],
      resourceTypes: ['script'],
    });
    expect(testUrl(stateWith([typed]), FREE, xhr('https://x.test/ab'))).toEqual([]);
    // Rules the tester can evaluate are reported as usual.
    expect(
      testUrl(
        stateWith([profile('Q', { requestHeaders: [header('X', '1')] })]),
        FREE,
        xhr('https://x.test/'),
      )[0]?.previewed,
    ).toBe(true);
  });
});
