import type { Profile, State } from '@headerbench/core';
import { describe, expect, it } from 'vitest';
import {
  activate,
  activationsOf,
  activeProfiles,
  deactivate,
  dropExpired,
  dropTabActivations,
  moveProfile,
  nextPauseAt,
  reorderProfiles,
} from '../src/activations';
import { parseExternal, parseRequest } from '../src/messages';
import { localDay, recordActiveDay, reviewUrl, shouldShowReview } from '../src/review';
import type { LocalSyncMeta, SyncPayload } from '../src/sw/sync';
import {
  SYNC_LIMITS,
  decodePayload,
  encodePayload,
  mergeRemote,
  mergeTombstones,
  payloadFingerprint,
  recordLocalChanges,
  reviveProfiles,
  splitChunks,
  staleChunkKeys,
} from '../src/sw/sync';
import { normalizeState } from '../src/sw/validate-state';
import { DAY, HOUR, NOW, profile, stateWith } from './helpers';

describe('parseRequest', () => {
  it('accepts well-formed requests and rejects everything else', () => {
    expect(parseRequest({ type: 'getState' })).toEqual({ type: 'getState' });
    expect(parseRequest({ type: 'activate', profileId: 'p', tabId: 3, pauseAt: null })).toEqual({
      type: 'activate',
      profileId: 'p',
      tabId: 3,
      pauseAt: null,
    });
    expect(
      parseRequest({
        type: 'testUrl',
        url: 'https://a.com',
        resourceType: 'script',
        method: 'post',
      }),
    ).toMatchObject({ method: 'post' });
    expect(
      parseRequest({ type: 'testUrl', url: 'https://a.com', resourceType: 'bogus', method: 'get' }),
    ).toBeNull();
    expect(
      parseRequest({ type: 'activate', profileId: 'p', tabId: 1.5, pauseAt: null }),
    ).toBeNull();
    expect(parseRequest({ type: 'deactivate', profileId: 'p' })).toEqual({
      type: 'deactivate',
      profileId: 'p',
    });
    expect(parseRequest({ type: 'deactivate', profileId: 'p', tabId: 4 })).toEqual({
      type: 'deactivate',
      profileId: 'p',
      tabId: 4,
    });
    expect(parseRequest({ type: 'deactivate', profileId: 'p', tabId: null })).toBeNull();
    expect(parseRequest({ type: 'saveState', state: {}, rev: '1' })).toBeNull();
    expect(parseRequest({ type: 'setReviewState', state: 'pending' })).toBeNull();
    expect(parseRequest('getState')).toBeNull();
    expect(parseRequest(null)).toBeNull();
  });

  it('accepts only activate-license from outside', () => {
    expect(parseExternal({ type: 'activate-license', key: 'HB1.a.b' })).toEqual({
      type: 'activate-license',
      key: 'HB1.a.b',
    });
    expect(parseExternal({ type: 'activate-license', key: 'x'.repeat(5000) })).toBeNull();
    expect(parseExternal({ type: 'getState' })).toBeNull();
  });
});

describe('activations', () => {
  const a = profile('A');
  const b = profile('B');
  const c = profile('C');
  const base = stateWith([a, b, c]);

  it('keeps one global activation per profile, in list order', () => {
    let s = activate(base, c.id, null, null);
    s = activate(s, a.id, 7, null);
    s = activate(s, a.id, null, NOW + HOUR);
    expect(s.settings.activations).toEqual([
      { profileId: a.id, tabId: null, pauseAt: NOW + HOUR },
      { profileId: c.id, tabId: null, pauseAt: null },
    ]);
    expect(deactivate(s, a.id).settings.activations.map((x) => x.profileId)).toEqual([c.id]);
  });

  it('scopes one profile to several tabs and turns it off per tab', () => {
    let s = activate(base, b.id, null, null);
    s = activate(s, a.id, 1, null);
    s = activate(s, a.id, 2, null);
    s = activate(s, a.id, 1, NOW + HOUR);
    expect(s.settings.activations).toEqual([
      { profileId: a.id, tabId: 2, pauseAt: null },
      { profileId: a.id, tabId: 1, pauseAt: NOW + HOUR },
      { profileId: b.id, tabId: null, pauseAt: null },
    ]);
    expect(activationsOf(s, a.id).map((x) => x.tabId)).toEqual([2, 1]);
    expect(activationsOf(deactivate(s, a.id, 2), a.id).map((x) => x.tabId)).toEqual([1]);
    expect(deactivate(s, a.id, 9)).toEqual(s);
    // Scoping a global profile to a tab replaces the global activation.
    expect(activationsOf(activate(s, b.id, 3, null), b.id)).toEqual([
      { profileId: b.id, tabId: 3, pauseAt: null },
    ]);
  });

  it('reorders profiles and their priority together', () => {
    let s = activate(activate(base, a.id, null, null), c.id, null, null);
    s = reorderProfiles(s, 2, 0);
    expect(s.profiles.map((p) => p.name)).toEqual(['C', 'A', 'B']);
    expect(s.settings.activations.map((x) => x.profileId)).toEqual([c.id, a.id]);
    expect(moveProfile(s, c.id, -1)).toBe(s);
    expect(moveProfile(s, c.id, 1).profiles.map((p) => p.name)).toEqual(['A', 'C', 'B']);
  });

  it('drops tab-scoped and expired activations and finds the next pause', () => {
    let s = activate(base, a.id, 3, null);
    s = activate(s, b.id, null, NOW + HOUR);
    s = activate(s, c.id, 4, NOW + 2 * HOUR);
    expect(dropTabActivations(s, 3).settings.activations.map((x) => x.profileId)).toEqual([
      b.id,
      c.id,
    ]);
    expect(dropTabActivations(s).settings.activations.map((x) => x.profileId)).toEqual([b.id]);
    expect(nextPauseAt(s, NOW)).toBe(NOW + HOUR);
    expect(dropExpired(s, NOW + HOUR).settings.activations.map((x) => x.profileId)).toEqual([
      a.id,
      c.id,
    ]);
    expect(activeProfiles({ ...s, settings: { ...s.settings, paused: true } }, NOW)).toEqual([]);
  });
});

describe('review prompt', () => {
  const p = profile('On');
  const on = stateWith([p], { activations: [{ profileId: p.id, tabId: null, pauseAt: null }] });

  it('counts distinct days with an active profile, up to 3', () => {
    let s = on;
    for (const t of [NOW, NOW + HOUR, NOW + DAY, NOW + 2 * DAY]) s = recordActiveDay(s, t) ?? s;
    expect(s.settings.review.activeDays).toEqual([
      localDay(NOW),
      localDay(NOW + DAY),
      localDay(NOW + 2 * DAY),
    ]);
    expect(shouldShowReview(s.settings)).toBe(true);
    expect(recordActiveDay(s, NOW + 3 * DAY)).toBeNull();
  });

  it('records nothing when nothing is on, paused, or after dismissal', () => {
    expect(recordActiveDay(stateWith([p]), NOW)).toBeNull();
    expect(recordActiveDay({ ...on, settings: { ...on.settings, paused: true } }, NOW)).toBeNull();
    const dismissed = {
      ...on.settings,
      review: { activeDays: ['a', 'b', 'c'], state: 'dismissed' as const },
    };
    expect(recordActiveDay({ ...on, settings: dismissed }, NOW)).toBeNull();
    expect(shouldShowReview(dismissed)).toBe(false);
    expect(
      shouldShowReview({ ...dismissed, review: { activeDays: ['a', 'b'], state: 'pending' } }),
    ).toBe(false);
  });

  it('links to the store the browser came from', () => {
    expect(reviewUrl('abc', 'Chrome/141')).toBe(
      'https://chromewebstore.google.com/detail/abc/reviews',
    );
    expect(reviewUrl('abc', 'Chrome/141 Edg/141')).toBe(
      'https://microsoftedge.microsoft.com/addons/detail/abc',
    );
  });
});

describe('sync encoding', () => {
  it('splits into chunks that each fit Chrome’s per-item quota, including multi-byte text', () => {
    const text = JSON.stringify({ v: 'é😀"'.repeat(5000) });
    const chunks = splitChunks(text);
    expect(chunks.join('')).toBe(text);
    for (const c of chunks) {
      expect(new TextEncoder().encode(JSON.stringify(c)).length).toBeLessThanOrEqual(
        SYNC_LIMITS.itemBytes,
      );
    }
  });

  it('round-trips a payload and lists stale chunk keys', () => {
    const p = profile('Synced');
    const encoded = encodePayload(
      {
        profiles: [p],
        variables: [],
        deleted: { gone: NOW },
        variablesUpdatedAt: NOW,
        orderUpdatedAt: NOW - 1,
      },
      'dev-1',
      NOW,
    );
    if (!encoded.ok) throw new Error('should fit');
    const decoded = decodePayload(encoded.items, NOW);
    expect(decoded?.payload.profiles[0]?.name).toBe('Synced');
    expect(decoded?.meta.device).toBe('dev-1');
    expect(decoded?.payload).toMatchObject({
      deleted: { gone: NOW },
      variablesUpdatedAt: NOW,
      orderUpdatedAt: NOW - 1,
    });
    expect(staleChunkKeys({ ...encoded.meta, chunks: 3 }, encoded.meta)).toEqual(['hb.1', 'hb.2']);
    expect(decodePayload({ 'hb.meta': encoded.meta }, NOW)).toBeNull();
  });

  it('refuses payloads above the 100 KB total quota', () => {
    const big = profile('Big', {
      requestHeaders: [
        { id: 'h', enabled: true, name: 'X', value: 'v'.repeat(120_000), op: 'set', comment: '' },
      ],
    });
    expect(
      encodePayload(
        { profiles: [big], variables: [], deleted: {}, variablesUpdatedAt: 0, orderUpdatedAt: 0 },
        'd',
        NOW,
      ),
    ).toMatchObject({ ok: false });
  });

  it('decodes a v1 payload (Headerbench 1.0.2) with no tombstones', () => {
    const p = profile('Old device');
    const text = JSON.stringify({ profiles: [p], variables: [{ id: 'v', name: 'a', value: '1' }] });
    const bytes = 'hb.0'.length + new TextEncoder().encode(JSON.stringify(text)).length;
    const decoded = decodePayload(
      { 'hb.0': text, 'hb.meta': { v: 1, device: 'd', writtenAt: NOW, chunks: 1, bytes } },
      NOW,
    );
    expect(decoded?.payload).toEqual({
      profiles: [p],
      variables: [{ id: 'v', name: 'a', value: '1' }],
      deleted: {},
      variablesUpdatedAt: 0,
      orderUpdatedAt: 0,
    });
  });
});

describe('sync merge', () => {
  const empty = { tombstones: {}, variablesUpdatedAt: 0, orderUpdatedAt: 0 };
  const payload = (profiles: Profile[], extra: Partial<SyncPayload> = {}): SyncPayload => ({
    profiles,
    variables: [],
    deleted: {},
    variablesUpdatedAt: 0,
    orderUpdatedAt: 0,
    ...extra,
  });
  const merge = (
    local: State,
    remote: SyncPayload | null,
    meta: LocalSyncMeta = empty,
    order: 'local' | 'remote' = 'remote',
  ) => mergeRemote(local, meta, remote, { order, now: NOW });

  it('keeps profiles from both sides and the newer copy of a shared one', () => {
    const shared = profile('Shared', { updatedAt: NOW });
    const mine = profile('Mine');
    const theirs = profile('Theirs');
    const result = merge(
      stateWith([shared, mine]),
      payload([{ ...shared, name: 'Shared (newer)', updatedAt: NOW + 1 }, theirs]),
    );
    expect(result.state.profiles.map((p) => p.name)).toEqual(['Shared (newer)', 'Mine', 'Theirs']);
    const older = merge(
      stateWith([{ ...shared, name: 'Shared (local)', updatedAt: NOW + 2 }]),
      payload([{ ...shared, updatedAt: NOW + 1 }]),
    );
    expect(older.state.profiles.map((p) => p.name)).toEqual(['Shared (local)']);
  });

  it('deletes with a tombstone only when it is newer than the profile', () => {
    const p = profile('Edited', { updatedAt: NOW + 10 });
    const q = profile('Untouched', { updatedAt: NOW });
    const remote = payload([], { deleted: { [p.id]: NOW + 5, [q.id]: NOW + 5 } });
    const result = merge(stateWith([p, q]), remote);
    expect(result.state.profiles.map((x) => x.name)).toEqual(['Edited']);
    expect(result.meta.tombstones).toEqual({ [q.id]: NOW + 5 });
    expect(result.payload.deleted).toEqual({ [q.id]: NOW + 5 });
    // A local tombstone stops a remote copy from coming back.
    const back = merge(stateWith([]), payload([q]), {
      tombstones: { [q.id]: NOW + 5 },
      variablesUpdatedAt: 0,
      orderUpdatedAt: 0,
    });
    expect(back.state.profiles).toEqual([]);
  });

  it('forgets tombstones after 30 days', () => {
    expect(mergeTombstones({ a: NOW - 31 * DAY, b: NOW - DAY }, { b: NOW, c: NOW }, NOW)).toEqual({
      b: NOW,
      c: NOW,
    });
  });

  it('keeps the remote order for a remote change and the local order for a push', () => {
    const [a, b, n] = [profile('A'), profile('B'), profile('New')];
    const local = stateWith([n, a, b]);
    expect(merge(local, payload([b, a])).state.profiles.map((p) => p.name)).toEqual([
      'New',
      'B',
      'A',
    ]);
    expect(
      merge(stateWith([a, b]), payload([b, n, a]), empty, 'local').state.profiles.map(
        (p) => p.name,
      ),
    ).toEqual(['A', 'B', 'New']);
  });

  it('takes variables from the newer side, and keeps every name on a tie', () => {
    const local = stateWith([], { variables: [{ id: '1', name: 'a', value: 'local' }] });
    const remoteVars = [{ id: '2', name: 'b', value: 'remote' }];
    const newer = merge(local, payload([], { variables: remoteVars, variablesUpdatedAt: NOW }), {
      tombstones: {},
      variablesUpdatedAt: NOW - 1,
      orderUpdatedAt: 0,
    });
    expect(newer.state.settings.variables).toEqual(remoteVars);
    expect(newer.meta.variablesUpdatedAt).toBe(NOW);
    const tie = merge(local, payload([], { variables: remoteVars }));
    expect(tie.state.settings.variables.map((v) => v.name).sort()).toEqual(['a', 'b']);
  });

  it('settles a tie the same way on both devices', () => {
    const p = profile('Same time', { updatedAt: NOW });
    const q = { ...p, name: 'Other copy' };
    const onA = merge(stateWith([p]), payload([q])).state.profiles;
    const onB = merge(stateWith([q]), payload([p])).state.profiles;
    expect(onA).toEqual(onB);
    const va = { id: 'x', name: 'v', value: '1' };
    const vb = { id: 'y', name: 'v', value: '2' };
    const varsA = merge(stateWith([], { variables: [va] }), payload([], { variables: [vb] }));
    const varsB = merge(stateWith([], { variables: [vb] }), payload([], { variables: [va] }));
    expect(varsA.state.settings.variables).toEqual(varsB.state.settings.variables);
    expect(varsA.state.settings.variables).toHaveLength(1);
  });

  it('fingerprints profile order (rule priority) but not variable order', () => {
    const [a, b] = [profile('A'), profile('B')];
    expect(payloadFingerprint(payload([a, b]))).not.toBe(payloadFingerprint(payload([b, a])));
    expect(payloadFingerprint(payload([a]))).not.toBe(payloadFingerprint(payload([a, b])));
    const [x, y] = [
      { id: 'x', name: 'x', value: '' },
      { id: 'y', name: 'y', value: '' },
    ];
    expect(payloadFingerprint(payload([], { variables: [x, y] }))).toBe(
      payloadFingerprint(payload([], { variables: [y, x] })),
    );
  });

  it('takes the order from the side that reordered last, whatever the direction', () => {
    const [a, b, c] = [profile('A'), profile('B'), profile('C')];
    const at = (orderUpdatedAt: number) => ({ ...empty, orderUpdatedAt });
    // This device reordered last: a remote change keeps the local order.
    const keep = merge(
      stateWith([c, a, b]),
      payload([a, b, c], { orderUpdatedAt: NOW - 5 }),
      at(NOW),
    );
    expect(keep.state.profiles.map((p) => p.name)).toEqual(['C', 'A', 'B']);
    expect(keep.meta.orderUpdatedAt).toBe(NOW);
    expect(keep.payload.orderUpdatedAt).toBe(NOW);
    // The other device reordered last: a push adopts the remote order.
    const adopt = merge(
      stateWith([a, b, c]),
      payload([c, b, a], { orderUpdatedAt: NOW }),
      at(NOW - 5),
      'local',
    );
    expect(adopt.state.profiles.map((p) => p.name)).toEqual(['C', 'B', 'A']);
  });

  it('places a profile new to one side next to the one it followed there', () => {
    const [a, b, c, n] = [profile('A'), profile('B'), profile('C'), profile('New')];
    const result = merge(stateWith([a, n, b, c]), payload([c, b, a], { orderUpdatedAt: NOW }), {
      ...empty,
      orderUpdatedAt: NOW - 5,
    });
    expect(result.state.profiles.map((p) => p.name)).toEqual(['C', 'B', 'A', 'New']);
  });

  it('stamps a reorder, but not an add or a delete', () => {
    const [a, b, c] = [profile('A'), profile('B'), profile('C')];
    const meta = { ...empty, orderUpdatedAt: NOW - DAY };
    const stamp = (prev: Profile[], next: Profile[]) =>
      recordLocalChanges(stateWith(prev), stateWith(next), meta, NOW).orderUpdatedAt;
    expect(stamp([a, b, c], [b, a, c])).toBe(NOW);
    expect(stamp([a, b], [a, c, b])).toBe(NOW - DAY);
    expect(stamp([a, b, c], [a, c])).toBe(NOW - DAY);
    expect(stamp([a, b], [a, b])).toBe(NOW - DAY);
  });

  it('records tombstones for deleted profiles and the time variables changed', () => {
    const [a, b] = [profile('A'), profile('B')];
    const meta = recordLocalChanges(
      stateWith([a, b]),
      stateWith([a], { variables: [{ id: 'v', name: 'x', value: '' }] }),
      { tombstones: { [a.id]: NOW - DAY }, variablesUpdatedAt: 0, orderUpdatedAt: 0 },
      NOW,
    );
    expect(meta).toEqual({
      tombstones: { [b.id]: NOW },
      variablesUpdatedAt: NOW,
      orderUpdatedAt: 0,
    });
  });

  it('moves a re-added profile past its tombstone', () => {
    const a = profile('A', { updatedAt: NOW - DAY });
    const revived = reviveProfiles(stateWith([]), stateWith([a]), { [a.id]: NOW - HOUR }, NOW);
    expect(revived.profiles[0]?.updatedAt).toBe(NOW);
    const untouched = stateWith([a]);
    expect(reviveProfiles(stateWith([a]), untouched, { [a.id]: NOW }, NOW)).toBe(untouched);
  });
});

describe('normalizeState', () => {
  it('keeps one activation per tab and one global per profile', () => {
    const p = profile('P');
    const s = stateWith([p], {
      activations: [
        { profileId: p.id, tabId: 1, pauseAt: null },
        { profileId: p.id, tabId: 2, pauseAt: null },
        { profileId: p.id, tabId: 1, pauseAt: NOW },
        { profileId: p.id, tabId: null, pauseAt: null },
        { profileId: p.id, tabId: null, pauseAt: NOW },
        { profileId: 'gone', tabId: 1, pauseAt: null },
      ],
    });
    expect(normalizeState(s).settings.activations).toEqual([
      { profileId: p.id, tabId: 1, pauseAt: null },
      { profileId: p.id, tabId: 2, pauseAt: null },
      { profileId: p.id, tabId: null, pauseAt: null },
    ]);
  });
});
