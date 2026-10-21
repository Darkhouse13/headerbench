import { describe, expect, it } from 'vitest';
import { MIGRATIONS, SCHEMA_VERSION, defaultState, migrate, tryMigrate } from '../src/index.js';
import { header, profile, stateWith } from './helpers.js';

const NOW = 1_760_000_000_000;

describe('migrate', () => {
  it('keeps a valid v1 state unchanged', () => {
    const state = stateWith([profile('Staging', { requestHeaders: [header('X-A', '1')] })]);
    state.settings.variables = [{ id: 'v1', name: 'token', value: 'abc' }];
    expect(migrate(JSON.parse(JSON.stringify(state)), NOW)).toEqual(state);
  });

  it('repairs v0-shaped junk field by field', () => {
    const raw = {
      profiles: [
        {
          id: 'keep',
          name: '  ',
          color: 'red',
          env: 'production',
          requestHeaders: [
            { name: ' X-Old ', value: 1, op: 'replace' },
            'junk',
            null,
            { id: 'dup', name: 'A' },
            { id: 'dup', name: 'B' },
          ],
          responseHeaders: 'nope',
          filters: [
            { kind: 'domain', value: 'example.com' },
            { kind: 'weird', value: '/x' },
            { value: '' },
          ],
          resourceTypes: ['xmlhttprequest', 'bogus', 'xmlhttprequest'],
          methods: ['GET', 'post'],
          redirects: [{ from: 'https://a.test/', to: 'https://b.test/' }, { from: '' }],
          blocks: [{ pattern: '||ads.test^', kind: 'regex' }],
          mocks: [{ pattern: '||api.test', body: '{}', contentType: '' }],
        },
        42,
        { id: 'keep', name: 'Second' },
      ],
      settings: {
        paused: 'yes',
        activations: [
          { profileId: 'keep', tabId: 3.7, pauseAt: 'later' },
          { profileId: 'keep', tabId: 3, pauseAt: null },
          { profileId: 'missing', tabId: null, pauseAt: null },
        ],
        variables: [
          { name: '1bad', value: 'x' },
          { name: 'ok', value: 'y' },
          { name: 'ok', value: 'z' },
        ],
        theme: 'neon',
        trialStartedAt: '2026',
        licenseKey: '',
        review: {
          activeDays: ['2026-10-01', 'x', '2026-10-02', '2026-10-03', '2026-10-04'],
          state: 'rated',
        },
      },
    };
    const result = tryMigrate(raw, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { profiles, settings } = result.state;
    expect(result.state.schemaVersion).toBe(SCHEMA_VERSION);
    expect(profiles).toHaveLength(2);
    const [p, second] = profiles;
    expect(p).toMatchObject({
      id: 'keep',
      name: 'Profile 1',
      badge: 'P',
      color: '#1a73e8',
      env: 'none',
      createdAt: NOW,
      updatedAt: NOW,
      responseHeaders: [],
      resourceTypes: ['xmlhttprequest'],
      methods: ['post'],
    });
    expect(p!.requestHeaders.map((h) => [h.name, h.value, h.op, h.enabled])).toEqual([
      ['X-Old', '', 'set', true],
      ['A', '', 'set', true],
      ['B', '', 'set', true],
    ]);
    expect(new Set(p!.requestHeaders.map((h) => h.id)).size).toBe(3);
    expect(p!.filters.map((f) => [f.kind, f.value])).toEqual([
      ['domain', 'example.com'],
      ['urlFilter', '/x'],
    ]);
    expect(p!.redirects).toHaveLength(1);
    expect(p!.redirects[0]).toMatchObject({ kind: 'url', from: 'https://a.test/' });
    expect(p!.blocks[0]?.kind).toBe('regex');
    expect(p!.mocks[0]?.contentType).toBe('application/json');
    expect(second!.id).not.toBe('keep');
    expect(second!.name).toBe('Second');
    expect(settings).toEqual({
      paused: false,
      activations: [{ profileId: 'keep', tabId: 3, pauseAt: null }],
      variables: [{ id: expect.any(String), name: 'ok', value: 'y' }],
      sync: false,
      theme: 'system',
      trialStartedAt: null,
      licenseKey: null,
      review: { activeDays: ['2026-10-02', '2026-10-03', '2026-10-04'], state: 'rated' },
    });
  });

  it('fails on non-objects and newer schemas, and migrate falls back to a fresh state', () => {
    expect(tryMigrate('corrupt', NOW)).toEqual({ ok: false, reason: 'not_an_object' });
    expect(tryMigrate([1, 2], NOW)).toEqual({ ok: false, reason: 'not_an_object' });
    expect(tryMigrate(null, NOW)).toEqual({ ok: false, reason: 'not_an_object' });
    expect(tryMigrate({ schemaVersion: SCHEMA_VERSION + 1, profiles: [] }, NOW)).toEqual({
      ok: false,
      reason: 'newer_schema',
    });
    expect(migrate(undefined, NOW)).toEqual(defaultState());
  });

  it('turns an empty object into the default state', () => {
    expect(migrate({}, NOW)).toEqual(defaultState());
  });

  it('has a ladder step for every version below the current one', () => {
    for (let v = 0; v < SCHEMA_VERSION; v++) expect(typeof MIGRATIONS[v], `v${v}`).toBe('function');
    expect(MIGRATIONS[SCHEMA_VERSION]).toBeUndefined();
  });

  it('leaves data from a newer Headerbench untouched, so the caller can keep it', () => {
    const newer = { schemaVersion: SCHEMA_VERSION + 1, profiles: [{ id: 'x', future: true }] };
    const copy = structuredClone(newer);
    expect(tryMigrate(newer, NOW)).toEqual({ ok: false, reason: 'newer_schema' });
    expect(newer).toEqual(copy);
    expect(tryMigrate({ schemaVersion: SCHEMA_VERSION + 0.5 }, NOW)).toMatchObject({
      reason: 'newer_schema',
    });
  });

  it('treats a missing or negative version as v0', () => {
    const p = profile('Old');
    expect(tryMigrate({ schemaVersion: -3, profiles: [p] }, NOW)).toMatchObject({
      ok: true,
      state: { schemaVersion: SCHEMA_VERSION, profiles: [p] },
    });
  });
});
