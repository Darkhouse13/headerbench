import { describe, expect, it } from 'vitest';
import {
  activate,
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
import {
  SYNC_LIMITS,
  applyRemote,
  decodePayload,
  encodePayload,
  mergeOnEnable,
  splitChunks,
  staleChunkKeys,
} from '../src/sw/sync';
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

  it('keeps one activation per profile, in list order', () => {
    let s = activate(base, c.id, null, null);
    s = activate(s, a.id, 7, null);
    s = activate(s, a.id, null, NOW + HOUR);
    expect(s.settings.activations).toEqual([
      { profileId: a.id, tabId: null, pauseAt: NOW + HOUR },
      { profileId: c.id, tabId: null, pauseAt: null },
    ]);
    expect(deactivate(s, a.id).settings.activations.map((x) => x.profileId)).toEqual([c.id]);
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
    const encoded = encodePayload({ profiles: [p], variables: [] }, 'dev-1', NOW);
    if (!encoded.ok) throw new Error('should fit');
    const decoded = decodePayload(encoded.items, NOW);
    expect(decoded?.payload.profiles[0]?.name).toBe('Synced');
    expect(decoded?.meta.device).toBe('dev-1');
    expect(staleChunkKeys({ ...encoded.meta, chunks: 3 }, encoded.meta)).toEqual(['hb.1', 'hb.2']);
    expect(decodePayload({ 'hb.meta': encoded.meta }, NOW)).toBeNull();
  });

  it('refuses payloads above the 100 KB total quota', () => {
    const big = profile('Big', {
      requestHeaders: [
        { id: 'h', enabled: true, name: 'X', value: 'v'.repeat(120_000), op: 'set', comment: '' },
      ],
    });
    expect(encodePayload({ profiles: [big], variables: [] }, 'd', NOW)).toMatchObject({
      ok: false,
    });
  });

  it('merges on enable (newest copy wins) and replaces on remote change', () => {
    const local = profile('Shared', { updatedAt: NOW });
    const remoteNewer = { ...local, name: 'Shared (laptop)', updatedAt: NOW + 1 };
    const onlyRemote = profile('Laptop only');
    const s = stateWith([local], {
      activations: [{ profileId: local.id, tabId: null, pauseAt: null }],
    });
    const merged = mergeOnEnable(s, { profiles: [remoteNewer, onlyRemote], variables: [] });
    expect(merged.profiles.map((p) => p.name)).toEqual(['Shared (laptop)', 'Laptop only']);
    const replaced = applyRemote(s, { profiles: [onlyRemote], variables: [] });
    expect(replaced.profiles).toEqual([onlyRemote]);
    expect(replaced.settings.activations).toEqual([]);
  });
});
