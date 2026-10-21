import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  compile,
  exportJson,
  importAny,
  originsFor,
  regexToFilter,
  summarizeImport,
} from '../src/index.js';
import type { ImportResult, State } from '../src/index.js';
import { checkFilter } from '../src/items.js';
import { header, mock, profile, redirect, stateWith } from './helpers.js';

const NOW = 1_760_000_000_000;
const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const load = (name: string): ImportResult => importAny(fixture(name), NOW);
const lines = (r: ImportResult): string[] =>
  r.report.lines.map((l) => `${l.level}|${l.profile}|${l.message}`);

describe('ModHeader Format A v2', () => {
  const result = load('modheader-a-v2.json');
  const [staging, mobile] = result.profiles;

  it('detects the format and imports every profile', () => {
    expect(result.report.format).toBe('modheader-a-v2');
    expect(result.report.errors).toEqual([]);
    expect(result.profiles.map((p) => [p.name, p.badge, p.color])).toEqual([
      ['Staging API', 'S', '#c5221f'],
      ['Mobile UA', 'M', '#188038'],
    ]);
  });

  it('maps request and response headers, keeping disabled rows and turning empty values into remove', () => {
    expect(
      staging!.requestHeaders.map((h) => [h.name, h.value, h.op, h.enabled, h.comment]),
    ).toEqual([
      ['X-Api-Key', 'stg_4f9a2c', 'set', true, 'staging key'],
      ['Authorization', 'Bearer eyJhbGciOiJIUzI1NiJ9.e30.sig', 'set', true, ''],
      ['X-Debug', '1', 'set', false, 'turn on when needed'],
      ['Referer', '', 'remove', true, 'strip referer'],
    ]);
    expect(staging!.responseHeaders.map((h) => [h.name, h.value, h.op])).toEqual([
      ['Access-Control-Allow-Origin', '*', 'set'],
    ]);
  });

  it('converts a simple host regex to a domain filter and keeps other regexes', () => {
    expect(staging!.filters.map((f) => [f.kind, f.value, f.exclude, f.enabled])).toEqual([
      ['domain', 'api.staging.example.com', false, true],
      ['regex', '.*/health$', true, true],
    ]);
    expect(staging!.resourceTypes).toEqual(['xmlhttprequest', 'main_frame']);
  });

  it('turns urlReplacements into regex redirects', () => {
    expect(staging!.redirects).toEqual([
      {
        id: expect.any(String),
        enabled: true,
        kind: 'regex',
        from: '^https://cdn\\.example\\.com/app\\.(.*)\\.js$',
        to: 'http://localhost:3000/app.$1.js',
        comment: '',
      },
    ]);
  });

  it('applies appendMode "comma" and sendEmptyHeader', () => {
    expect(mobile!.requestHeaders.map((h) => [h.name, h.op, h.enabled])).toEqual([
      ['User-Agent', 'append', true],
      ['X-Empty', 'append', true],
      ['X-Request-Time', 'set', false],
    ]);
  });

  it('imports function values and RE2-incompatible regexes switched off, with report lines', () => {
    expect(mobile!.filters.map((f) => [f.kind, f.enabled])).toEqual([['regex', false]]);
    expect(mobile!.redirects.map((r) => [r.from, r.enabled])).toEqual([['(a)\\1', false]]);
    expect(mobile!.resourceTypes).toEqual(['xmlhttprequest']);
    expect(lines(result)).toEqual([
      'info|Staging API|1 request header rows with no name were skipped.',
      'info|Staging API|Filter .*://api\\.staging\\.example\\.com/.* became the domain filter api.staging.example.com (it also covers subdomains), so Headerbench asks for access to that site instead of every site.',
      'info|Staging API|1 URL replacement became a regex redirect. It runs with Pro or during the trial.',
      'warning|Mobile UA|X-Request-Time: the dynamic function value was imported switched off. Chrome rules can only send fixed values.',
      'warning|Mobile UA|Resource type "beacon" is not supported by Chrome rules and was skipped.',
      'info|Mobile UA|1 URL replacement became a regex redirect. It runs with Pro or during the trial.',
      'warning|Mobile UA|Filter ^https://(?!admin\\.)[a-z]+\\.example\\.com/ was imported switched off: Lookahead and lookbehind ((?=, (?!, (?<=, (?<!) are not supported in Chrome rules.',
      'warning|Mobile UA|Redirect (a)\\1 was imported switched off: Backreferences (\\1) are not supported in Chrome rules.',
    ]);
  });

  it('counts unknown keys and summarises', () => {
    expect(result.report.ignoredKeyNames).toEqual(['lockedProfile']);
    expect(result.report.counts).toEqual({
      profiles: 2,
      requestHeaders: 7,
      responseHeaders: 1,
      filters: 3,
      redirects: 2,
      blocks: 0,
      mocks: 0,
      variables: 0,
      disabled: 4,
    });
    expect(summarizeImport(result.report)).toBe(
      '2 profiles, 8 headers, 3 filters, 2 redirects imported; 4 items switched off (see details); 1 unknown field ignored',
    );
  });

  it('produces profiles that compile cleanly', () => {
    const state: State = stateWith(result.profiles);
    const compiled = compile(state, { pro: true, now: NOW });
    expect(compiled.ok).toBe(true);
    expect(compiled.warnings.filter((w) => w.code === 'INVALID_ITEM')).toEqual([]);
  });

  it('accepts a single profile object', () => {
    const single = importAny(JSON.stringify(JSON.parse(fixture('modheader-a-v2.json'))[0]), NOW);
    expect(single.report.format).toBe('modheader-a-v2');
    expect(single.profiles).toHaveLength(1);
  });
});

describe('ModHeader Format A v1', () => {
  it('migrates filters[] into include, exclude and type filters', () => {
    const result = load('modheader-a-v1.json');
    expect(result.report.format).toBe('modheader-a-v1');
    const [p] = result.profiles;
    expect(p!.name).toBe('Legacy');
    expect(p!.badge).toBe('L');
    expect(p!.requestHeaders.map((h) => [h.name, h.value, h.op])).toEqual([
      ['X-Legacy', 'yes', 'set'],
    ]);
    expect(p!.filters.map((f) => [f.kind, f.value, f.exclude])).toEqual([
      ['domain', 'legacy.example.org', false],
      ['regex', '.*\\.png', true],
    ]);
    expect(p!.resourceTypes).toEqual(['xmlhttprequest', 'sub_frame']);
    expect(lines(result)).toContain(
      'warning|Legacy|A filter of unknown type "cookies" was skipped.',
    );
  });
});

describe('ModHeader appendMode', () => {
  const ops = (json: unknown, side: 'requestHeaders' | 'responseHeaders' = 'requestHeaders') =>
    importAny(JSON.stringify(json), NOW).profiles[0]![side].map((h) => h.op);
  const formatA = (appendMode: unknown) => [
    {
      version: 2,
      title: 'P',
      appendMode,
      headers: [{ enabled: true, name: 'Accept-Language', value: 'fr' }],
      respHeaders: [{ enabled: true, name: 'X-Resp', value: '1' }],
    },
  ];

  it('imports appendMode true and "comma" as append (Format A)', () => {
    expect(ops(formatA(true))).toEqual(['append']);
    expect(ops(formatA('comma'))).toEqual(['append']);
    expect(ops(formatA(true), 'responseHeaders')).toEqual(['append']);
  });

  it('imports any other appendMode as set (Format A)', () => {
    for (const mode of [false, null, '', 'false', undefined]) {
      expect(ops(formatA(mode)), String(mode)).toEqual(['set']);
    }
  });

  it('imports an unknown appendMode as set and says so once per profile', () => {
    const result = importAny(JSON.stringify(formatA('semicolon')), NOW);
    expect(result.profiles[0]!.requestHeaders.map((h) => h.op)).toEqual(['set']);
    expect(result.profiles[0]!.responseHeaders.map((h) => h.op)).toEqual(['set']);
    expect(result.report.lines.filter((l) => l.message.includes('appendMode'))).toEqual([
      {
        level: 'info',
        profile: 'P',
        message:
          'appendMode "semicolon" is not one Headerbench knows, so those headers replace the value instead of appending to it.',
      },
    ]);
    const known = importAny(JSON.stringify(formatA(false)), NOW);
    expect(known.report.lines.filter((l) => l.message.includes('appendMode'))).toEqual([]);
  });

  it('reports an unknown Format B appendMode on a profile or rule', () => {
    const result = importAny(
      JSON.stringify({
        name: 'B',
        appendMode: 2,
        sections: {
          request: {
            rules: [
              { enabled: true, name: 'X-A', value: '1' },
              { enabled: true, name: 'X-B', value: '1', appendMode: 'space' },
            ],
          },
        },
      }),
      NOW,
    );
    expect(result.profiles[0]!.requestHeaders.map((h) => h.op)).toEqual(['set', 'set']);
    expect(
      result.report.lines.filter((l) => l.message.includes('appendMode')).map((l) => l.message),
    ).toEqual([
      'appendMode 2 is not one Headerbench knows, so those headers replace the value instead of appending to it.',
      'appendMode "space" is not one Headerbench knows, so those headers replace the value instead of appending to it.',
    ]);
  });

  it('honours appendMode on a Format B profile or rule, unless the rule names its op', () => {
    const b = (profileMode: unknown, rule: Record<string, unknown>) => ({
      name: 'B',
      appendMode: profileMode,
      sections: {
        request: { rules: [{ enabled: true, name: 'Accept-Language', value: 'fr', ...rule }] },
      },
    });
    expect(ops(b(true, {}))).toEqual(['append']);
    expect(ops(b(undefined, { appendMode: 'comma' }))).toEqual(['append']);
    expect(ops(b(true, { appendMode: false }))).toEqual(['set']);
    expect(ops(b(true, { op: 'set' }))).toEqual(['set']);
    expect(ops(b(undefined, {}))).toEqual(['set']);
  });
});

describe('ModHeader clone Format B', () => {
  it('imports the wrapper with sections and filters', () => {
    const result = load('modheader-b-wrapper.json');
    expect(result.report.format).toBe('modheader-b');
    expect(result.report.errors).toEqual([]);
    const [p] = result.profiles;
    expect(p!.name).toBe('QA tenant');
    expect(p!.requestHeaders.map((h) => [h.name, h.value, h.op, h.enabled])).toEqual([
      ['X-Tenant', 'qa-17', 'set', true],
      ['Accept-Language', 'de-DE', 'append', true],
      ['X-Remove-Me', '', 'remove', true],
      ['Bad Header', 'x', 'set', false],
    ]);
    expect(p!.responseHeaders.map((h) => [h.name, h.enabled])).toEqual([
      ['X-Frame-Options', false],
    ]);
    expect(p!.redirects.map((r) => [r.kind, r.from, r.to])).toEqual([
      ['url', 'https://qa.example.com/config.json', 'http://localhost:8080/config.json'],
      ['regex', '^https://qa\\.example\\.com/img/(.*)', 'https://cdn.example.com/$1'],
    ]);
    expect(p!.filters.map((f) => [f.kind, f.value, f.exclude])).toEqual([
      ['urlFilter', '||qa.example.com^', false],
      ['regex', '/logout$', true],
    ]);
    expect(p!.resourceTypes).not.toContain('image');
    expect(p!.resourceTypes).not.toContain('font');
    expect(p!.resourceTypes).toHaveLength(13);
    expect(p!.methods).toEqual(['get', 'post']);
    expect(result.report.ignoredKeyNames).toEqual(['domain', 'theme']);
    expect(lines(result)).toEqual([
      'warning|QA tenant|1 cookie rule(s) were not imported. Headerbench edits headers: add a Cookie request header instead.',
      'warning|QA tenant|1 CSP rule(s) were not imported. Use the "Remove CSP" response header preset instead.',
      'warning|QA tenant|A tab filter was not imported. Turn on "This tab only" when you activate the profile instead.',
      'warning|QA tenant|Method "trace" is not supported and was skipped.',
      'warning|QA tenant|A filter of unknown type "cookie" was skipped.',
      'warning|QA tenant|Request header Bad Header was imported switched off: "Bad Header" is not a valid header name. Use letters, digits and - _ . ! # $ % & \' * + ^ ` | ~ only.',
    ]);
  });

  it('imports a single profile with sections', () => {
    const result = load('modheader-b-single.json');
    expect(result.report.format).toBe('modheader-b');
    expect(
      result.profiles.map((p) => [p.name, p.requestHeaders[0]?.name, p.resourceTypes, p.methods]),
    ).toEqual([['Feature flags', 'X-Feature-Flag', [], []]]);
  });
});

describe('Headerbench export round-trip', () => {
  it('re-imports an export with fresh profile ids and the same content', () => {
    const original = stateWith([
      profile('Local', {
        env: 'local',
        requestHeaders: [header('X-A', '{{token}}')],
        redirects: [redirect('regex', '^https://a\\.test/(.*)', 'http://localhost/$1')],
        mocks: [mock('urlFilter', '||a.test/me', '{"ok":true}')],
      }),
    ]);
    original.settings.variables = [{ id: 'v1', name: 'token', value: 't' }];
    original.settings.licenseKey = 'HB1.secret.sig';
    const text = exportJson(original, { now: NOW });
    expect(text).not.toContain('HB1.secret');
    expect(JSON.parse(text)).toMatchObject({
      headerbench: 1,
      exportedAt: '2025-10-09T08:53:20.000Z',
    });

    const result = importAny(text, NOW);
    expect(result.report.format).toBe('headerbench');
    expect(result.report.errors).toEqual([]);
    const [p] = result.profiles;
    expect(p!.id).not.toBe(original.profiles[0]!.id);
    const { id: _a, createdAt: _b, updatedAt: _c, ...rest } = p!;
    const { id: _d, createdAt: _e, updatedAt: _f, ...expected } = original.profiles[0]!;
    expect(rest).toEqual(expected);
    expect(result.variables).toEqual(original.settings.variables);
  });

  it('exports only the chosen profiles', () => {
    const state = stateWith([profile('A'), profile('B')]);
    expect(
      JSON.parse(exportJson(state, { profileIds: ['p-b'], now: NOW })).profiles.map(
        (p: { name: string }) => p.name,
      ),
    ).toEqual(['B']);
  });

  it('rejects a newer export version and a missing profiles list', () => {
    expect(importAny('{"headerbench":2,"profiles":[]}', NOW).report.errors[0]).toMatch(/format 2/);
    expect(importAny('{"headerbench":1}', NOW).report.errors).toEqual([
      'The export has no "profiles" list.',
    ]);
  });
});

describe('junk input', () => {
  it.each([
    ['', 'not valid JSON'],
    ['{ nope', 'not valid JSON'],
    ['42', 'not a ModHeader or Headerbench export'],
    ['null', 'not a ModHeader or Headerbench export'],
    ['{"foo":1}', 'not a ModHeader or Headerbench export'],
    ['[1,2,3]', 'not a ModHeader or Headerbench export'],
    ['[]', 'not a ModHeader or Headerbench export'],
  ])('%j is refused without throwing', (text, message) => {
    const result = importAny(text, NOW);
    expect(result.profiles).toEqual([]);
    expect(result.report.errors[0]).toContain(message);
    expect(summarizeImport(result.report)).toMatch(/^Nothing imported: /);
  });

  it('imports nothing when one entry in the file is broken (all-or-nothing)', () => {
    const text = JSON.stringify([
      { title: 'Good', headers: [{ name: 'X-A', value: '1' }] },
      'broken',
    ]);
    const result = importAny(text, NOW);
    expect(result.profiles).toEqual([]);
    expect(result.report.errors).toEqual(['Entry 2 in the file is not a profile object.']);
    const b = importAny(
      JSON.stringify({ modheader: 2, profiles: [{ name: 'x', sections: {} }, 7] }),
      NOW,
    );
    expect(b.profiles).toEqual([]);
    expect(b.report.errors).toEqual(['Profile 2 in the file is not an object.']);
    const hb = importAny(JSON.stringify({ headerbench: 1, profiles: [null] }), NOW);
    expect(hb.report.errors).toEqual(['Profile 1 in the file is not an object.']);
  });

  it('survives wrong field types inside a profile', () => {
    const result = importAny(
      JSON.stringify([
        {
          title: 7,
          headers: 'x',
          respHeaders: [null, { name: 5, value: { a: 1 } }],
          urlFilters: [{ urlRegex: '' }],
        },
      ]),
      NOW,
    );
    expect(result.report.errors).toEqual([]);
    expect(result.profiles[0]).toMatchObject({ name: '7', requestHeaders: [], filters: [] });
    expect(result.profiles[0]!.responseHeaders.map((h) => [h.name, h.op])).toEqual([
      ['5', 'remove'],
    ]);
    expect(lines(result)).toEqual([
      'warning|7|"headers" is not a list, so it was skipped.',
      'warning|7|1 malformed entries in "respHeaders" were skipped.',
    ]);
  });

  it('strips a byte-order mark and refuses huge files', () => {
    expect(importAny(`\uFEFF${fixture('modheader-b-single.json')}`, NOW).profiles).toHaveLength(1);
    expect(importAny(' '.repeat(5 * 1024 * 1024 + 1), NOW).report.errors[0]).toMatch(
      /larger than 5 MB/,
    );
  });

  it('reports getters that throw instead of crashing', () => {
    const evil = [{ title: 'x', headers: [] }];
    Object.defineProperty(evil[0], 'respHeaders', {
      enumerable: true,
      get: () => {
        throw new Error('boom');
      },
    });
    // Parsed JSON cannot carry getters, so stand in for JSON.parse to reach the safety net.
    const parse = JSON.parse;
    JSON.parse = () => evil;
    try {
      expect(importAny('[]', NOW).report.errors).toEqual(['The file could not be read: boom']);
    } finally {
      JSON.parse = parse;
    }
  });
});

describe('regexToFilter', () => {
  it.each([
    ['.*://api\\.example\\.com/.*', 'api.example.com'],
    ['https?://api.example.com.*', 'api.example.com'],
    ['(https?)://.*\\.example\\.com/.*$', 'example.com'],
    ['.*://api\\.example\\.com', 'api.example.com'],
    ['.*://localhost/.*', 'localhost'],
  ])('%s → domain %s', (regex, domain) => {
    expect(regexToFilter(regex)).toMatchObject({ kind: 'domain', value: domain });
  });

  it.each([
    ['^https?://localhost:3000/.*', '||localhost:3000/'],
    ['.*://api\\.example\\.com:8443/.*', '||api.example.com:8443/'],
    ['.*://.*\\.example\\.com:8443.*', '||example.com:8443/'],
    ['^https://api\\.example\\.com/', '|https://api.example.com/'],
    ['http:\\/\\/localhost\\.test:8080\\/.*', '|http://localhost.test:8080/'],
    ['^http://127\\.0\\.0\\.1:5173/.*$', '|http://127.0.0.1:5173/'],
  ])('keeps the port or the single scheme: %s → urlFilter %s', (regex, value) => {
    expect(regexToFilter(regex)).toMatchObject({ kind: 'urlFilter', value });
  });

  it.each([
    ['^https://x\\.com/$', '|https://x.com/|'],
    ['^http://localhost:3000/$', '|http://localhost:3000/|'],
    ['https:\\/\\/api\\.example\\.com\\/$', '|https://api.example.com/|'],
  ])('keeps a $-anchored root address exact: %s → urlFilter %s', (regex, value) => {
    const filter = regexToFilter(regex);
    expect(filter).toMatchObject({ kind: 'urlFilter', value });
    expect(checkFilter({ id: 'f', enabled: true, kind: 'urlFilter', value, exclude: false })).toBe(
      null,
    );
  });

  it('imports a root-address regex as an exact filter that asks only for that host', () => {
    const result = importAny(
      JSON.stringify([
        {
          version: 2,
          title: 'Home',
          headers: [{ enabled: true, name: 'X-Debug', value: '1' }],
          urlFilters: [{ enabled: true, urlRegex: '^https://x\\.com/$' }],
        },
      ]),
      NOW,
    );
    const p = result.profiles[0]!;
    expect(p.filters).toMatchObject([{ kind: 'urlFilter', value: '|https://x.com/|' }]);
    expect(lines(result)).toContain(
      'info|Home|Filter ^https://x\\.com/$ became the URL filter |https://x.com/| (only that exact address), so Headerbench asks for access to that site instead of every site.',
    );
    expect(originsFor(p)).toEqual(['https://x.com/*']);
    const result2 = compile(stateWith([p]), { pro: false, now: NOW });
    expect(result2.dynamic[0]?.condition.urlFilter).toBe('|https://x.com/|');
  });

  it.each([
    // `$` after the host alone matches no URL (Chrome always has a path), so nothing to widen.
    '^https://x\\.com$',
    // Any scheme or subdomains: `||x.com/|` would also match other hosts' root addresses.
    '.*://x\\.com/$',
    '^https?://x\\.com/$',
    '^https://(.*\\.)?x\\.com/$',
  ])('keeps the $-anchored %s as a regex', (regex) => {
    expect(regexToFilter(regex)).toBeNull();
  });

  it('still widens a $-anchored "any path" regex, and ignores an escaped $', () => {
    expect(regexToFilter('^https://x\\.com/.*$')).toMatchObject({ value: '|https://x.com/' });
    expect(regexToFilter('^https://x\\.com/\\$')).toBeNull();
  });

  it.each([
    '.*example\\.com.*',
    '.*://api\\.example\\.com/v1/.*',
    '^https://[a-z]+\\.example\\.com/',
    'ftp://x\\.test/',
    // One scheme plus subdomains has no urlFilter form that is not wider than the regex.
    '^https://.*\\.example\\.com/.*',
  ])('keeps %s as a regex', (regex) => {
    expect(regexToFilter(regex)).toBeNull();
  });

  it('reports what a port-qualified regex became and asks only for that host', () => {
    const result = importAny(
      JSON.stringify([
        {
          version: 2,
          title: 'Local',
          headers: [{ enabled: true, name: 'X-Debug', value: '1' }],
          urlFilters: [{ enabled: true, urlRegex: '^https?://localhost:3000/.*' }],
        },
      ]),
      NOW,
    );
    const p = result.profiles[0]!;
    expect(p.filters).toMatchObject([{ kind: 'urlFilter', value: '||localhost:3000/' }]);
    expect(result.report.lines).toContainEqual({
      level: 'info',
      profile: 'Local',
      message:
        'Filter ^https?://localhost:3000/.* became the URL filter ||localhost:3000/ (port 3000 only, any scheme, also subdomains), so Headerbench asks for access to that site instead of every site.',
    });
    expect(originsFor(p)).toEqual([
      'http://*.localhost/*',
      'http://localhost/*',
      'https://*.localhost/*',
      'https://localhost/*',
    ]);
  });

  it('gives a single-scheme filter only that scheme’s permission', () => {
    const result = importAny(
      JSON.stringify([
        {
          version: 2,
          title: 'Prod',
          headers: [{ enabled: true, name: 'X-Debug', value: '1' }],
          urlFilters: [{ enabled: true, urlRegex: '^https://api\\.example\\.com/.*' }],
        },
      ]),
      NOW,
    );
    expect(originsFor(result.profiles[0]!)).toEqual(['https://api.example.com/*']);
  });
});
