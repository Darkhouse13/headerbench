import { beforeEach, describe, expect, it } from 'vitest';
import { RESOURCE_TYPES, base64Decode, compile, mockDataUrl, utf8Decode } from '../src/index.js';
import type { CompileResult, State, WarningCode } from '../src/index.js';
import {
  FREE,
  NOW,
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

const codes = (r: CompileResult): WarningCode[] => r.warnings.map((w) => w.code);

describe('compile: rule kinds', () => {
  it('compiles request and response header ops into one modifyHeaders rule for all URLs', () => {
    const p = profile('Staging', {
      requestHeaders: [
        header('X-Api-Key', 'abc123'),
        header('Cookie', 'a=1', 'append'),
        header('Referer', '', 'remove'),
      ],
      responseHeaders: [
        header('Access-Control-Allow-Origin', '*'),
        header('Content-Security-Policy', '', 'remove'),
      ],
    });
    const result = compile(stateWith([p]), FREE);
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.session).toEqual([]);
    expect(result.dynamic).toMatchSnapshot();
    expect(result.dynamic[0]?.condition.resourceTypes).toEqual([...RESOURCE_TYPES]);
    expect(result.sources).toEqual([
      {
        list: 'dynamic',
        ruleId: 1,
        profileId: p.id,
        activationIndex: 0,
        kind: 'headers',
        itemIds: ['h1', 'h2', 'h3', 'h4', 'h5'],
      },
    ]);
  });

  it('emits one rule per include filter, with resource types and methods', () => {
    const p = profile('Filtered', {
      requestHeaders: [header('X-Debug', '1')],
      filters: [
        filter('domain', '*.API.Example.com'),
        filter('urlFilter', '||cdn.example.com^'),
        filter('regex', '^https://[a-z]+\\.test/'),
      ],
      resourceTypes: ['xmlhttprequest', 'main_frame'],
      methods: ['post', 'get'],
    });
    const result = compile(stateWith([p]), FREE);
    expect(result.dynamic).toMatchSnapshot();
    expect(
      result.dynamic.map(
        (r) => r.condition.requestDomains ?? r.condition.urlFilter ?? r.condition.regexFilter,
      ),
    ).toEqual([['api.example.com'], '||cdn.example.com^', '^https://[a-z]+\\.test/']);
  });

  it('compiles blocks and redirects with their own pattern scope', () => {
    const p = profile('Routes', {
      filters: [filter('domain', 'example.com')],
      blocks: [block('urlFilter', '||ads.example.com^'), block('regex', '^https://track\\.')],
      redirects: [
        redirect('url', 'https://cdn.example.com/app.js', 'http://localhost:3000/app.js'),
        redirect('urlFilter', '||old.example.com/api/', 'https://new.example.com/api/'),
        redirect('regex', '^https://prod\\.example\\.com/(.*)$', 'http://localhost:3000/$1'),
      ],
    });
    const result = compile(stateWith([p]), PRO);
    expect(result.dynamic).toMatchSnapshot();
    expect(result.dynamic.every((r) => r.condition.requestDomains === undefined)).toBe(true);
    expect(result.dynamic.map((r) => r.priority)).toEqual([12, 12, 13, 13, 13, 13]);
    expect(result.dynamic[2]?.condition.urlFilter).toBe('|https://cdn.example.com/app.js|');
    expect(result.dynamic[3]?.condition).toEqual({
      urlFilter: '|https://cdn.example.com/app.js#',
      resourceTypes: ['main_frame', 'sub_frame'],
    });
    expect(result.dynamic[5]?.action.redirect).toEqual({
      regexSubstitution: 'http://localhost:3000/\\1',
    });
  });

  it('builds exact-URL redirects from the canonical URL', () => {
    const p = profile('P', {
      redirects: [
        redirect('url', 'HTTPS://CDN.Example.COM:443', 'http://localhost:3000/'),
        redirect('url', 'http://a.test:80/x?y=1#frag', 'http://localhost:3000/x'),
        redirect('url', 'https://b.test/ünï code', 'http://localhost:3000/u'),
      ],
    });
    const filters = compile(stateWith([p]), FREE).dynamic.map((r) => r.condition.urlFilter);
    expect(filters).toEqual([
      '|https://cdn.example.com/|',
      '|https://cdn.example.com/#',
      '|http://a.test/x?y=1|',
      '|http://a.test/x?y=1#',
      '|https://b.test/%C3%BCn%C3%AF%20code|',
      '|https://b.test/%C3%BCn%C3%AF%20code#',
    ]);
  });

  it('adds a #fragment rule for page and frame loads, which Chrome matches with the fragment', () => {
    const p = profile('P', {
      redirects: [redirect('url', 'https://x.test/old', 'https://x.test/new')],
    });
    const result = compile(stateWith([p]), FREE);
    expect(result.dynamic.map((r) => [r.condition.urlFilter, r.condition.resourceTypes])).toEqual([
      ['|https://x.test/old|', [...RESOURCE_TYPES]],
      ['|https://x.test/old#', ['main_frame', 'sub_frame']],
    ]);
    expect(result.sources.map((s) => s.itemIds)).toEqual([['r1'], ['r1']]);
  });

  it('sends lowercase request header names, so Chrome accepts a mixed-case append', () => {
    const p = profile('P', {
      requestHeaders: [
        header('Accept-Language', 'fr', 'append'),
        header('X-Api-Key', 'k'),
        header('Cookie', '', 'remove'),
      ],
      responseHeaders: [header('Access-Control-Allow-Origin', '*')],
    });
    const [rule] = compile(stateWith([p]), FREE).dynamic;
    expect(rule?.action.requestHeaders).toEqual([
      { header: 'accept-language', operation: 'append', value: 'fr' },
      { header: 'x-api-key', operation: 'set', value: 'k' },
      { header: 'cookie', operation: 'remove' },
    ]);
    expect(rule?.action.responseHeaders?.[0]?.header).toBe('Access-Control-Allow-Origin');
  });

  it('compiles mocks to data: URL redirects without frame types', () => {
    const p = profile('Mocks', {
      mocks: [mock('urlFilter', '||api.example.com/users', '{"users":[]}')],
    });
    const result = compile(stateWith([p]), PRO);
    expect(result.dynamic).toMatchSnapshot();
    const types = result.dynamic[0]?.condition.resourceTypes ?? [];
    expect(types).not.toContain('main_frame');
    expect(types).not.toContain('sub_frame');
    expect(result.dynamic[0]?.priority).toBe(14);
  });

  it('returns nothing when paused', () => {
    const state = stateWith([profile('A', { requestHeaders: [header('X-A', '1')] })]);
    state.settings.paused = true;
    expect(compile(state, FREE)).toEqual({
      ok: true,
      dynamic: [],
      session: [],
      warnings: [],
      sources: [],
      stats: { dynamic: 0, session: 0, unsafe: 0, regex: 0 },
    });
  });

  it('skips profiles without enabled items and activations of deleted profiles', () => {
    const empty = profile('Empty', {
      requestHeaders: [header('X-A', '1', 'set', { enabled: false })],
    });
    const state = stateWith(
      [empty],
      [
        { profileId: empty.id, tabId: null, pauseAt: null },
        { profileId: 'gone', tabId: null, pauseAt: null },
      ],
    );
    expect(compile(state, FREE).dynamic).toEqual([]);
  });
});

describe('compile: priority', () => {
  const three = (): State => {
    const a = profile('A', { requestHeaders: [header('X-Env', 'a')] });
    const b = profile('B', {
      requestHeaders: [header('X-Env', 'b')],
      blocks: [block('urlFilter', '||b.test^')],
    });
    const c = profile('C', {
      requestHeaders: [header('X-Env', 'c')],
      redirects: [redirect('url', 'https://c.test/x', 'https://c.test/y')],
    });
    return stateWith([a, b, c]);
  };

  it('gives earlier activations higher bands', () => {
    const result = compile(three(), FREE);
    expect(result.dynamic.map((r) => [r.id, r.priority, r.action.type])).toEqual([
      [1, 30, 'modifyHeaders'],
      [2, 20, 'modifyHeaders'],
      [3, 22, 'block'],
      [4, 10, 'modifyHeaders'],
      [5, 13, 'redirect'],
      [6, 13, 'redirect'],
    ]);
    expect(result.dynamic[0]?.action.requestHeaders).toEqual([
      { header: 'x-env', operation: 'set', value: 'a' },
    ]);
  });

  it('flips when the activation order changes', () => {
    const state = three();
    state.settings.activations.reverse();
    const result = compile(state, FREE);
    const top = result.dynamic.find((r) => r.priority === 30);
    expect(top?.action.requestHeaders?.[0]?.value).toBe('c');
  });

  it('ignores activations whose auto-pause time has passed', () => {
    const state = three();
    state.settings.activations[0] = { ...state.settings.activations[0]!, pauseAt: NOW - 1 };
    state.settings.activations[1] = { ...state.settings.activations[1]!, pauseAt: NOW + 60_000 };
    const result = compile(state, FREE);
    expect(result.dynamic.map((r) => r.priority)).toEqual([20, 22, 10, 13, 13]);
  });
});

describe('compile: excludes', () => {
  it('puts domain excludes on every condition', () => {
    const p = profile('P', {
      requestHeaders: [header('X-A', '1')],
      filters: [
        filter('domain', 'example.com'),
        filter('domain', 'other.com'),
        filter('domain', 'login.example.com', true),
      ],
    });
    const result = compile(stateWith([p]), FREE);
    expect(result.dynamic).toHaveLength(1);
    expect(result.dynamic[0]?.condition).toMatchObject({
      requestDomains: ['example.com', 'other.com'],
      excludedRequestDomains: ['login.example.com'],
    });
    expect(result.warnings).toEqual([]);
  });

  it('turns pattern excludes into allow rules at base + 9 with a scope warning', () => {
    const p = profile('P', {
      requestHeaders: [header('X-A', '1')],
      filters: [filter('urlFilter', '/health', true), filter('regex', '\\.png$', true)],
      methods: ['get'],
    });
    const result = compile(stateWith([p]), FREE);
    expect(result.dynamic).toMatchSnapshot();
    expect(result.dynamic.filter((r) => r.action.type === 'allow').map((r) => r.priority)).toEqual([
      19, 19,
    ]);
    expect(codes(result)).toEqual(['EXCLUDE_ALLOW_SCOPE', 'EXCLUDE_ALLOW_SCOPE']);
    expect(result.warnings[0]?.message).toBe(
      "On matching URLs this exclude also skips this profile's blocks, redirects and mocks, and every lower-priority profile. A domain exclude affects only this profile's headers.",
    );
  });

  it('ignores disabled filters', () => {
    const p = profile('P', {
      requestHeaders: [header('X-A', '1')],
      filters: [
        filter('domain', 'example.com', false, { enabled: false }),
        filter('urlFilter', '/x', true, { enabled: false }),
      ],
    });
    const result = compile(stateWith([p]), FREE);
    expect(result.dynamic).toHaveLength(1);
    expect(result.dynamic[0]?.condition.requestDomains).toBeUndefined();
  });
});

describe('compile: tab scope', () => {
  it('sends tab-scoped activations to session rules with tabIds', () => {
    const tabbed = profile('Tab', {
      requestHeaders: [header('X-Tab', '1')],
      blocks: [block('urlFilter', '||x.test^')],
    });
    const global = profile('Global', { requestHeaders: [header('X-Global', '1')] });
    const state = stateWith(
      [tabbed, global],
      [
        { profileId: tabbed.id, tabId: 42, pauseAt: null },
        { profileId: global.id, tabId: null, pauseAt: null },
      ],
    );
    const result = compile(state, FREE);
    expect(result.dynamic).toHaveLength(1);
    expect(result.dynamic[0]?.priority).toBe(10);
    expect(result.session.map((r) => [r.id, r.priority, r.condition.tabIds])).toEqual([
      [1, 20, [42]],
      [2, 22, [42]],
    ]);
    expect(result.sources.map((s) => `${s.list}:${s.ruleId}`)).toEqual([
      'session:1',
      'session:2',
      'dynamic:1',
    ]);
    expect(result.stats).toEqual({ dynamic: 1, session: 2, unsafe: 1, regex: 0 });
  });
});

describe('compile: Pro gating', () => {
  const proProfile = (): State =>
    stateWith([
      profile('P', {
        redirects: [
          redirect('regex', '^https://a\\.test/(.*)', 'https://b.test/$1'),
          redirect('url', 'https://a.test/x', 'https://b.test/x'),
        ],
        mocks: [mock('urlFilter', '||a.test/api', '[]')],
      }),
    ]);

  it('pauses regex redirects and mocks without Pro and says which', () => {
    const result = compile(proProfile(), FREE);
    expect(result.dynamic.map((r) => r.action.redirect?.url)).toEqual([
      'https://b.test/x',
      'https://b.test/x',
    ]);
    expect(result.warnings).toEqual([
      {
        code: 'PRO_PAUSED',
        severity: 'warning',
        message: '2 Pro rules are paused. They resume when Pro is active.',
        profileId: 'p-p',
        itemIds: ['r1', 'm3'],
      },
    ]);
  });

  it('compiles them with Pro', () => {
    const result = compile(proProfile(), PRO);
    expect(result.dynamic).toHaveLength(4);
    expect(result.warnings).toEqual([]);
  });
});

describe('compile: variables', () => {
  const withVars = (): State => {
    const state = stateWith([
      profile('P', {
        requestHeaders: [
          header('Authorization', 'Bearer {{token}}'),
          header('X-Missing', '{{nope}}'),
        ],
        redirects: [redirect('url', 'https://app.test/main.js', '{{host}}/main.js')],
        mocks: [mock('urlFilter', '||app.test/me', '{"user":"{{ user }}"}')],
      }),
    ]);
    state.settings.variables = [
      { id: 'v1', name: 'token', value: 's3cret' },
      { id: 'v2', name: 'host', value: 'http://localhost:5173' },
      { id: 'v3', name: 'user', value: 'zoë' },
    ];
    return state;
  };

  it('substitutes variables with Pro and warns about unknown ones', () => {
    const result = compile(withVars(), PRO);
    const headers = result.dynamic[0]?.action.requestHeaders;
    expect(headers).toEqual([
      { header: 'authorization', operation: 'set', value: 'Bearer s3cret' },
      { header: 'x-missing', operation: 'set', value: '{{nope}}' },
    ]);
    expect(result.dynamic[1]?.action.redirect?.url).toBe('http://localhost:5173/main.js');
    const dataUrl = result.dynamic[3]?.action.redirect?.url ?? '';
    expect(utf8Decode(base64Decode(dataUrl.split(',')[1]!))).toBe('{"user":"zoë"}');
    expect(result.warnings.map((w) => [w.code, w.itemIds, w.message])).toEqual([
      ['VARIABLE_UNRESOLVED', ['h2'], 'Unknown variable {{nope}}. The text is sent as written.'],
    ]);
  });

  it('keeps the literal without Pro', () => {
    const result = compile(withVars(), FREE);
    expect(result.dynamic[0]?.action.requestHeaders?.[0]?.value).toBe('Bearer {{token}}');
    expect(result.warnings.map((w) => [w.code, w.itemIds])).toEqual([
      ['VARIABLE_UNRESOLVED', ['h1']],
      ['VARIABLE_UNRESOLVED', ['h2']],
      ['PRO_PAUSED', ['r3', 'm4']],
    ]);
    expect(result.dynamic).toHaveLength(1);
  });

  it('rejects a header value that becomes multi-line after substitution', () => {
    const state = stateWith([profile('P', { requestHeaders: [header('X-A', '{{bad}}')] })]);
    state.settings.variables = [{ id: 'v', name: 'bad', value: 'a\r\nb' }];
    const result = compile(state, PRO);
    expect(result.dynamic).toEqual([]);
    expect(result.warnings[0]?.code).toBe('INVALID_ITEM');
  });
});

describe('compile: mocks', () => {
  it('round-trips a UTF-8 body through the data URL', () => {
    const body = '{"greeting":"héllo wörld ✓ 日本語 🎉"}';
    const url = mockDataUrl('application/json', body);
    expect(url.startsWith('data:application/json;charset=utf-8;base64,')).toBe(true);
    expect(utf8Decode(base64Decode(url.split(',')[1]!))).toBe(body);
  });

  it('keeps an explicit charset and leaves binary types alone', () => {
    expect(mockDataUrl('text/plain; charset=iso-8859-1', 'a')).toBe(
      'data:text/plain;charset=iso-8859-1;base64,YQ==',
    );
    expect(mockDataUrl('image/svg+xml', '')).toBe('data:image/svg+xml;base64,');
    expect(mockDataUrl('application/problem+json', '{}')).toBe(
      'data:application/problem+json;charset=utf-8;base64,e30=',
    );
  });

  it('rejects bodies over 64 KB', () => {
    const big = mock('urlFilter', '||a.test/big', 'x'.repeat(64 * 1024 + 1));
    const ok = mock('urlFilter', '||a.test/ok', 'x'.repeat(64 * 1024));
    const result = compile(stateWith([profile('P', { mocks: [big, ok] })]), PRO);
    expect(result.dynamic).toHaveLength(1);
    expect(result.warnings).toEqual([
      {
        code: 'MOCK_TOO_LARGE',
        severity: 'error',
        message: 'The mock body is 65 KB. The limit is 64 KB.',
        profileId: 'p-p',
        itemIds: [big.id],
      },
    ]);
  });
});

describe('compile: validation', () => {
  it('skips invalid items and keeps the rest', () => {
    const p = profile('P', {
      requestHeaders: [
        header('Bad Name', 'x'),
        header('X-Ok', 'fine'),
        header('X-Newline', 'a\nb'),
      ],
      filters: [filter('regex', '^https://(?!admin)'), filter('domain', 'example.com')],
      blocks: [block('regex', '([a-z]+)\\1')],
      redirects: [
        redirect('url', 'not a url', 'https://x.test/'),
        redirect('urlFilter', '||loop.test/', 'https://loop.test/again'),
      ],
      mocks: [mock('urlFilter', '||m.test', '{}', 'not a type')],
    });
    const result = compile(stateWith([p]), PRO);
    expect(result.dynamic).toHaveLength(1);
    expect(result.dynamic[0]?.action.requestHeaders).toEqual([
      { header: 'x-ok', operation: 'set', value: 'fine' },
    ]);
    expect(result.dynamic[0]?.condition.requestDomains).toEqual(['example.com']);
    expect(result.warnings.every((w) => w.code === 'INVALID_ITEM' && w.severity === 'error')).toBe(
      true,
    );
    expect(result.warnings).toHaveLength(7);
    expect(result.warnings.find((w) => w.itemIds[0] === p.redirects[1]!.id)?.message).toMatch(
      /loop/,
    );
  });

  it('does not widen a profile to all URLs when all its include filters are invalid', () => {
    const p = profile('P', {
      requestHeaders: [header('X-A', '1')],
      filters: [filter('domain', 'https://bad/')],
    });
    const result = compile(stateWith([p]), FREE);
    expect(result.dynamic).toEqual([]);
    expect(codes(result)).toEqual(['INVALID_ITEM']);
  });

  it('compiles a request append outside the allowlist as set', () => {
    const p = profile('P', {
      requestHeaders: [
        header('X-Custom', 'v', 'append'),
        header('Accept-Language', 'fr', 'append'),
      ],
      responseHeaders: [header('X-Resp', 'v', 'append')],
    });
    const result = compile(stateWith([p]), FREE);
    expect(result.dynamic[0]?.action.requestHeaders).toEqual([
      { header: 'x-custom', operation: 'set', value: 'v' },
      { header: 'accept-language', operation: 'append', value: 'fr' },
    ]);
    expect(result.dynamic[0]?.action.responseHeaders).toEqual([
      { header: 'X-Resp', operation: 'append', value: 'v' },
    ]);
    expect(result.warnings.map((w) => [w.code, w.itemIds])).toEqual([
      ['APPEND_NOT_ALLOWED', ['h1']],
    ]);
  });

  it('keeps the first of two rows that set the same header', () => {
    const p = profile('P', {
      requestHeaders: [
        header('X-A', '1'),
        header('x-a', '2'),
        header('Cookie', 'a=1'),
        header('Cookie', 'b=2', 'append'),
      ],
    });
    const result = compile(stateWith([p]), FREE);
    expect(result.dynamic[0]?.action.requestHeaders?.map((h) => h.value)).toEqual([
      '1',
      'a=1',
      'b=2',
    ]);
    expect(result.warnings.map((w) => w.itemIds)).toEqual([['h2']]);
    expect(result.sources[0]?.itemIds).toEqual(['h1', 'h3', 'h4']);
  });

  it('deduplicates warnings when a profile is active twice', () => {
    const p = profile('P', { requestHeaders: [header('Bad Name', '1'), header('X-A', '1')] });
    const state = stateWith(
      [p],
      [
        { profileId: p.id, tabId: null, pauseAt: null },
        { profileId: p.id, tabId: 7, pauseAt: null },
      ],
    );
    const result = compile(state, FREE);
    expect(result.warnings).toHaveLength(1);
    expect(result.dynamic).toHaveLength(1);
    expect(result.session).toHaveLength(1);
  });
});

describe('compile: rule budget', () => {
  it('refuses to compile more than 4,500 unsafe rules', () => {
    const filters = Array.from({ length: 4501 }, (_, i) =>
      filter('urlFilter', `||host${i}.example.com^`),
    );
    const result = compile(
      stateWith([profile('Huge', { requestHeaders: [header('X-A', '1')], filters })]),
      FREE,
    );
    expect(result.ok).toBe(false);
    expect(result.dynamic).toEqual([]);
    expect(result.sources).toEqual([]);
    expect(result.warnings[0]).toMatchObject({ code: 'RULE_BUDGET', severity: 'error' });
    expect(result.warnings[0]?.message).toContain('4501 header/redirect rules');
    expect(result.stats.unsafe).toBe(4501);
  });

  it('refuses more than 900 regex rules', () => {
    const blocks = Array.from({ length: 901 }, (_, i) => block('regex', `^https://h${i}\\.test/`));
    const result = compile(stateWith([profile('Regex', { blocks })]), FREE);
    expect(result.ok).toBe(false);
    expect(result.stats.regex).toBe(901);
  });

  it('accepts exactly 4,500', () => {
    const filters = Array.from({ length: 4500 }, (_, i) =>
      filter('urlFilter', `||host${i}.example.com^`),
    );
    const result = compile(
      stateWith([profile('Big', { requestHeaders: [header('X-A', '1')], filters })]),
      FREE,
    );
    expect(result.ok).toBe(true);
    expect(result.dynamic).toHaveLength(4500);
    expect(result.dynamic.at(-1)?.id).toBe(4500);
  });
});

describe('compile: domain includes', () => {
  it('merges every domain include into one condition, so overlaps cannot double an append', () => {
    const p = profile('P', {
      requestHeaders: [header('Accept-Language', 'fr', 'append')],
      filters: [
        filter('domain', 'example.com'),
        filter('domain', 'api.example.com'),
        filter('domain', 'Example.com'),
      ],
    });
    const result = compile(stateWith([p]), FREE);
    expect(result.dynamic).toHaveLength(1);
    expect(result.dynamic[0]?.condition.requestDomains).toEqual(['example.com', 'api.example.com']);
    expect(result.warnings).toEqual([]);
  });

  it('warns that an append can apply twice when several pattern filters remain', () => {
    const p = profile('P', {
      requestHeaders: [header('X-Set', '1'), header('Accept-Language', 'fr', 'append')],
      responseHeaders: [header('X-Resp', 'a', 'append')],
      filters: [filter('domain', 'example.com'), filter('urlFilter', '||api.example.com/v1/')],
    });
    const result = compile(stateWith([p]), FREE);
    expect(result.dynamic.map((r) => r.condition.requestDomains ?? r.condition.urlFilter)).toEqual([
      ['example.com'],
      '||api.example.com/v1/',
    ]);
    expect(result.warnings).toEqual([
      {
        code: 'APPEND_OVERLAP',
        severity: 'warning',
        message:
          "If two of this profile's filters match the same request, the value is appended twice.",
        profileId: p.id,
        itemIds: ['h2', 'h3'],
      },
    ]);
  });

  it('does not warn about overlap without an append', () => {
    const p = profile('P', {
      requestHeaders: [header('X-Set', '1')],
      filters: [filter('urlFilter', '||a.test^'), filter('regex', '^https://b\\.test/')],
    });
    expect(codes(compile(stateWith([p]), FREE))).toEqual([]);
  });
});

describe('compile: request headers the browser manages', () => {
  it.each([
    'Transfer-Encoding',
    'expect',
    'Content-Length',
    'Connection',
    'Upgrade',
    'Keep-Alive',
    'TE',
    'Trailer',
    'Host',
  ])('warns that changing %s may break requests', (name) => {
    const p = profile('P', { requestHeaders: [header(name, 'x')] });
    const result = compile(stateWith([p]), FREE);
    expect(result.warnings).toEqual([
      {
        code: 'HEADER_BREAKS_REQUESTS',
        severity: 'warning',
        message: `Requests may fail when ${name} is changed. The browser manages this header itself.`,
        profileId: p.id,
        itemIds: ['h1'],
      },
    ]);
    expect(result.dynamic).toHaveLength(1);
  });

  it('also warns on append, but not on remove or on response headers', () => {
    const p = profile('P', {
      requestHeaders: [
        header('Transfer-Encoding', 'gzip', 'append'),
        header('Expect', '', 'remove'),
      ],
      responseHeaders: [header('Content-Length', '1')],
    });
    expect(compile(stateWith([p]), FREE).warnings.map((w) => [w.code, w.itemIds])).toEqual([
      ['HEADER_BREAKS_REQUESTS', ['h1']],
    ]);
  });
});

describe('compile: regex redirect substitutions', () => {
  it('skips a redirect whose $N names a missing group', () => {
    const p = profile('P', {
      redirects: [redirect('regex', '^https://prod\\.test/(.*)$', 'http://localhost/$1/$2')],
    });
    const result = compile(stateWith([p]), PRO);
    expect(result.dynamic).toEqual([]);
    expect(result.warnings).toEqual([
      {
        code: 'INVALID_ITEM',
        severity: 'error',
        message: '$2 in the target refers to group 2, but the pattern has only 1 capture group.',
        profileId: p.id,
        itemIds: ['r1'],
      },
    ]);
  });

  it('re-checks after variables are substituted', () => {
    const p = profile('P', {
      redirects: [redirect('regex', '^https://prod\\.test/(.*)$', '{{base}}/$1')],
    });
    const state = stateWith([p]);
    state.settings.variables = [{ id: 'v', name: 'base', value: 'http://localhost/$3' }];
    const result = compile(state, PRO);
    expect(result.dynamic).toEqual([]);
    expect(result.warnings[0]?.message).toMatch(/\$3 in the target refers to group 3/);
  });
});
