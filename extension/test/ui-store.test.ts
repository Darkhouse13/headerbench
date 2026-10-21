import type { State } from '@headerbench/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Reply, Request, RequestType, Snapshot } from '../src/messages';
import type { Platform } from '../src/ui/platform';
import { rebase } from '../src/ui/rebase';
import { Store } from '../src/ui/store';
import { NOW, header, profile, stateWith } from './helpers';

function snap(rev: number, state: State): Snapshot {
  return {
    rev,
    state,
    pro: { pro: false, source: null, trialEndsAt: null, licenseExpiresAt: null, plan: null },
    warnings: [],
    stats: { dynamic: 0, session: 0, unsafe: 0, regex: 0 },
    ruleError: null,
    sync: { active: false, error: null, bytes: 0, lastSyncedAt: null },
    licenseRefreshError: null,
    hasCorruptData: false,
    version: '1.0.3',
  };
}

interface Pending {
  req: Request;
  resolve: (reply: Reply<RequestType>) => void;
}

/**
 * A scripted service worker: every request waits in `pending` until the test answers it, so the
 * order of replies is under the test's control.
 */
function scripted(initial: Snapshot) {
  const pending: Pending[] = [];
  let changeListener: (() => void) | null = null;
  const platform = {
    send: (req: Request) =>
      new Promise<Reply<RequestType>>((resolve) => pending.push({ req, resolve })),
    onStateChange(listener: () => void) {
      changeListener = listener;
      return () => undefined;
    },
    now: () => NOW,
  } as unknown as Platform;
  /** Answers the oldest pending request. */
  const answer = async (reply: (req: Request) => Reply<RequestType>): Promise<Request> => {
    await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0));
    const next = pending.shift() as Pending;
    next.resolve(reply(next.req));
    await Promise.resolve();
    return next.req;
  };
  const store = new Store(platform, 300);
  const ready = (async () => {
    const init = store.init();
    await answer(() => ({ ok: true, data: initial }));
    await init;
  })();
  return {
    store,
    pending,
    answer,
    ready,
    changed: () => changeListener?.(),
    ok: (data: unknown) => () => ({ ok: true, data }) as Reply<RequestType>,
  };
}

const rename = (state: State, id: string, name: string): State => ({
  ...state,
  profiles: state.profiles.map((p) => (p.id === id ? { ...p, name } : p)),
});

describe('three-way rebase', () => {
  const a = profile('A', { requestHeaders: [header('X-A', '1')] });
  const b = profile('B');
  const base = stateWith([a, b]);

  it('keeps local-only and remote-only changes, and both sides’ new profiles', () => {
    const c = profile('C');
    const d = profile('D');
    const renamed = rename(base, a.id, 'A local');
    const local = { ...renamed, profiles: [...renamed.profiles, c] };
    const changed = rename(base, b.id, 'B remote');
    const remote = { ...changed, profiles: [...changed.profiles, d] };
    const { state, clashes } = rebase(base, local, remote);
    expect(state.profiles.map((p) => p.name)).toEqual(['A local', 'B remote', 'C', 'D']);
    expect(clashes).toEqual([]);
  });

  it('lets local win when both changed one profile, and reports the clash', () => {
    const { state, clashes } = rebase(
      base,
      rename(base, a.id, 'A local'),
      rename(base, a.id, 'A remote'),
    );
    expect(state.profiles[0]?.name).toBe('A local');
    expect(clashes).toEqual(['A local']);
  });

  it('applies deletions from either side unless the other side edited the profile', () => {
    const deletedRemotely = { ...base, profiles: [a] };
    expect(rebase(base, base, deletedRemotely).state.profiles.map((p) => p.name)).toEqual(['A']);
    const editedHere = rename(base, b.id, 'B edited');
    expect(rebase(base, editedHere, deletedRemotely).state.profiles.map((p) => p.name)).toEqual([
      'A',
      'B edited',
    ]);
  });

  it('merges settings field by field and activations per profile', () => {
    const local: State = {
      ...base,
      settings: { ...base.settings, theme: 'dark' },
    };
    const remote: State = {
      ...base,
      settings: {
        ...base.settings,
        paused: true,
        activations: [{ profileId: b.id, tabId: 4, pauseAt: null }],
      },
    };
    const { state, clashes } = rebase(base, local, remote);
    expect(state.settings.theme).toBe('dark');
    expect(state.settings.paused).toBe(true);
    expect(state.settings.activations).toEqual([{ profileId: b.id, tabId: 4, pauseAt: null }]);
    expect(clashes).toEqual([]);
    const both = rebase(base, local, {
      ...remote,
      settings: { ...remote.settings, theme: 'light' },
    });
    expect(both.state.settings.theme).toBe('dark');
    expect(both.clashes).toEqual(['settings']);
  });

  it('keeps a local reorder', () => {
    const local = { ...base, profiles: [b, a] };
    const remote = rename(base, a.id, 'A remote');
    expect(rebase(base, local, remote).state.profiles.map((p) => p.name)).toEqual([
      'B',
      'A remote',
    ]);
  });

  it('keeps a new profile after its nearest surviving predecessor', () => {
    const d = profile('D');
    const { state } = rebase(base, { ...base, profiles: [a, b, d] }, { ...base, profiles: [a] });
    expect(state.profiles.map((p) => p.name)).toEqual(['A', 'D']);
    const first = rebase(base, { ...base, profiles: [d, a, b] }, rename(base, b.id, 'B remote'));
    expect(first.state.profiles.map((p) => p.name)).toEqual(['D', 'A', 'B remote']);
  });

  it('keeps a profile deleted here when another window edited it, and says so', () => {
    const { state, clashes, kept } = rebase(
      base,
      { ...base, profiles: [a] },
      rename(base, b.id, 'B remote'),
    );
    expect(state.profiles.map((p) => p.name)).toEqual(['A', 'B remote']);
    expect(clashes).toEqual([]);
    expect(kept).toEqual(['B remote']);
    expect(rebase(base, { ...base, profiles: [a] }, base).state.profiles).toEqual([a]);
  });
});

describe('UI store', () => {
  const a = profile('A');
  const b = profile('B');
  const initial = snap(1, stateWith([a, b]));

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('applies edits at once and saves them in one request after the pause', async () => {
    const t = scripted(initial);
    await t.ready;
    t.store.update((s) => rename(s, a.id, 'A1'));
    t.store.update((s) => rename(s, a.id, 'A2'));
    expect(t.store.state.profiles[0]?.name).toBe('A2');
    expect(t.store.dirty).toBe(true);
    await vi.advanceTimersByTimeAsync(299);
    expect(t.pending).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    const req = await t.answer((r) => ({
      ok: true,
      data: snap(2, (r as Extract<Request, { type: 'saveState' }>).state),
    }));
    expect(req).toMatchObject({ type: 'saveState', rev: 1 });
    expect(t.pending).toHaveLength(0);
    await vi.waitFor(() => expect(t.store.dirty).toBe(false));
    expect(t.store.snapshot?.rev).toBe(2);
  });

  it('flushes pending edits before another request', async () => {
    const t = scripted(initial);
    await t.ready;
    t.store.update((s) => rename(s, a.id, 'A1'));
    const call = t.store.call({ type: 'setPaused', paused: true });
    const save = await t.answer((r) => ({
      ok: true,
      data: snap(2, (r as Extract<Request, { type: 'saveState' }>).state),
    }));
    expect(save.type).toBe('saveState');
    const paused = await t.answer(() => ({
      ok: true,
      data: snap(3, { ...rename(initial.state, a.id, 'A1') }),
    }));
    expect(paused.type).toBe('setPaused');
    await call;
    expect(t.store.dirty).toBe(false);
    expect(t.store.snapshot?.rev).toBe(3);
  });

  it('keeps edits when a save fails, shows why, and saves them on the next try', async () => {
    const t = scripted(initial);
    await t.ready;
    t.store.update((s) => rename(s, a.id, 'Kept'));
    const flushed = t.store.flush();
    await t.answer(() => ({
      ok: false,
      code: 'storage_full',
      error: "Headerbench's storage is full (Chrome allows 10 MB).",
    }));
    expect(await flushed).toBe(false);
    expect(t.store.state.profiles[0]?.name).toBe('Kept');
    expect(t.store.dirty).toBe(true);
    expect(t.store.toasts.map((x) => [x.tone, x.message])).toEqual([
      ['error', "Headerbench's storage is full (Chrome allows 10 MB)."],
    ]);
    const retry = t.store.flush();
    const req = await t.answer((r) => ({
      ok: true,
      data: snap(2, (r as Extract<Request, { type: 'saveState' }>).state),
    }));
    expect((req as Extract<Request, { type: 'saveState' }>).state.profiles[0]?.name).toBe('Kept');
    expect(await retry).toBe(true);
    expect(t.store.dirty).toBe(false);
  });

  it('rebases onto the newer state after a conflict and saves again', async () => {
    const t = scripted(initial);
    await t.ready;
    t.store.update((s) => rename(s, a.id, 'A here'));
    const flushed = t.store.flush();
    // Another window renamed B and saved first.
    const other = rename(initial.state, b.id, 'B there');
    await t.answer(() => ({
      ok: false,
      code: 'conflict',
      error: 'Changed elsewhere.',
      snapshot: snap(5, other),
    }));
    const second = (await t.answer((r) => ({
      ok: true,
      data: snap(6, (r as Extract<Request, { type: 'saveState' }>).state),
    }))) as Extract<Request, { type: 'saveState' }>;
    expect(second.rev).toBe(5);
    expect(second.state.profiles.map((p) => p.name)).toEqual(['A here', 'B there']);
    expect(await flushed).toBe(true);
    expect(t.store.toasts).toEqual([]);
  });

  it('says so when another window changed the same profile, and keeps the local edit', async () => {
    const t = scripted(initial);
    await t.ready;
    t.store.update((s) => rename(s, a.id, 'A here'));
    const flushed = t.store.flush();
    await t.answer(() => ({
      ok: false,
      code: 'conflict',
      error: 'Changed elsewhere.',
      snapshot: snap(5, rename(initial.state, a.id, 'A there')),
    }));
    const second = (await t.answer((r) => ({
      ok: true,
      data: snap(6, (r as Extract<Request, { type: 'saveState' }>).state),
    }))) as Extract<Request, { type: 'saveState' }>;
    expect(second.state.profiles[0]?.name).toBe('A here');
    await flushed;
    expect(t.store.toasts.map((x) => x.message)).toEqual([
      'Another window changed A here at the same time. Your edits were kept.',
    ]);
  });

  it('says a profile deleted here was kept when another window edited it', async () => {
    const t = scripted(initial);
    await t.ready;
    t.store.update((s) => ({ ...s, profiles: s.profiles.filter((p) => p.id !== b.id) }));
    const flushed = t.store.flush();
    await t.answer(() => ({
      ok: false,
      code: 'conflict',
      error: 'Changed elsewhere.',
      snapshot: snap(5, rename(initial.state, b.id, 'B there')),
    }));
    await t.answer((r) => ({
      ok: true,
      data: snap(6, (r as Extract<Request, { type: 'saveState' }>).state),
    }));
    expect(await flushed).toBe(true);
    expect(t.store.state.profiles.map((p) => p.name)).toEqual(['A', 'B there']);
    expect(t.store.toasts.map((x) => x.message)).toEqual([
      'Another window changed B there, so it was kept.',
    ]);
  });

  it('runs a refresh that arrived during a save once the save settles', async () => {
    const t = scripted(initial);
    await t.ready;
    t.store.update((s) => rename(s, a.id, 'A1'));
    const flushed = t.store.flush();
    await vi.waitFor(() => expect(t.pending).toHaveLength(1));
    t.changed();
    await Promise.resolve();
    expect(t.pending.map((p) => p.req.type)).toEqual(['saveState']);
    await t.answer((r) => ({
      ok: true,
      data: snap(2, (r as Extract<Request, { type: 'saveState' }>).state),
    }));
    await flushed;
    const refresh = await t.answer(() => ({
      ok: true,
      data: snap(3, {
        ...rename(initial.state, a.id, 'A1'),
        settings: { ...initial.state.settings, paused: true },
      }),
    }));
    expect(refresh.type).toBe('getState');
    await vi.waitFor(() => expect(t.store.snapshot?.rev).toBe(3));
    expect(t.store.state.settings.paused).toBe(true);
  });

  it('rebases pending edits onto a snapshot a request returns', async () => {
    const t = scripted(initial);
    await t.ready;
    // The save fails, so the edit is still pending when the next answer arrives.
    t.store.update((s) => rename(s, a.id, 'Pending'));
    const call = t.store.call({ type: 'activate', profileId: b.id, tabId: null, pauseAt: null });
    await t.answer(() => ({ ok: false, code: 'internal', error: 'Disk error.' }));
    const activated: State = {
      ...initial.state,
      settings: {
        ...initial.state.settings,
        activations: [{ profileId: b.id, tabId: null, pauseAt: null }],
      },
    };
    await t.answer(t.ok(snap(2, activated)));
    await call;
    expect(t.store.state.profiles[0]?.name).toBe('Pending');
    expect(t.store.state.settings.activations).toEqual(activated.settings.activations);
    expect(t.store.dirty).toBe(true);
  });

  it('ignores a refresh answer older than the snapshot it has', async () => {
    const t = scripted(initial);
    await t.ready;
    const refresh = t.store.refresh();
    await t.answer(t.ok(snap(0, stateWith([]))));
    await refresh;
    expect(t.store.state.profiles).toHaveLength(2);
  });

  it('turns a failed request into an error toast with run()', async () => {
    const t = scripted(initial);
    await t.ready;
    const run = t.store.run({ type: 'startTrial' });
    await t.answer(() => ({ ok: false, code: 'network', error: 'No connection.' }));
    expect(await run).toBeUndefined();
    expect(t.store.toasts.map((x) => [x.tone, x.message])).toEqual([['error', 'No connection.']]);
    await vi.advanceTimersByTimeAsync(8000);
    expect(t.store.toasts).toEqual([]);
  });
});
