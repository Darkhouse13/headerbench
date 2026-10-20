import { compile, proStatus, DEV_LICENSE_PUBLIC_KEY } from '@headerbench/core';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WAKE_ALARM } from '../src/sw/background';
import { localDay } from '../src/review';
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
    const filters = Array.from({ length: 4600 }, (_, i) => domain(`h${i}.example.com`));
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
    const earlier = licenseKey({ exp: Math.floor((NOW + 30 * DAY) / 1000) });
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
    const text = JSON.stringify({ profiles: [remote], variables: [] });
    const meta = {
      v: 1,
      device: 'other-device',
      writtenAt: NOW + 1,
      chunks: 1,
      bytes: text.length,
    };
    t.api.storage.sync.data = { 'hb.0': text, 'hb.meta': meta };
    await t.bg.onSyncChanged({ 'hb.meta': { newValue: meta } });
    expect((await t.call({ type: 'getState' })).state.profiles.map((p) => p.name)).toEqual([
      'From laptop',
    ]);
  });
});
