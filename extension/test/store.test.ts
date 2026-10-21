import { SCHEMA_VERSION, defaultState } from '@headerbench/core';
import { describe, expect, it } from 'vitest';
import { BACKUP_MAX_BYTES, KEYS, StateError, StateStore } from '../src/sw/store';
import { createChromeFake } from './chrome-fake';
import { NOW, header, profile, stateWith } from './helpers';

function storeWith(data: Record<string, unknown> = {}) {
  const { api } = createChromeFake();
  api.storage.local.data = data;
  const area = api.storage.local;
  return { store: new StateStore(area as unknown as chrome.storage.StorageArea, () => NOW), area };
}

describe('StateStore', () => {
  it('starts from the default state on a fresh install without writing', async () => {
    const { store, area } = storeWith();
    const loaded = await store.load();
    expect(loaded.state).toEqual(defaultState());
    expect(loaded.rev).toBe(0);
    expect(area.writes).toBe(0);
  });

  it('saves with a rising rev and keeps the previous state as the backup', async () => {
    const { store, area } = storeWith();
    const first = stateWith([profile('One')]);
    const second = stateWith([profile('Two')]);
    expect((await store.save(first)).rev).toBe(1);
    expect((await store.save(second)).rev).toBe(2);
    expect(area.data[KEYS.state]).toEqual(second);
    expect(area.data[KEYS.backup]).toEqual(first);
    expect(area.data[KEYS.rev]).toBe(2);
  });

  it('keeps blank rows the user just added (no repair on save)', async () => {
    const { store } = storeWith();
    const p = profile('Blank rows', {
      requestHeaders: [header('', '')],
      filters: [{ id: 'f1', enabled: true, kind: 'domain', value: '', exclude: false }],
    });
    const saved = await store.save(stateWith([p]));
    expect(saved.state.profiles[0]?.filters).toHaveLength(1);
    expect(saved.state.profiles[0]?.requestHeaders).toHaveLength(1);
  });

  it('rejects malformed state with a reason and writes nothing', async () => {
    const { store, area } = storeWith();
    const bad = { ...stateWith([]), profiles: [{ id: 'x', name: 3 }] };
    await expect(store.save(bad as never)).rejects.toThrow(StateError);
    await expect(store.save(bad as never)).rejects.toThrow(/state.profiles\[0\]/);
    expect(area.writes).toBe(0);
  });

  it('drops activations of deleted profiles and duplicate activations', async () => {
    const { store } = storeWith();
    const p = profile('Kept');
    const saved = await store.save(
      stateWith([p], {
        activations: [
          { profileId: p.id, tabId: 4, pauseAt: null },
          { profileId: p.id, tabId: 5, pauseAt: null },
          { profileId: p.id, tabId: 4, pauseAt: NOW },
          { profileId: 'gone', tabId: null, pauseAt: null },
        ],
      }),
    );
    expect(saved.state.settings.activations).toEqual([
      { profileId: p.id, tabId: 4, pauseAt: null },
      { profileId: p.id, tabId: 5, pauseAt: null },
    ]);
  });

  it('migrates an older schema and persists the result', async () => {
    const { store, area } = storeWith({
      [KEYS.state]: {
        profiles: [{ name: 'Legacy', requestHeaders: [{ name: 'X-A', value: '1' }] }],
      },
    });
    const loaded = await store.load();
    expect(store.recovery).toBe('migrated');
    expect(loaded.state.schemaVersion).toBe(SCHEMA_VERSION);
    expect(loaded.state.profiles[0]?.name).toBe('Legacy');
    expect((area.data[KEYS.state] as { schemaVersion: number }).schemaVersion).toBe(SCHEMA_VERSION);
  });

  it('recovers from the backup when the state is corrupt and keeps the raw blob', async () => {
    const good = stateWith([profile('From backup')]);
    const { store, area } = storeWith({
      [KEYS.state]: 'garbage{',
      [KEYS.backup]: good,
      [KEYS.rev]: 7,
    });
    const loaded = await store.load();
    expect(store.recovery).toBe('backup');
    expect(loaded.state.profiles[0]?.name).toBe('From backup');
    expect(loaded.rev).toBe(8);
    expect(area.data[KEYS.corrupt]).toBe('garbage{');
    expect(await store.corruptData()).toBe('garbage{');
    await store.discardCorruptData();
    expect(await store.corruptData()).toBeUndefined();
  });

  it('starts fresh when state and backup are both unreadable, keeping the raw blob', async () => {
    const { store, area } = storeWith({ [KEYS.state]: 42, [KEYS.backup]: null });
    const loaded = await store.load();
    expect(store.recovery).toBe('fresh');
    expect(loaded.state.profiles).toEqual([]);
    expect(area.data[KEYS.corrupt]).toBe(42);
  });

  it('repairs a damaged current-schema state in place and keeps the raw blob', async () => {
    const good = stateWith([profile('Backup copy')]);
    const damaged = {
      ...stateWith([profile('Current', { requestHeaders: [header('X-A', '1')] })]),
      settings: { ...stateWith([]).settings, theme: 'neon', review: null },
    };
    const { store, area } = storeWith({
      [KEYS.state]: damaged,
      [KEYS.backup]: good,
      [KEYS.rev]: 3,
    });
    const loaded = await store.load();
    expect(store.recovery).toBe('repaired');
    expect(loaded.state.profiles.map((p) => p.name)).toEqual(['Current']);
    expect(loaded.state.settings.theme).toBe('system');
    expect(loaded.rev).toBe(4);
    expect(area.data[KEYS.corrupt]).toEqual(damaged);
    expect(area.data[KEYS.backup]).toEqual(good);
  });

  it('uses the backup when repairing would lose profiles', async () => {
    const good = stateWith([profile('One'), profile('Two')]);
    const damaged = { ...stateWith([]), profiles: [good.profiles[0], 'not a profile'] };
    const { store, area } = storeWith({ [KEYS.state]: damaged, [KEYS.backup]: good });
    const loaded = await store.load();
    expect(store.recovery).toBe('backup');
    expect(loaded.state.profiles.map((p) => p.name)).toEqual(['One', 'Two']);
    expect(area.data[KEYS.corrupt]).toEqual(damaged);
  });

  it('keeps no backup copy of a state over 4 MB', async () => {
    const { store, area } = storeWith();
    const small = stateWith([profile('Small')]);
    await store.save(small);
    await store.save(stateWith([profile('Second')]));
    expect(area.data[KEYS.backup]).toEqual(small);
    const huge = stateWith([
      profile('Huge', {
        mocks: [
          {
            id: 'm',
            enabled: true,
            kind: 'urlFilter',
            pattern: '/x',
            contentType: 'text/plain',
            body: 'y'.repeat(BACKUP_MAX_BYTES),
            comment: '',
          },
        ],
      }),
    ]);
    await store.save(huge);
    expect(area.data[KEYS.backup]).toBeUndefined();
    expect(area.data[KEYS.state]).toEqual(huge);
    await store.save(stateWith([profile('After')]));
    expect(area.data[KEYS.backup]).toBeUndefined();
  });

  it('turns Chrome’s quota error into a plain StateError and keeps the stored state', async () => {
    const { store, area } = storeWith();
    const first = stateWith([profile('First')]);
    await store.save(first);
    area.quotaBytes = area.bytes() + 100;
    const error = await store.save(stateWith([profile('x'.repeat(500))])).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StateError);
    expect(error).toMatchObject({
      reason: 'storage_full',
      message:
        "Headerbench's storage is full (Chrome allows 10 MB). Remove large mocks or profiles.",
    });
    expect(area.data[KEYS.state]).toEqual(first);
  });

  it('does not overwrite data written by a newer Headerbench without keeping it', async () => {
    const newer = { schemaVersion: SCHEMA_VERSION + 1, profiles: [], settings: {} };
    const { store, area } = storeWith({ [KEYS.state]: newer });
    await store.load();
    expect(area.data[KEYS.corrupt]).toEqual(newer);
  });
});
