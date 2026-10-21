import type { Profile, Variable } from '@headerbench/core';
import { compile, proStatus, DEV_LICENSE_PUBLIC_KEY } from '@headerbench/core';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LICENSE_ALARM, WAKE_ALARM } from '../src/sw/background';
import { localDay } from '../src/review';
import { decodePayload } from '../src/sw/sync';
import type { Setup } from './helpers';
import { DAY, HOUR, NOW, domain, header, licenseKey, profile, setup, stateWith } from './helpers';

const fixture = (name: string): string =>
  readFileSync(resolve(__dirname, '../../packages/core/test/fixtures', name), 'utf8');

describe('resync', () => {
  it('installs exactly the compiled rules, replacing the old ones atomically', async () => {
    const t = setup();
    const p = profile('Staging', {
      requestHeaders: [header('X-Api-Key', 'abc')],
      filters: [domain('api.example.com')],
    });
    await t.save(
      stateWith([p], { activations: [{ profileId: p.id, tabId: null, pauseAt: null }] }),
    );
    const state = (await t.call({ type: 'getState' })).state;
    const expected = compile(state, { pro: false, now: NOW });
    expect(t.fake.dynamicRules).toEqual(expected.dynamic);
    expect(t.fake.sessionRules).toEqual([]);

    await t.call({ type: 'deactivate', profileId: p.id });
    expect(t.fake.dynamicRules).toEqual([]);
  });

  it('puts tab-scoped profiles in session rules for that tab only', async () => {
    const t = setup();
    const p = profile('Tab', { requestHeaders: [header('X-Tab', '1')] });
    await t.save(stateWith([p]));
    await t.call({ type: 'activate', profileId: p.id, tabId: 42, pauseAt: null });
    expect(t.fake.dynamicRules).toEqual([]);
    expect(t.fake.sessionRules).toHaveLength(1);
    expect(t.fake.sessionRules[0]?.condition.tabIds).toEqual([42]);
  });

  it('drops a rule Chrome rejects, installs the rest and reports the item', async () => {
    const t = setup();
    const p = profile('Mixed', {
      requestHeaders: [header('X-A', '1')],
      blocks: [
        {
          id: 'bad',
          enabled: true,
          kind: 'regex',
          pattern: '^https://[a-z]+\\.ads\\.example/',
          comment: '',
        },
        { id: 'good', enabled: true, kind: 'urlFilter', pattern: '||ads.example^', comment: '' },
      ],
    });
    t.fake.rejectRegex.add('^https://[a-z]+\\.ads\\.example/');
    await t.save(
      stateWith([p], { activations: [{ profileId: p.id, tabId: null, pauseAt: null }] }),
    );
    const snap = await t.call({ type: 'getState' });
    expect(t.fake.dynamicRules.map((r) => r.action.type).sort()).toEqual([
      'block',
      'modifyHeaders',
    ]);
    const rejected = snap.warnings.find((w) => w.message.startsWith('Chrome rejected'));
    expect(rejected?.itemIds).toEqual(['bad']);
    expect(snap.ruleError).toBeNull();
  });

  it('keeps the previous rules and reports RULE_BUDGET when over Chrome limits', async () => {
    const t = setup();
    const small = profile('Small', { requestHeaders: [header('X-A', '1')] });
    await t.save(
      stateWith([small], { activations: [{ profileId: small.id, tabId: null, pauseAt: null }] }),
    );
    const before = [...t.fake.dynamicRules];
    // Domain includes share one rule, so URL filters are what multiplies rules.
    const filters = Array.from({ length: 4600 }, (_, i) => ({
      ...domain(`||h${i}.example.com^`),
      kind: 'urlFilter' as const,
    }));
    const huge = { ...small, filters };
    const snap = await t.save(
      stateWith([huge], { activations: [{ profileId: small.id, tabId: null, pauseAt: null }] }),
    );
    expect(t.fake.dynamicRules).toEqual(before);
    expect(snap.ruleError).toMatch(/Too many rules/);
  });

  it('sets the badge: letter in colour, count, paused', async () => {
    const t = setup();
    const a = profile('Alpha', { color: '#188038', requestHeaders: [header('X-A', '1')] });
    const b = profile('Beta', { requestHeaders: [header('X-B', '1')] });
    await t.save(stateWith([a, b]));
    expect(t.fake.badge.text).toBe('');
    await t.call({ type: 'activate', profileId: a.id, tabId: null, pauseAt: null });
    expect(t.fake.badge).toMatchObject({ text: 'A', color: '#188038' });
    await t.call({ type: 'activate', profileId: b.id, tabId: null, pauseAt: null });
    expect(t.fake.badge.text).toBe('2');
    await t.call({ type: 'setPaused', paused: true });
    expect(t.fake.badge).toMatchObject({ text: 'II', color: '#5f6368' });
    expect(t.fake.dynamicRules).toEqual([]);
  });

  it('arms the wake alarm for auto-pause and drops the activation when it fires', async () => {
    const t = setup();
    const p = profile('Timed', { requestHeaders: [header('X-A', '1')] });
    await t.save(stateWith([p]));
    await t.call({ type: 'activate', profileId: p.id, tabId: null, pauseAt: NOW + HOUR });
    expect(t.fake.alarms.get(WAKE_ALARM)?.when).toBe(NOW + HOUR);
    t.clock.now = NOW + HOUR + 1;
    await t.bg.onAlarm({ name: WAKE_ALARM });
    const snap = await t.call({ type: 'getState' });
    expect(snap.state.settings.activations).toEqual([]);
    expect(t.fake.dynamicRules).toEqual([]);
    expect(t.fake.alarms.has(WAKE_ALARM)).toBe(false);
  });

  it('wakes when the Pro trial ends so Pro rules pause on time', async () => {
    const t = setup();
    const p = profile('Mock', {
      mocks: [
        {
          id: 'm',
          enabled: true,
          kind: 'urlFilter',
          pattern: '/api/user',
          contentType: 'application/json',
          body: '{}',
          comment: '',
        },
      ],
    });
    await t.save(stateWith([p]));
    await t.call({ type: 'activate', profileId: p.id, tabId: null, pauseAt: null });
    const trialEnds = (await t.call({ type: 'getState' })).pro.trialEndsAt;
    expect(t.fake.alarms.get(WAKE_ALARM)?.when).toBe(trialEnds);
    expect(t.fake.dynamicRules).toHaveLength(1);
    t.clock.now = (trialEnds as number) + 1;
    await t.bg.onAlarm({ name: WAKE_ALARM });
    expect(t.fake.dynamicRules).toEqual([]);
  });
});

describe('lifecycle', () => {
  it('opens the welcome page on first install only', async () => {
    const t = setup();
    await t.bg.onInstalled({ reason: 'install' });
    await t.bg.onInstalled({ reason: 'update' });
    expect(t.fake.createdTabs).toEqual(['chrome-extension://testextensionid/welcome.html']);
  });

  it('drops tab-scoped activations on browser startup and rebuilds rules', async () => {
    const t = setup();
    const a = profile('Global', { requestHeaders: [header('X-A', '1')] });
    const b = profile('Tab', { requestHeaders: [header('X-B', '1')] });
    await t.save(stateWith([a, b]));
    await t.call({ type: 'activate', profileId: a.id, tabId: null, pauseAt: null });
    await t.call({ type: 'activate', profileId: b.id, tabId: 9, pauseAt: null });
    t.fake.sessionRules = [];
    t.fake.dynamicRules = [];
    await t.bg.onStartup();
    const snap = await t.call({ type: 'getState' });
    expect(snap.state.settings.activations.map((x) => x.profileId)).toEqual([a.id]);
    expect(t.fake.dynamicRules).toHaveLength(1);
  });

  it('drops a closed tab’s activation', async () => {
    const t = setup();
    const p = profile('Tab', { requestHeaders: [header('X-B', '1')] });
    await t.save(stateWith([p]));
    await t.call({ type: 'activate', profileId: p.id, tabId: 9, pauseAt: null });
    await t.bg.onTabRemoved(10);
    expect((await t.call({ type: 'getState' })).state.settings.activations).toHaveLength(1);
    await t.bg.onTabRemoved(9);
    expect((await t.call({ type: 'getState' })).state.settings.activations).toHaveLength(0);
    expect(t.fake.sessionRules).toEqual([]);
  });

  it('toggles pause with the keyboard command', async () => {
    const t = setup();
    await t.bg.onCommand('toggle-pause');
    expect((await t.call({ type: 'getState' })).state.settings.paused).toBe(true);
    await t.bg.onCommand('toggle-pause');
    expect((await t.call({ type: 'getState' })).state.settings.paused).toBe(false);
  });

  it('answers messages through the registered onMessage listener, from this extension only', async () => {
    const t = setup();
    t.bg.register();
    const listener = [...t.api.runtime.onMessage.listeners][0]!;
    const reply = await new Promise((resolve) => {
      expect(listener({ type: 'getState' }, { id: 'testextensionid' }, resolve)).toBe(true);
    });
    expect(reply).toMatchObject({ ok: true, data: { rev: expect.any(Number) } });
    expect(listener({ type: 'getState' }, { id: 'someone-else' }, () => undefined)).toBe(false);
  });
});

describe('messages', () => {
  it('rejects unknown requests', async () => {
    const t = setup();
    expect(await t.bg.dispatch({ type: 'dropTables' })).toMatchObject({
      ok: false,
      code: 'invalid_request',
    });
  });

  it('refuses a save based on a stale rev and returns the latest snapshot', async () => {
    const t = setup();
    const snap = await t.save(stateWith([profile('One')]));
    await t.save(stateWith([profile('Two')]));
    const reply = await t.bg.dispatch({
      type: 'saveState',
      state: stateWith([profile('Stale')]),
      rev: snap.rev,
    });
    expect(reply).toMatchObject({ ok: false, code: 'conflict' });
    expect(reply.ok === false && reply.snapshot?.state.profiles[0]?.name).toBe('Two');
  });

  it('ignores licence, trial and review fields sent with saveState', async () => {
    const t = setup();
    const snap = await t.save(
      stateWith([], {
        licenseKey: 'HB1.forged',
        trialStartedAt: 1,
        review: { activeDays: [], state: 'rated' },
      }),
    );
    expect(snap.state.settings.licenseKey).toBeNull();
    expect(snap.state.settings.trialStartedAt).toBeNull();
    expect(snap.state.settings.review.state).toBe('pending');
  });

  it('starts the trial the first time a Pro item is saved, and not for free items', async () => {
    const t = setup();
    let snap = await t.save(stateWith([profile('Free', { requestHeaders: [header('X-A', '1')] })]));
    expect(snap.state.settings.trialStartedAt).toBeNull();
    const p = profile('Pro', {
      redirects: [
        {
          id: 'r',
          enabled: true,
          kind: 'regex',
          from: '^https://a\\.com/(.*)$',
          to: 'http://localhost/$1',
          comment: '',
        },
      ],
    });
    snap = await t.save(stateWith([p]));
    expect(snap.state.settings.trialStartedAt).toBe(NOW);
    expect(snap.pro).toMatchObject({ pro: true, source: 'trial' });
  });

  it('does not start a trial when importing a file with Pro rules', async () => {
    const t = setup();
    const outcome = await t.call({
      type: 'importText',
      text: fixture('modheader-a-v2.json'),
      apply: true,
    });
    expect(outcome.profileIds.length).toBeGreaterThan(0);
    expect(outcome.snapshot?.state.settings.trialStartedAt).toBeNull();
  });

  it('previews an import without saving, then applies it', async () => {
    const t = setup();
    const preview = await t.call({
      type: 'importText',
      text: fixture('modheader-a-v2.json'),
      apply: false,
    });
    expect(preview.snapshot).toBeNull();
    expect(preview.summary).toMatch(/profiles?, .* imported/);
    expect((await t.call({ type: 'getState' })).state.profiles).toEqual([]);
    const applied = await t.call({
      type: 'importText',
      text: fixture('modheader-a-v2.json'),
      apply: true,
    });
    expect(applied.snapshot?.state.profiles.map((p) => p.id)).toEqual(applied.profileIds);
  });

  it('re-ids profiles when the same Headerbench file is imported twice', async () => {
    const t = setup();
    const p = profile('Exported', { requestHeaders: [header('X-A', '1')] });
    const file = JSON.stringify({
      headerbench: 1,
      exportedAt: new Date(NOW).toISOString(),
      profiles: [p],
      variables: [],
    });
    await t.call({ type: 'importText', text: file, apply: true });
    const second = await t.call({ type: 'importText', text: file, apply: true });
    const ids = second.snapshot?.state.profiles.map((x) => x.id) ?? [];
    expect(new Set(ids).size).toBe(2);
  });

  it('reports why nothing was imported from a junk file', async () => {
    const t = setup();
    const outcome = await t.call({ type: 'importText', text: 'not json', apply: true });
    expect(outcome.report.errors.length).toBeGreaterThan(0);
    expect(outcome.summary).toMatch(/^Nothing imported/);
    expect(outcome.snapshot).toBeNull();
  });

  it('keeps activations in profile order, which is the priority order', async () => {
    const t = setup();
    const a = profile('A', { requestHeaders: [header('X-V', 'a')] });
    const b = profile('B', { requestHeaders: [header('X-V', 'b')] });
    await t.save(stateWith([a, b]));
    await t.call({ type: 'activate', profileId: b.id, tabId: null, pauseAt: null });
    const snap = await t.call({ type: 'activate', profileId: a.id, tabId: null, pauseAt: null });
    expect(snap.state.settings.activations.map((x) => x.profileId)).toEqual([a.id, b.id]);
    const reordered = await t.save({ ...snap.state, profiles: [b, a] });
    expect(reordered.state.settings.activations.map((x) => x.profileId)).toEqual([b.id, a.id]);
  });

  it('returns not_found when activating a missing profile', async () => {
    const t = setup();
    const reply = await t.bg.dispatch({
      type: 'activate',
      profileId: 'nope',
      tabId: null,
      pauseAt: null,
    });
    expect(reply).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('tests a URL with the real host access state', async () => {
    const t = setup();
    const p = profile('Api', {
      requestHeaders: [header('X-A', '1')],
      filters: [domain('api.example.com')],
    });
    await t.save(
      stateWith([p], { activations: [{ profileId: p.id, tabId: null, pauseAt: null }] }),
    );
    const req = {
      type: 'testUrl',
      url: 'https://api.example.com/v1',
      resourceType: 'xmlhttprequest',
      method: 'get',
    } as const;
    let result = await t.call(req);
    expect(result).toMatchObject({ origin: 'https://api.example.com', hasHostAccess: false });
    expect(result.matches[0]).toMatchObject({
      applied: false,
      reason: expect.stringMatching(/No site access/),
    });
    t.fake.granted.add('https://api.example.com/*');
    result = await t.call(req);
    expect(result.matches[0]).toMatchObject({ applied: true });
    expect((await t.call({ ...req, url: 'ftp://x' })).origin).toBeNull();

    // Page loads need no access to the page that starts them.
    result = await t.call({
      ...req,
      resourceType: 'main_frame',
      initiator: 'http://localhost:5173/app',
    });
    expect(result).toMatchObject({ pageOrigin: 'http://localhost/*', hasPageAccess: true });

    // Chrome also needs access to the page that sends the request.
    result = await t.call({ ...req, initiator: 'http://localhost:5173/app' });
    expect(result).toMatchObject({
      hasHostAccess: true,
      pageOrigin: 'http://localhost/*',
      hasPageAccess: false,
    });
    expect(result.matches[0]).toMatchObject({
      applied: false,
      reason: 'Chrome needs access to the page that sends this request (http://localhost:5173).',
    });
    t.fake.granted.add('http://localhost/*');
    result = await t.call({ ...req, initiator: 'http://localhost:5173/app' });
    expect(result).toMatchObject({ hasPageAccess: true });
    expect(result.matches[0]).toMatchObject({ applied: true });
  });

  it('maps Chrome’s matched rules for a tab back to profiles and rows', async () => {
    const t = setup();
    const p = profile('Staging', {
      requestHeaders: [header('X-Api-Key', 'abc'), header('Referer', '', 'remove')],
    });
    await t.save(
      stateWith([p], { activations: [{ profileId: p.id, tabId: null, pauseAt: null }] }),
    );
    t.fake.matched = [
      { rule: { ruleId: 1, rulesetId: '_dynamic' }, tabId: 5, timeStamp: NOW },
      { rule: { ruleId: 1, rulesetId: '_dynamic' }, tabId: 5, timeStamp: NOW + 10 },
    ];
    const result = await t.call({ type: 'getMatchesForTab', tabId: 5 });
    expect(result.unavailable).toBe(false);
    if (result.unavailable) return;
    expect(result.applied).toHaveLength(2);
    expect(result.applied[0]).toMatchObject({
      profileName: 'Staging',
      hits: 2,
      lastMatchedAt: NOW + 10,
      effect: { type: 'header', header: 'X-Api-Key', operation: 'set', value: 'abc' },
    });
  });

  it('says why matches are unavailable and still explains with the tester', async () => {
    const t = setup();
    t.fake.matchedError = 'You do not have permission to call this function.';
    const p = profile('Api', { requestHeaders: [header('X-A', '1')] });
    await t.save(
      stateWith([p], { activations: [{ profileId: p.id, tabId: null, pauseAt: null }] }),
    );
    const result = await t.call({
      type: 'getMatchesForTab',
      tabId: 5,
      url: 'https://example.com/',
    });
    expect(result).toMatchObject({ unavailable: true, reason: expect.stringMatching(/toolbar/) });
    expect(result.explain.length).toBeGreaterThan(0);
  });

  it('records active days for the review prompt and stops after a dismissal', async () => {
    const t = setup();
    const p = profile('Used', { requestHeaders: [header('X-A', '1')] });
    await t.save(
      stateWith([p], { activations: [{ profileId: p.id, tabId: null, pauseAt: null }] }),
    );
    for (let d = 0; d < 4; d++) {
      t.clock.now = NOW + d * DAY;
      await t.call({ type: 'getState' });
    }
    let snap = await t.call({ type: 'getState' });
    expect(snap.state.settings.review.activeDays).toHaveLength(3);
    snap = await t.call({ type: 'setReviewState', state: 'dismissed' });
    snap = await t.call({ type: 'setReviewState', state: 'shown' });
    expect(snap.state.settings.review.state).toBe('dismissed');
  });

  it('records active days without bumping rev, so an open editor can still save', async () => {
    const t = setup();
    const p = profile('Used', { requestHeaders: [header('X-A', '1')] });
    const saved = await t.save(
      stateWith([p], { activations: [{ profileId: p.id, tabId: null, pauseAt: null }] }),
    );
    // Another window opens a day later and records an active day.
    t.clock.now = NOW + DAY;
    const other = await t.call({ type: 'getState' });
    expect(other.state.settings.review.activeDays).toEqual([localDay(NOW + DAY)]);
    expect(other.rev).toBe(saved.rev);
    // The first window's edit, based on its older snapshot, is not a conflict.
    const edited = { ...saved.state, profiles: [{ ...p, name: 'Renamed' }] };
    const reply = await t.bg.dispatch({ type: 'saveState', state: edited, rev: saved.rev });
    expect(reply).toMatchObject({ ok: true });
    const after = await t.call({ type: 'getState' });
    expect(after.state.profiles[0]?.name).toBe('Renamed');
    expect(after.state.settings.review.activeDays).toEqual([localDay(NOW + DAY)]);
  });

  it('builds diagnostics without header values or the licence key', async () => {
    const t = setup();
    const key = licenseKey();
    await t.call({ type: 'applyLicense', key });
    await t.save({
      ...(await t.call({ type: 'getState' })).state,
      profiles: [profile('Secret', { requestHeaders: [header('Authorization', 'Bearer s3cret')] })],
    });
    const { text } = await t.call({ type: 'getDiagnostics' });
    expect(text).toMatch(/Profiles: 1/);
    expect(text).not.toContain('s3cret');
    expect(text).not.toContain(key);
  });

  it('downloads and discards unreadable data that was set aside', async () => {
    const t = setup();
    t.api.storage.local.data = { state: '{broken', rev: 1 };
    const snap = await t.call({ type: 'getState' });
    expect(snap.hasCorruptData).toBe(true);
    expect((await t.call({ type: 'getCorruptData' })).json).toBe('"{broken"');
    expect((await t.call({ type: 'discardCorruptData' })).hasCorruptData).toBe(false);
  });
});

describe('licences', () => {
  it('applies a valid key and turns Pro on', async () => {
    const t = setup();
    const outcome = await t.call({ type: 'applyLicense', key: `  ${licenseKey()}\n` });
    expect(outcome).toMatchObject({
      plan: 'pro_yearly',
      expired: false,
      expiresAt: NOW + 300 * DAY,
    });
    expect(outcome.snapshot.pro).toMatchObject({ pro: true, source: 'license' });
  });

  it('rejects a tampered or malformed key with a plain reason', async () => {
    const t = setup();
    const key = licenseKey();
    const tampered = `${key.slice(0, -4)}AAAA`;
    expect(await t.bg.dispatch({ type: 'applyLicense', key: tampered })).toMatchObject({
      ok: false,
      code: 'license_invalid',
      error: expect.stringMatching(/does not match/),
    });
    expect(await t.bg.dispatch({ type: 'applyLicense', key: 'hello' })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/start with HB1/),
    });
  });

  it('accepts activate-license from headerbench.com only, and only unexpired keys', async () => {
    const t = setup();
    const key = licenseKey({ plan: 'pro_lifetime', exp: null, sub: null, lid: 'txn_01' });
    expect(
      await t.bg.handleExternal(
        { type: 'activate-license', key },
        { origin: 'https://evil.example' },
      ),
    ).toMatchObject({ ok: false });
    expect(
      await t.bg.handleExternal({ type: 'other' }, { origin: 'https://headerbench.com' }),
    ).toMatchObject({ ok: false });
    const expired = licenseKey({ exp: Math.floor((NOW - DAY) / 1000) });
    expect(
      await t.bg.handleExternal(
        { type: 'activate-license', key: expired },
        { origin: 'https://headerbench.com' },
      ),
    ).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/expired/),
    });
    expect(
      await t.bg.handleExternal(
        { type: 'activate-license', key },
        { url: 'https://headerbench.com/activate?txn=1' },
      ),
    ).toEqual({
      ok: true,
      plan: 'pro_lifetime',
      expiresAt: null,
    });
    expect((await t.call({ type: 'getState' })).state.settings.licenseKey).toBe(key);
  });

  it('refreshes a yearly key from the server and keeps the old one on errors', async () => {
    const fresh = licenseKey({ exp: Math.floor((NOW + 400 * DAY) / 1000) });
    const calls: { url: string; body: string }[] = [];
    let respond: () => Response = () =>
      Response.json({ key: fresh, plan: 'pro_yearly', expiresAt: 1 });
    const t = setup({
      fetch: async (url, init) => {
        calls.push({ url: String(url), body: String(init?.body) });
        return respond();
      },
    });
    const old = licenseKey({ exp: Math.floor((NOW + 5 * DAY) / 1000) });
    await t.call({ type: 'applyLicense', key: old });

    respond = () =>
      Response.json(
        { reason: 'subscription_inactive', message: 'Your subscription was cancelled on Oct 1.' },
        { status: 410 },
      );
    expect(await t.bg.dispatch({ type: 'refreshLicense', auto: false })).toMatchObject({
      ok: false,
      code: 'subscription_inactive',
      error: 'Your subscription was cancelled on Oct 1.',
    });
    respond = () =>
      Response.json(
        { reason: 'paddle_unavailable', message: 'Payments are temporarily unavailable.' },
        { status: 502 },
      );
    expect(await t.bg.dispatch({ type: 'refreshLicense', auto: false })).toMatchObject({
      ok: false,
      error: 'Payments are temporarily unavailable. Your current licence stays active.',
    });
    expect((await t.call({ type: 'getState' })).state.settings.licenseKey).toBe(old);

    respond = () => Response.json({ key: fresh, plan: 'pro_yearly', expiresAt: 1 });
    const outcome = await t.call({ type: 'refreshLicense', auto: false });
    expect(outcome.expiresAt).toBe(NOW + 400 * DAY);
    expect(calls.at(-1)).toEqual({
      url: 'https://headerbench.com/api/license/refresh',
      body: JSON.stringify({ key: old }),
    });
    expect(outcome.snapshot.state.settings.licenseKey).toBe(fresh);
  });

  it('auto-refreshes only near expiry and at most every 6 hours', async () => {
    let count = 0;
    const t = setup({
      fetch: async () => {
        count++;
        return new Response('{}', { status: 503 });
      },
    });
    await t.call({
      type: 'applyLicense',
      key: licenseKey({ exp: Math.floor((NOW + 3 * DAY) / 1000) }),
    });
    t.clock.now = NOW - 30 * DAY;
    expect((await t.call({ type: 'refreshLicense', auto: true })).skipped).toBe(true);
    expect(count).toBe(0);
    t.clock.now = NOW;
    await t.bg.dispatch({ type: 'refreshLicense', auto: true });
    await t.bg.dispatch({ type: 'refreshLicense', auto: true });
    expect(count).toBe(1);
    t.clock.now = NOW + 7 * HOUR;
    await t.bg.dispatch({ type: 'refreshLicense', auto: true });
    expect(count).toBe(2);
  });

  it('never calls the server for a lifetime key', async () => {
    let count = 0;
    const t = setup({ fetch: async () => (count++, new Response('{}')) });
    await t.call({
      type: 'applyLicense',
      key: licenseKey({ plan: 'pro_lifetime', exp: null, sub: null }),
    });
    expect((await t.call({ type: 'refreshLicense', auto: false })).skipped).toBe(true);
    expect(count).toBe(0);
  });

  it('rejects expired keys and never swaps a valid key for a shorter one', async () => {
    const t = setup();
    const yearly = licenseKey();
    await t.call({ type: 'applyLicense', key: yearly });

    const expired = licenseKey({ exp: Math.floor((NOW - DAY) / 1000) });
    // A different licence (another subscription) that ends sooner never replaces this one.
    const earlier = licenseKey({
      lid: 'sub_02',
      sub: 'sub_02',
      exp: Math.floor((NOW + 30 * DAY) / 1000),
    });
    const later = licenseKey({ exp: Math.floor((NOW + 400 * DAY) / 1000) });
    const lifetime = licenseKey({ plan: 'pro_lifetime', exp: null, sub: null, lid: 'txn_09' });
    const stored = async () => (await t.call({ type: 'getState' })).state.settings.licenseKey;

    expect(await t.bg.dispatch({ type: 'applyLicense', key: expired })).toMatchObject({
      ok: false,
      code: 'license_invalid',
      error: expect.stringMatching(/has expired/),
    });
    expect(await t.bg.dispatch({ type: 'applyLicense', key: earlier })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/current licence lasts longer \(until 2027-08-08\)/),
    });
    expect(await stored()).toBe(yearly);

    await t.call({ type: 'applyLicense', key: yearly });
    await t.call({ type: 'applyLicense', key: later });
    expect(await stored()).toBe(later);
    await t.call({ type: 'applyLicense', key: lifetime });
    expect(await stored()).toBe(lifetime);

    // Lifetime beats yearly, from the settings page and from headerbench.com/activate alike.
    expect(await t.bg.dispatch({ type: 'applyLicense', key: later })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/lifetime licence is already active/),
    });
    expect(
      await t.bg.handleExternal(
        { type: 'activate-license', key: later },
        { origin: 'https://headerbench.com' },
      ),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/lifetime/) });
    expect(await stored()).toBe(lifetime);
  });

  it('replaces an expired current key with a newer one', async () => {
    const t = setup();
    await t.call({
      type: 'applyLicense',
      key: licenseKey({ exp: Math.floor((NOW + DAY) / 1000) }),
    });
    t.clock.now = NOW + 2 * DAY;
    const renewed = licenseKey({ exp: Math.floor((NOW + 30 * DAY) / 1000) });
    await t.call({ type: 'applyLicense', key: renewed });
    expect((await t.call({ type: 'getState' })).state.settings.licenseKey).toBe(renewed);
  });

  it('treats a lid on the revocation list as invalid', async () => {
    const lifetime = licenseKey({
      plan: 'pro_lifetime',
      exp: null,
      sub: null,
      lid: 'txn_refunded',
    });
    const t = setup({ revokedLicenses: ['txn_refunded'] });
    expect(await t.bg.dispatch({ type: 'applyLicense', key: lifetime })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/refunded/),
    });

    // A key stored before the list shipped stops turning on Pro after the update.
    const before = setup();
    await before.call({ type: 'applyLicense', key: lifetime });
    const data = before.api.storage.local.data;
    const after = setup({ revokedLicenses: ['txn_refunded'] });
    after.api.storage.local.data = data;
    expect((await after.call({ type: 'getState' })).pro).toMatchObject({ pro: false, plan: null });
  });

  it('matches core’s proStatus for the stored key', async () => {
    const t = setup();
    const snap = (await t.call({ type: 'applyLicense', key: licenseKey() })).snapshot;
    expect(snap.pro).toEqual(proStatus(snap.state.settings, NOW, DEV_LICENSE_PUBLIC_KEY));
  });
});

describe('sync', () => {
  it('mirrors profiles to chrome.storage.sync in chunks when Pro sync is on', async () => {
    const t = setup();
    await t.call({ type: 'applyLicense', key: licenseKey() });
    const p = profile('Synced', { requestHeaders: [header('X-Big', 'x'.repeat(20_000))] });
    const base = (await t.call({ type: 'getState' })).state;
    await t.save({ ...base, profiles: [p], settings: { ...base.settings, sync: true } });
    await t.bg.idle();
    const meta = t.api.storage.sync.data['hb.meta'] as { chunks: number };
    expect(meta.chunks).toBeGreaterThan(2);
    const snap = await t.call({ type: 'getState' });
    expect(snap.sync).toMatchObject({ active: true, error: null, lastSyncedAt: NOW });
  });

  it('does not sync without Pro and says so', async () => {
    const t = setup();
    const base = (await t.call({ type: 'getState' })).state;
    const snap = await t.save({ ...base, settings: { ...base.settings, sync: true } });
    await t.bg.idle();
    expect(t.api.storage.sync.data).toEqual({});
    expect(snap.sync.error).toMatch(/needs Pro/);
  });

  it('pauses sync with a clear message when data exceeds Chrome’s 100 KB', async () => {
    const t = setup();
    await t.call({ type: 'applyLicense', key: licenseKey() });
    const p = profile('Huge', {
      mocks: [
        {
          id: 'm',
          enabled: true,
          kind: 'urlFilter',
          pattern: '/x',
          contentType: 'text/plain',
          body: 'y'.repeat(60_000),
          comment: '',
        },
      ],
    });
    const q = { ...profile('Huge 2'), mocks: [{ ...p.mocks[0]!, id: 'm2' }] };
    const base = (await t.call({ type: 'getState' })).state;
    await t.save({ ...base, profiles: [p, q], settings: { ...base.settings, sync: true } });
    await t.bg.idle();
    expect(t.api.storage.sync.data).toEqual({});
    expect((await t.call({ type: 'getState' })).sync.error).toMatch(/Sync is paused: .* 100 KB/);
  });

  it('applies changes pushed by another device', async () => {
    const t = setup();
    await t.call({ type: 'applyLicense', key: licenseKey() });
    const base = (await t.call({ type: 'getState' })).state;
    await t.save({ ...base, settings: { ...base.settings, sync: true } });
    await t.bg.idle();
    const remote = profile('From laptop', { requestHeaders: [header('X-R', '1')] });
    await t.bg.onSyncChanged(writeMirror(t, 'other-device', { profiles: [remote], variables: [] }));
    expect(await names(t)).toEqual(['From laptop']);
  });

  // Regression: device B had settings.sync on before it had Pro. Applying a licence pushed B's
  // profiles over the mirror and dropped device A's.
  it('keeps profiles other devices mirrored when sync turns on through a licence', async () => {
    const a = setup();
    await a.call({ type: 'applyLicense', key: licenseKey() });
    const aBase = (await a.call({ type: 'getState' })).state;
    await a.save({
      ...aBase,
      profiles: [profile('FromDeviceA')],
      settings: { ...aBase.settings, sync: true },
    });
    await a.bg.idle();

    const b = setup({ sync: a.api.storage.sync });
    const bBase = (await b.call({ type: 'getState' })).state;
    await b.save({
      ...bBase,
      profiles: [profile('OnB')],
      settings: { ...bBase.settings, sync: true },
    });
    await b.bg.idle();
    await b.call({ type: 'applyLicense', key: licenseKey() });
    await b.bg.idle();

    expect((await names(b)).sort()).toEqual(['FromDeviceA', 'OnB']);
    expect(mirrorNames(a).sort()).toEqual(['FromDeviceA', 'OnB']);
  });

  // Regression: an older payload from another device (here a 1.0.2-style write that lacks a
  // profile this device just created) replaced local state and deleted the new profile.
  it('never deletes a local profile because another device’s payload lacks it', async () => {
    const a = setup();
    await a.call({ type: 'applyLicense', key: licenseKey() });
    const shared = profile('Shared', { updatedAt: NOW });
    const base = (await a.call({ type: 'getState' })).state;
    await a.save({ ...base, profiles: [shared], settings: { ...base.settings, sync: true } });
    await a.bg.idle();
    const withNew = (await a.call({ type: 'getState' })).state;
    await a.save({ ...withNew, profiles: [...withNew.profiles, profile('NewOnA')] });
    await a.bg.idle();

    const editedOnB = { ...shared, name: 'Shared (edited on B)', updatedAt: NOW + 5 };
    await a.bg.onSyncChanged(writeMirror(a, 'device-b', { profiles: [editedOnB], variables: [] }));
    await a.bg.idle();

    expect(await names(a)).toEqual(['Shared (edited on B)', 'NewOnA']);
    // A pushes back what B's write lacked.
    expect(mirrorNames(a)).toEqual(['Shared (edited on B)', 'NewOnA']);
  });

  it('keeps concurrent edits to different profiles from two devices', async () => {
    const { a, b, one, two } = await twoDevices();
    const aState = (await a.call({ type: 'getState' })).state;
    const bState = (await b.call({ type: 'getState' })).state;
    // Both edit from the same starting point before seeing each other's change.
    a.clock.now = NOW + 10;
    await a.save({
      ...aState,
      profiles: aState.profiles.map((p) =>
        p.id === one.id ? { ...p, name: 'One (A)', updatedAt: NOW + 10 } : p,
      ),
    });
    b.clock.now = NOW + 20;
    await b.save({
      ...bState,
      profiles: bState.profiles.map((p) =>
        p.id === two.id ? { ...p, name: 'Two (B)', updatedAt: NOW + 20 } : p,
      ),
    });
    await a.bg.idle();
    await b.bg.idle();
    await deliver(a, b);
    expect((await names(a)).sort()).toEqual(['One (A)', 'Two (B)']);
    expect((await names(b)).sort()).toEqual(['One (A)', 'Two (B)']);
  });

  it('propagates a deletion, and a stale copy from another device does not bring it back', async () => {
    const { a, b, one } = await twoDevices();
    a.clock.now = NOW + DAY;
    const aState = (await a.call({ type: 'getState' })).state;
    await a.save({ ...aState, profiles: aState.profiles.filter((p) => p.id !== one.id) });
    await a.bg.idle();
    await deliver(a, b);
    expect(await names(b)).toEqual(['Two']);

    // A 1.0.2 device still has the old copy and writes it back.
    await a.bg.onSyncChanged(writeMirror(a, 'old-device', { profiles: [one], variables: [] }));
    await a.bg.idle();
    expect(await names(a)).toEqual(['Two']);
    expect(mirrorNames(a)).toEqual(['Two']);
  });

  it('keeps a profile restored after a delete (undo), on every device', async () => {
    const { a, b, one } = await twoDevices();
    a.clock.now = NOW + DAY;
    const before = (await a.call({ type: 'getState' })).state;
    await a.save({ ...before, profiles: before.profiles.filter((p) => p.id !== one.id) });
    await a.bg.idle();
    a.clock.now = NOW + DAY + 1000;
    const after = (await a.call({ type: 'getState' })).state;
    const restored = await a.save({ ...after, profiles: before.profiles });
    expect(restored.state.profiles.find((p) => p.id === one.id)?.updatedAt).toBeGreaterThan(
      NOW + DAY,
    );
    await a.bg.idle();
    await deliver(a, b);
    expect((await names(a)).sort()).toEqual(['One', 'Two']);
    expect((await names(b)).sort()).toEqual(['One', 'Two']);
  });

  // Regression: the mirror fingerprint ignored order, so a reorder on A was never pushed.
  it('mirrors a reorder (rule priority) to the other device', async () => {
    const { a, b } = await twoDevices();
    await reorder(a, NOW + HOUR, ['Two', 'One']);
    expect(mirrorNames(a)).toEqual(['Two', 'One']);
    await deliver(a, b);
    expect(await names(b)).toEqual(['Two', 'One']);
    expect(await names(a)).toEqual(['Two', 'One']);
  });

  // Regression: an unrelated edit on B, pushed with B's old order, undid A's reorder.
  it('keeps a reorder when another device then edits something else', async () => {
    const { a, b, one } = await twoDevices();
    await reorder(a, NOW + HOUR, ['Two', 'One']);
    // B has not seen A's change yet and renames One.
    b.clock.now = NOW + 2 * HOUR;
    const bState = (await b.call({ type: 'getState' })).state;
    expect(bState.profiles.map((p) => p.name)).toEqual(['One', 'Two']);
    await b.save({
      ...bState,
      profiles: bState.profiles.map((p) =>
        p.id === one.id ? { ...p, name: 'One (B)', updatedAt: NOW + 2 * HOUR } : p,
      ),
    });
    await b.bg.idle();
    await deliver(b, a);
    expect(await names(a)).toEqual(['Two', 'One (B)']);
    expect(await names(b)).toEqual(['Two', 'One (B)']);
    // A reorder on B later still wins over A's older one.
    await reorder(b, NOW + 3 * HOUR, ['One (B)', 'Two']);
    await deliver(b, a);
    expect(await names(a)).toEqual(['One (B)', 'Two']);
  });

  it('settles after a reorder: no ping-pong of mirror writes between two devices', async () => {
    const { a, b } = await twoDevices();
    const area = a.api.storage.sync;
    const set = area.set.bind(area);
    let writes = 0;
    area.set = async (items) => {
      writes++;
      return set(items);
    };
    await reorder(a, NOW + HOUR, ['Two', 'One']);
    await deliver(a, b);
    const settled = writes;
    expect(settled).toBe(1);
    for (let i = 0; i < 3; i++) {
      await deliver(a, b);
      await deliver(b, a);
    }
    expect(writes).toBe(settled);
    expect(await names(a)).toEqual(['Two', 'One']);
    expect(await names(b)).toEqual(['Two', 'One']);
  });

  it('takes the variable list from the device that changed it last', async () => {
    const { a, b } = await twoDevices();
    a.clock.now = NOW + HOUR;
    const aState = (await a.call({ type: 'getState' })).state;
    await a.save({
      ...aState,
      settings: { ...aState.settings, variables: [{ id: 'v1', name: 'token', value: 'abc' }] },
    });
    await a.bg.idle();
    await deliver(a, b);
    expect((await b.call({ type: 'getState' })).state.settings.variables).toEqual([
      { id: 'v1', name: 'token', value: 'abc' },
    ]);
    // Deleting all variables on B propagates too (B's list is newer).
    b.clock.now = NOW + 2 * HOUR;
    const bState = (await b.call({ type: 'getState' })).state;
    await b.save({ ...bState, settings: { ...bState.settings, variables: [] } });
    await b.bg.idle();
    await deliver(b, a);
    expect((await a.call({ type: 'getState' })).state.settings.variables).toEqual([]);
  });

  it('drops the activation of a profile another device deleted', async () => {
    const { a, b, one } = await twoDevices();
    await b.call({ type: 'activate', profileId: one.id, tabId: null, pauseAt: null });
    a.clock.now = NOW + DAY;
    const aState = (await a.call({ type: 'getState' })).state;
    await a.save({ ...aState, profiles: aState.profiles.filter((p) => p.id !== one.id) });
    await a.bg.idle();
    await deliver(a, b);
    expect((await b.call({ type: 'getState' })).state.settings.activations).toEqual([]);
  });

  it('ignores a half-arrived mirror write', async () => {
    const t = setup();
    await t.call({ type: 'applyLicense', key: licenseKey() });
    const base = (await t.call({ type: 'getState' })).state;
    await t.save({
      ...base,
      profiles: [profile('Mine')],
      settings: { ...base.settings, sync: true },
    });
    await t.bg.idle();
    const changes = writeMirror(t, 'other', { profiles: [profile('Theirs')], variables: [] });
    t.api.storage.sync.data['hb.0'] = '{"profiles":[';
    await t.bg.onSyncChanged(changes);
    expect(await names(t)).toEqual(['Mine']);
  });

  it('catches up with the mirror on browser start', async () => {
    const t = setup();
    await t.call({ type: 'applyLicense', key: licenseKey() });
    const base = (await t.call({ type: 'getState' })).state;
    await t.save({ ...base, settings: { ...base.settings, sync: true } });
    await t.bg.idle();
    writeMirror(t, 'other', { profiles: [profile('While closed')], variables: [] });
    await t.bg.onStartup();
    await t.bg.idle();
    expect(await names(t)).toEqual(['While closed']);
  });
});

async function names(t: Setup): Promise<string[]> {
  return (await t.call({ type: 'getState' })).state.profiles.map((p) => p.name);
}

function mirrorNames(t: Setup): string[] {
  return decodePayload(t.api.storage.sync.data, NOW)?.payload.profiles.map((p) => p.name) ?? [];
}

/**
 * Writes a mirror the way Headerbench 1.0.2 does (v1 payload, no tombstones) as `device`, and
 * returns the change event Chrome would deliver.
 */
function writeMirror(
  t: Setup,
  device: string,
  payload: { profiles: Profile[]; variables: Variable[] },
): Record<string, chrome.storage.StorageChange> {
  const text = JSON.stringify(payload);
  const bytes = 'hb.0'.length + new TextEncoder().encode(JSON.stringify(text)).length;
  const meta = { v: 1, device, writtenAt: t.clock.now, chunks: 1, bytes };
  t.api.storage.sync.data = { 'hb.0': text, 'hb.meta': meta };
  return { 'hb.0': { newValue: text }, 'hb.meta': { newValue: meta } };
}

/** Delivers `from`'s last mirror write to `to`, as Chrome sync would, and lets `to` settle. */
async function deliver(from: Setup, to: Setup): Promise<void> {
  const data = from.api.storage.sync.data;
  await to.bg.onSyncChanged({ 'hb.meta': { newValue: data['hb.meta'] } });
  await to.bg.idle();
  await from.bg.onSyncChanged({ 'hb.meta': { newValue: to.api.storage.sync.data['hb.meta'] } });
  await from.bg.idle();
}

/** Reorders `t`'s profiles by name at `at`, the way dragging in the editor does, and syncs. */
async function reorder(t: Setup, at: number, order: string[]): Promise<void> {
  t.clock.now = at;
  const state = (await t.call({ type: 'getState' })).state;
  const byName = new Map(state.profiles.map((p) => [p.name, p]));
  await t.save({ ...state, profiles: order.map((name) => byName.get(name) as Profile) });
  await t.bg.idle();
}

/** Two Pro devices with sync on that share profiles One and Two. */
async function twoDevices() {
  const a = setup();
  await a.call({ type: 'applyLicense', key: licenseKey() });
  const one = profile('One', { updatedAt: NOW });
  const two = profile('Two', { updatedAt: NOW });
  const base = (await a.call({ type: 'getState' })).state;
  await a.save({ ...base, profiles: [one, two], settings: { ...base.settings, sync: true } });
  await a.bg.idle();
  const b = setup({ sync: a.api.storage.sync });
  await b.call({ type: 'applyLicense', key: licenseKey() });
  const bBase = (await b.call({ type: 'getState' })).state;
  await b.save({ ...bBase, settings: { ...bBase.settings, sync: true } });
  await b.bg.idle();
  expect(await names(b)).toEqual(['One', 'Two']);
  return { a, b, one, two };
}

describe('background licence refresh', () => {
  /** A setup whose fetch is counted and answers with `respond()`. */
  function counted(respond: () => Response) {
    const calls: { url: string; body: string }[] = [];
    const t = setup({
      fetch: async (url, init) => {
        calls.push({ url: String(url), body: String(init?.body) });
        return respond();
      },
    });
    return { t, calls };
  }
  const expiringIn = (ms: number) => licenseKey({ exp: Math.floor((NOW + ms) / 1000) });

  it('arms a 6-hourly alarm on install, update and browser start', async () => {
    const { t } = counted(() => new Response('{}'));
    await t.bg.onInstalled({ reason: 'update' });
    expect(t.fake.alarms.get(LICENSE_ALARM)).toEqual({ delayInMinutes: 360, periodInMinutes: 360 });
    t.fake.alarms.clear();
    await t.bg.onStartup();
    expect(t.fake.alarms.get(LICENSE_ALARM)?.periodInMinutes).toBe(360);
  });

  it('arms the alarm when the service worker starts, e.g. after disable and enable', async () => {
    const { t } = counted(() => new Response('{}'));
    t.bg.register();
    await t.bg.idle();
    await Promise.resolve();
    expect(t.fake.alarms.get(LICENSE_ALARM)).toEqual({ delayInMinutes: 360, periodInMinutes: 360 });
  });

  it('keeps a running licence alarm and replaces one with a different period', async () => {
    const { t } = counted(() => new Response('{}'));
    const running = { when: NOW + 2 * HOUR, periodInMinutes: 360 };
    t.fake.alarms.set(LICENSE_ALARM, running);
    await t.bg.onStartup();
    t.bg.register();
    await t.bg.idle();
    expect(t.fake.alarms.get(LICENSE_ALARM)).toBe(running);
    t.fake.alarms.set(LICENSE_ALARM, { when: NOW, periodInMinutes: 60 });
    await t.bg.onInstalled({ reason: 'update' });
    expect(t.fake.alarms.get(LICENSE_ALARM)).toEqual({ delayInMinutes: 360, periodInMinutes: 360 });
  });

  // Regression: near the period end the server re-signs the same exp with a new iat every 6 h;
  // each save bumped rev, so an open editor hit "changed in another window".
  it('does not store a refreshed key that only differs by when it was signed', async () => {
    const exp = Math.floor((NOW + 5 * DAY) / 1000);
    const stored = licenseKey({ exp, iat: Math.floor(NOW / 1000) - DAY / 1000 });
    const resigned = licenseKey({ exp, iat: Math.floor(NOW / 1000) });
    expect(resigned).not.toBe(stored);
    const { t, calls } = counted(() => Response.json({ key: resigned }));
    await t.call({ type: 'applyLicense', key: stored });
    const before = await t.call({ type: 'getState' });
    await t.bg.onAlarm({ name: LICENSE_ALARM });
    const manual = await t.call({ type: 'refreshLicense', auto: false });
    expect(calls).toHaveLength(2);
    const after = await t.call({ type: 'getState' });
    expect(after.rev).toBe(before.rev);
    expect(after.state.settings.licenseKey).toBe(stored);
    expect(manual.snapshot.rev).toBe(before.rev);
    expect(after.licenseRefreshError).toBeNull();
  });

  it('stores a renewed key from a background refresh without bumping rev', async () => {
    const fresh = expiringIn(60 * DAY);
    const { t } = counted(() => Response.json({ key: fresh }));
    await t.call({ type: 'applyLicense', key: expiringIn(10 * DAY) });
    const before = await t.call({ type: 'getState' });
    await t.bg.onAlarm({ name: LICENSE_ALARM });
    const after = await t.call({ type: 'getState' });
    expect(after.state.settings.licenseKey).toBe(fresh);
    expect(after.rev).toBe(before.rev);
    // The editor, opened before the refresh, can still save.
    const saved = await t.call({ type: 'saveState', state: before.state, rev: before.rev });
    expect(saved.state.settings.licenseKey).toBe(fresh);
  });

  it('refreshes a yearly licence in its last 14 days: one request per 6 hours', async () => {
    const fresh = expiringIn(60 * DAY);
    const { t, calls } = counted(() => Response.json({ key: fresh }));
    const old = expiringIn(10 * DAY);
    await t.call({ type: 'applyLicense', key: old });
    await t.bg.onAlarm({ name: LICENSE_ALARM });
    await t.bg.onAlarm({ name: LICENSE_ALARM });
    await t.call({ type: 'refreshLicense', auto: true });
    expect(calls).toEqual([
      { url: 'https://headerbench.com/api/license/refresh', body: JSON.stringify({ key: old }) },
    ]);
    const snap = await t.call({ type: 'getState' });
    expect(snap.state.settings.licenseKey).toBe(fresh);
    expect(snap.licenseRefreshError).toBeNull();
  });

  it('makes no request when nothing is due: far from expiry, lifetime, expired or no key', async () => {
    const { t, calls } = counted(() => new Response('{}', { status: 500 }));
    await t.bg.onAlarm({ name: LICENSE_ALARM });
    await t.call({ type: 'applyLicense', key: expiringIn(20 * DAY) });
    await t.bg.onAlarm({ name: LICENSE_ALARM });
    await t.bg.onStartup();
    t.clock.now = NOW + 21 * DAY;
    await t.bg.onAlarm({ name: LICENSE_ALARM });
    expect(calls).toHaveLength(0);

    const life = counted(() => new Response('{}'));
    await life.t.call({
      type: 'applyLicense',
      key: licenseKey({ plan: 'pro_lifetime', exp: null, sub: null }),
    });
    await life.t.bg.onAlarm({ name: LICENSE_ALARM });
    expect(life.calls).toHaveLength(0);
  });

  it('records a network failure for Settings and changes nothing else', async () => {
    const t = setup({
      fetch: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    const old = expiringIn(5 * DAY);
    await t.call({ type: 'applyLicense', key: old });
    const before = await t.call({ type: 'getState' });
    t.clock.now = NOW + HOUR;
    await t.bg.onAlarm({ name: LICENSE_ALARM });
    const after = await t.call({ type: 'getState' });
    expect(after.rev).toBe(before.rev);
    expect(after.state).toEqual(before.state);
    expect(after.pro).toMatchObject({ pro: true, source: 'license' });
    expect(after.licenseRefreshError).toEqual({
      at: NOW + HOUR,
      code: 'network',
      message: expect.stringMatching(/Could not reach headerbench\.com/),
    });
  });

  it('records a 410 from the server, then clears it once a refresh succeeds', async () => {
    let respond = () =>
      Response.json(
        { reason: 'subscription_inactive', message: 'Your subscription was cancelled on Oct 1.' },
        { status: 410 },
      );
    const fresh = expiringIn(60 * DAY);
    const t = setup({ fetch: async () => respond() });
    await t.call({ type: 'applyLicense', key: expiringIn(5 * DAY) });
    await t.bg.onStartup();
    expect((await t.call({ type: 'getState' })).licenseRefreshError).toMatchObject({
      code: 'subscription_inactive',
      message: 'Your subscription was cancelled on Oct 1.',
    });
    respond = () => Response.json({ key: fresh });
    t.clock.now = NOW + 7 * HOUR;
    await t.bg.onAlarm({ name: LICENSE_ALARM });
    const snap = await t.call({ type: 'getState' });
    expect(snap.licenseRefreshError).toBeNull();
    expect(snap.state.settings.licenseKey).toBe(fresh);
  });

  it('makes one request when several triggers fire at once', async () => {
    let count = 0;
    const t = setup({ fetch: async () => (count++, new Response('{}', { status: 503 })) });
    await t.call({ type: 'applyLicense', key: expiringIn(5 * DAY) });
    await Promise.all([
      t.bg.onAlarm({ name: LICENSE_ALARM }),
      t.bg.dispatch({ type: 'refreshLicense', auto: true }),
      t.bg.onInstalled({ reason: 'update' }),
    ]);
    expect(count).toBe(1);
  });

  it('accepts a shorter key for the same licence from the server (60-day keys)', async () => {
    const shorter = expiringIn(60 * DAY);
    const t = setup({ fetch: async () => Response.json({ key: shorter }) });
    await t.call({ type: 'applyLicense', key: licenseKey() });
    const outcome = await t.call({ type: 'refreshLicense', auto: false });
    expect(outcome.snapshot.state.settings.licenseKey).toBe(shorter);
    expect(outcome.expiresAt).toBe(NOW + 60 * DAY);
  });

  it('lands a shorter same-licence key in the background without looping', async () => {
    let count = 0;
    const t = setup({
      fetch: async () => (count++, Response.json({ key: expiringIn(12 * DAY) })),
    });
    await t.call({ type: 'applyLicense', key: expiringIn(13 * DAY) });
    await t.bg.onAlarm({ name: LICENSE_ALARM });
    expect((await t.call({ type: 'getState' })).pro.licenseExpiresAt).toBe(NOW + 12 * DAY);
    // Still inside the 14-day window, but the 6-hour throttle holds.
    t.clock.now = NOW + 5 * HOUR;
    await t.bg.onAlarm({ name: LICENSE_ALARM });
    expect(count).toBe(1);
    t.clock.now = NOW + 7 * HOUR;
    await t.bg.onAlarm({ name: LICENSE_ALARM });
    expect(count).toBe(2);
  });

  it('keeps the stored key when the server sends a different licence that ends sooner', async () => {
    const other = licenseKey({
      lid: 'sub_02',
      sub: 'sub_02',
      exp: Math.floor((NOW + 60 * DAY) / 1000),
    });
    const t = setup({ fetch: async () => Response.json({ key: other }) });
    const current = licenseKey();
    await t.call({ type: 'applyLicense', key: current });
    const outcome = await t.call({ type: 'refreshLicense', auto: false });
    expect(outcome.snapshot.state.settings.licenseKey).toBe(current);
    expect(outcome.expiresAt).toBe(NOW + 300 * DAY);
  });

  it('never replaces a lifetime licence with a yearly key of any lid', async () => {
    const t = setup();
    const lifetime = licenseKey({ plan: 'pro_lifetime', exp: null, sub: null, lid: 'sub_01' });
    await t.call({ type: 'applyLicense', key: lifetime });
    expect(await t.bg.dispatch({ type: 'applyLicense', key: licenseKey() })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/lifetime licence is already active/),
    });
    expect((await t.call({ type: 'getState' })).state.settings.licenseKey).toBe(lifetime);
  });
});

describe('trial', () => {
  const proProfile = () =>
    profile('Pro', {
      mocks: [
        {
          id: 'm',
          enabled: true,
          kind: 'urlFilter',
          pattern: '/api',
          contentType: 'application/json',
          body: '{}',
          comment: '',
        },
      ],
    });

  it('does not start for someone whose licence has expired', async () => {
    const t = setup();
    await t.call({
      type: 'applyLicense',
      key: licenseKey({ exp: Math.floor((NOW + DAY) / 1000) }),
    });
    t.clock.now = NOW + 2 * DAY;
    let snap = await t.save({
      ...(await t.call({ type: 'getState' })).state,
      profiles: [proProfile()],
    });
    expect(snap.state.settings.trialStartedAt).toBeNull();
    expect(snap.pro).toMatchObject({ pro: false, plan: 'pro_yearly' });
    snap = await t.call({ type: 'startTrial' });
    expect(snap.state.settings.trialStartedAt).toBeNull();
  });

  it('starts on request for someone who never had a licence', async () => {
    const t = setup();
    const snap = await t.call({ type: 'startTrial' });
    expect(snap.state.settings.trialStartedAt).toBe(NOW);
  });
});

describe('tab-scoped activations', () => {
  it('keeps one profile on in several tabs and turns it off per tab', async () => {
    const t = setup();
    const p = profile('Tabs', { requestHeaders: [header('X-Tab', '1')] });
    await t.save(stateWith([p]));
    await t.call({ type: 'activate', profileId: p.id, tabId: 1, pauseAt: null });
    let snap = await t.call({ type: 'activate', profileId: p.id, tabId: 2, pauseAt: null });
    expect(snap.state.settings.activations).toEqual([
      { profileId: p.id, tabId: 1, pauseAt: null },
      { profileId: p.id, tabId: 2, pauseAt: null },
    ]);
    expect(t.fake.sessionRules.map((r) => r.condition.tabIds)).toEqual([[1], [2]]);

    snap = await t.call({ type: 'deactivate', profileId: p.id, tabId: 1 });
    expect(snap.state.settings.activations).toEqual([{ profileId: p.id, tabId: 2, pauseAt: null }]);
    await t.bg.onTabRemoved(2);
    expect((await t.call({ type: 'getState' })).state.settings.activations).toEqual([]);
    expect(t.fake.sessionRules).toEqual([]);
  });

  it('turning on everywhere replaces the tabs; deactivate without a tab turns all off', async () => {
    const t = setup();
    const p = profile('Tabs', { requestHeaders: [header('X-Tab', '1')] });
    await t.save(stateWith([p]));
    await t.call({ type: 'activate', profileId: p.id, tabId: 1, pauseAt: null });
    await t.call({ type: 'activate', profileId: p.id, tabId: 2, pauseAt: null });
    let snap = await t.call({ type: 'activate', profileId: p.id, tabId: null, pauseAt: null });
    expect(snap.state.settings.activations).toEqual([
      { profileId: p.id, tabId: null, pauseAt: null },
    ]);
    snap = await t.call({ type: 'activate', profileId: p.id, tabId: 3, pauseAt: null });
    expect(snap.state.settings.activations).toEqual([{ profileId: p.id, tabId: 3, pauseAt: null }]);
    await t.call({ type: 'activate', profileId: p.id, tabId: 4, pauseAt: null });
    snap = await t.call({ type: 'deactivate', profileId: p.id });
    expect(snap.state.settings.activations).toEqual([]);
  });
});

describe('rule install failures', () => {
  it('leaves the session rules alone when the dynamic list cannot be installed', async () => {
    const t = setup();
    const p = profile('Tab', { requestHeaders: [header('X-A', '1')] });
    await t.save(stateWith([p]));
    await t.call({ type: 'activate', profileId: p.id, tabId: 5, pauseAt: null });
    const session = [...t.fake.sessionRules];
    const sessionUpdates = t.fake.updates.sessionRules;
    t.fake.failList.dynamicRules = 'Internal error.';
    const snap = await t.call({ type: 'activate', profileId: p.id, tabId: 6, pauseAt: null });
    expect(snap.ruleError).toBe('Chrome refused the dynamic rules: Internal error.');
    expect(t.fake.updates.sessionRules).toBe(sessionUpdates);
    expect(t.fake.sessionRules).toEqual(session);
  });

  it('splits a rejected header rule so only the bad row is dropped and explained', async () => {
    const t = setup();
    const good = header('X-Good', '1');
    const bad = header('X-Bad', '2');
    const reply = { ...header('X-Reply', '3'), id: 'reply' };
    const p = profile('Mixed headers', {
      requestHeaders: [good, bad],
      responseHeaders: [reply],
    });
    t.fake.rejectHeader.add('x-bad');
    const snap = await t.save(
      stateWith([p], { activations: [{ profileId: p.id, tabId: null, pauseAt: null }] }),
    );
    const installed = t.fake.dynamicRules.map((r) => [
      ...(r.action.requestHeaders ?? []).map((h) => h.header),
      ...(r.action.responseHeaders ?? []).map((h) => h.header),
    ]);
    expect(installed).toEqual([['x-good'], ['X-Reply']]);
    expect(new Set(t.fake.dynamicRules.map((r) => r.priority)).size).toBe(1);
    expect(t.fake.dynamicRules.every((r) => r.id > 1)).toBe(true);
    const rejected = snap.warnings.filter((w) => w.message.startsWith('Chrome rejected'));
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ profileId: p.id, itemIds: [bad.id] });
    expect(snap.ruleError).toBeNull();

    // Matched split rules still map back to their rows.
    t.fake.matched = t.fake.dynamicRules.map((r) => ({
      rule: { ruleId: r.id, rulesetId: '_dynamic' },
      tabId: 8,
      timeStamp: NOW,
    }));
    const matches = await t.call({ type: 'getMatchesForTab', tabId: 8 });
    if (matches.unavailable) throw new Error('should be available');
    expect(matches.applied.map((e) => e.itemId).sort()).toEqual([good.id, 'reply'].sort());
  });
});

describe('rule install: rules whose condition Chrome refuses', () => {
  const allOn = (profiles: Profile[]) =>
    stateWith(profiles, {
      activations: profiles.map((p) => ({ profileId: p.id, tabId: null, pauseAt: null })),
    });

  /** A profile filtered by a regex the fake Chrome refuses, with `headers` request headers. */
  function badProfile(t: Setup, n: number, headers: number): Profile {
    const regex = `^https://bad${n}\\.example/.*`;
    t.fake.rejectRegex.add(regex);
    return profile(`Bad ${n}`, {
      filters: [{ id: `f${n}`, enabled: true, kind: 'regex', value: regex, exclude: false }],
      requestHeaders: Array.from({ length: headers }, (_, i) => header(`X-H${i}`, String(i))),
    });
  }

  // Regression: each header name of a split rule cost one of 20 attempts, so a few such
  // profiles made Chrome-facing installs give up and keep stale rules.
  it('drops a split rule after two rejected parts and reports each row once', async () => {
    const t = setup();
    const bad = [1, 2, 3].map((n) => badProfile(t, n, 5));
    const good = profile('Good', { requestHeaders: [header('X-Good', '1')] });
    const snap = await t.save(allOn([...bad, good]));
    expect(snap.ruleError).toBeNull();
    expect(t.fake.dynamicRules.map((r) => r.action.requestHeaders?.[0]?.header)).toEqual([
      'x-good',
    ]);
    const rejected = snap.warnings.filter((w) => w.message.startsWith('Chrome rejected'));
    for (const p of bad) {
      const items = rejected.filter((w) => w.profileId === p.id).flatMap((w) => w.itemIds);
      expect(items.sort()).toEqual(p.requestHeaders.map((h) => h.id).sort());
    }
    // Per bad profile: the whole rule, then two parts. Plus the final successful update.
    expect(t.fake.updates.dynamicRules).toBe(3 * 3 + 1);
  });

  it('counts rejections per compiled rule, not per split part, against the cap', async () => {
    const t = setup();
    // 8 profiles × 5 headers: 8 refused rules, well under the cap, though 24 updates fail.
    const bad = Array.from({ length: 8 }, (_, i) => badProfile(t, i, 5));
    const good = profile('Good', { requestHeaders: [header('X-Good', '1')] });
    const snap = await t.save(allOn([...bad, good]));
    expect(snap.ruleError).toBeNull();
    expect(t.fake.dynamicRules).toHaveLength(1);

    const many = setup();
    const tooMany = Array.from({ length: 21 }, (_, i) => badProfile(many, i, 1));
    const capped = await many.save(allOn(tooMany));
    expect(capped.ruleError).toBe(
      'Chrome rejected more than 20 dynamic rules. The previous rules stay in place.',
    );
  });
});

describe('storage full', () => {
  it('refuses the save with a plain reason and keeps the stored state', async () => {
    const t = setup();
    const kept = await t.save(stateWith([profile('Kept')]));
    t.api.storage.local.quotaBytes = t.api.storage.local.bytes() + 1000;
    const big = profile('Big', {
      mocks: [
        {
          id: 'm',
          enabled: true,
          kind: 'urlFilter',
          pattern: '/x',
          contentType: 'text/plain',
          body: 'y'.repeat(50_000),
          comment: '',
        },
      ],
    });
    const reply = await t.bg.dispatch({
      type: 'saveState',
      state: { ...kept.state, profiles: [...kept.state.profiles, big] },
      rev: kept.rev,
    });
    expect(reply).toEqual({
      ok: false,
      code: 'storage_full',
      error: "Headerbench's storage is full (Chrome allows 10 MB). Remove large mocks or profiles.",
    });
    t.api.storage.local.quotaBytes = null;
    const fresh = setup();
    fresh.api.storage.local.data = t.api.storage.local.data;
    expect((await fresh.call({ type: 'getState' })).state.profiles.map((p) => p.name)).toEqual([
      'Kept',
    ]);
  });
});
