import { describe, expect, it } from 'vitest';
import {
  APPENDABLE_REQUEST_HEADERS,
  CORS_PRESET,
  HEADER_PRESETS,
  PROFILE_COLORS,
  REQUEST_HEADER_NAMES,
  RESPONSE_HEADER_NAMES,
  USER_AGENT_PRESETS,
  badgeFor,
  base64Decode,
  base64Encode,
  base64UrlEncode,
  bytesToHex,
  checkHeaderMod,
  checkHeaderName,
  checkHeaderValue,
  defaultState,
  exportFileName,
  hexToBytes,
  newHeaderMod,
  newProfile,
  profileIssues,
  substituteVariables,
  utf8Decode,
  utf8Encode,
  valuePresetsFor,
  variableRefs,
} from '../src/index.js';
import { block, filter, header, mock, profile, redirect } from './helpers.js';

describe('model factories', () => {
  it('creates a default state', () => {
    expect(defaultState()).toEqual({
      schemaVersion: 1,
      profiles: [],
      settings: {
        paused: false,
        activations: [],
        variables: [],
        sync: false,
        theme: 'system',
        trialStartedAt: null,
        licenseKey: null,
        review: { activeDays: [], state: 'pending' },
      },
    });
  });

  it('creates profiles with unique ids, next free colour and numbered names', () => {
    const first = newProfile({ now: 5 });
    const second = newProfile({ existing: [first], now: 6 });
    expect(first).toMatchObject({
      name: 'Profile 1',
      badge: 'P',
      color: PROFILE_COLORS[0],
      env: 'none',
      createdAt: 5,
      updatedAt: 5,
      resourceTypes: [],
      methods: [],
    });
    expect(second).toMatchObject({ name: 'Profile 2', color: PROFILE_COLORS[1] });
    expect(second.id).not.toBe(first.id);
    expect(newProfile({ name: '  staging ' }).name).toBe('staging');
    const all = PROFILE_COLORS.map((color) => ({ ...first, color }));
    expect(newProfile({ existing: all }).color).toBe(PROFILE_COLORS[0]);
  });

  it('derives badges from names', () => {
    expect(badgeFor('staging')).toBe('S');
    expect(badgeFor('  2nd env')).toBe('2');
    expect(badgeFor('élan')).toBe('É');
    expect(badgeFor('---')).toBe('H');
  });

  it('creates header rows', () => {
    expect(newHeaderMod({ name: 'X-A' })).toMatchObject({
      enabled: true,
      name: 'X-A',
      value: '',
      op: 'set',
      comment: '',
    });
  });
});

describe('profileIssues', () => {
  it('lists every invalid item, enabled or not', () => {
    const p = profile('P', {
      requestHeaders: [
        header('Bad Name', '1', 'set', { enabled: false }),
        header('X-Ok', '1'),
        header('X-Remove', 'a\nb', 'remove'),
      ],
      responseHeaders: [header('X-R', 'a\nb')],
      filters: [filter('urlFilter', '||*bad')],
      redirects: [
        redirect('url', 'https://a.test/', ''),
        redirect('url', 'https://a.test/', '{{host}}/x'),
      ],
      blocks: [block('regex', '(?=x)')],
      mocks: [mock('regex', 'ok', '{}', 'nope')],
    });
    expect(profileIssues(p).map((i) => i.itemId)).toEqual(
      ['h1', 'h4', 'f5', 'r6', 'b8', 'm9'].map((id) => id),
    );
    expect(checkHeaderMod(header('X-Remove', 'a\nb', 'remove'))).toBeNull();
  });
});

describe('variables', () => {
  it('finds and substitutes placeholders', () => {
    expect(variableRefs('{{a}} {{ b }} {{a}} {{1x}}')).toEqual(['a', 'b']);
    expect(
      substituteVariables('Bearer {{token}} {{other}}', [{ id: '1', name: 'token', value: '$1&' }]),
    ).toEqual({ text: 'Bearer $1& {{other}}', unresolved: ['other'] });
  });
});

describe('encoding', () => {
  it('round-trips base64 and base64url', () => {
    for (const text of ['', 'a', 'ab', 'abc', 'héllo 🎉']) {
      const bytes = utf8Encode(text);
      expect(base64Encode(bytes)).toBe(globalThis.btoa(String.fromCharCode(...bytes)));
      expect(utf8Decode(base64Decode(base64Encode(bytes)))).toBe(text);
      expect(utf8Decode(base64Decode(base64UrlEncode(bytes)))).toBe(text);
    }
    expect(base64UrlEncode(new Uint8Array([251, 255]))).toBe('-_8');
    expect(() => base64Decode('a')).toThrow();
    expect(() => base64Decode('a$')).toThrow();
    expect(() => utf8Decode(new Uint8Array([0xff]))).toThrow();
  });

  it('round-trips hex', () => {
    expect(bytesToHex(hexToBytes('00ff10'))).toBe('00ff10');
    expect(() => hexToBytes('abc')).toThrow();
    expect(() => hexToBytes('zz')).toThrow();
  });
});

describe('presets', () => {
  it('only offers valid header names and values', () => {
    for (const name of [
      ...REQUEST_HEADER_NAMES,
      ...RESPONSE_HEADER_NAMES,
      ...APPENDABLE_REQUEST_HEADERS,
    ])
      expect(checkHeaderName(name)).toBeNull();
    for (const preset of HEADER_PRESETS) {
      for (const row of preset.rows) {
        expect(checkHeaderName(row.name)).toBeNull();
        expect(row.note.length).toBeGreaterThan(10);
      }
    }
    for (const ua of USER_AGENT_PRESETS) expect(checkHeaderValue(ua.value)).toBeNull();
    expect(new Set(USER_AGENT_PRESETS.map((p) => p.id)).size).toBe(USER_AGENT_PRESETS.length);
  });

  it('looks up value presets by header name', () => {
    expect(valuePresetsFor(' user-agent ')).toBe(USER_AGENT_PRESETS);
    expect(valuePresetsFor('Accept-Language').length).toBeGreaterThan(3);
    expect(valuePresetsFor('X-Unknown')).toEqual([]);
    expect(CORS_PRESET.rows[0]).toMatchObject({ name: 'Access-Control-Allow-Origin', value: '*' });
  });
});

describe('exportFileName', () => {
  it('uses the UTC date', () => {
    expect(exportFileName(Date.UTC(2026, 9, 11, 23, 0))).toBe('headerbench-2026-10-11.json');
  });
});
