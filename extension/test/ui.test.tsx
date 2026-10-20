import { fireEvent, screen, waitFor, within } from '@testing-library/preact';
import { describe, expect, it } from 'vitest';
import { accessExplainer, checkAccess, originsOverlap } from '../src/ui/access';
import { AppShell } from '../src/ui/editor/AppShell';
import {
  describeEffect,
  groupGrants,
  originLabel,
  originsLabel,
  proSummary,
} from '../src/ui/format';
import { Popup } from '../src/ui/popup/Popup';
import { Welcome } from '../src/ui/welcome/Welcome';
import { DAY, NOW, domain, header, licenseKey, profile, stateWith } from './helpers';
import { uiSetup } from './ui-harness';

describe('site access logic', () => {
  it('matches granted patterns against what a profile needs', () => {
    expect(originsOverlap('*://api.example.com/*', 'https://api.example.com/*')).toBe(true);
    expect(originsOverlap('*://*.example.com/*', 'http://a.b.example.com/*')).toBe(true);
    expect(originsOverlap('https://*/*', 'https://x.org/*')).toBe(true);
    expect(originsOverlap('https://api.example.com/*', 'http://api.example.com/*')).toBe(false);
    expect(originsOverlap('*://api.example.com/*', '*://example.org/*')).toBe(false);
  });

  it('explains exactly which sites are needed and why', async () => {
    const t = uiSetup();
    const scoped = profile('Api', {
      requestHeaders: [header('X-A', '1')],
      filters: [domain('api.example.com')],
    });
    const state = await checkAccess(t.platform, scoped);
    expect(state).toMatchObject({ status: 'needed', label: 'api.example.com' });
    expect(accessExplainer('api.example.com', scoped)).toBe(
      'Headerbench needs access to api.example.com to change its headers. It reads nothing.',
    );
    const unscoped = profile('All', { requestHeaders: [header('X-A', '1')] });
    expect(accessExplainer('all sites', unscoped)).toMatch(/no domain filter/);
    t.fake.granted
      .add('https://api.example.com/*')
      .add('http://api.example.com/*')
      .add('https://*.api.example.com/*')
      .add('http://*.api.example.com/*');
    expect(await checkAccess(t.platform, scoped)).toEqual({ status: 'granted' });
    expect(await checkAccess(t.platform, profile('Blocks only'))).toEqual({ status: 'granted' });
  });

  it('labels origins for people', () => {
    expect(originsLabel(['*://a.com/*', '*://*.a.com/*'])).toBe('a.com');
    expect(originsLabel(['https://*/*', 'http://*/*'])).toBe('all sites');
    expect(originLabel('http://127.0.0.1/*')).toBe('127.0.0.1 (http only)');
    expect(originLabel('*://*.example.com/*')).toBe('Subdomains of example.com');
    expect(
      describeEffect({ type: 'header', direction: 'response', header: 'X', operation: 'remove' }),
    ).toEqual({
      action: 'Remove response header X',
      detail: null,
    });
  });

  it('groups a domain and its subdomains into one granted site', () => {
    expect(
      groupGrants([
        '*://*.localhost/*',
        '*://api.example.com/*',
        'https://*/*',
        '*://localhost/*',
        '*://*.api.example.com/*',
        'http://127.0.0.1/*',
      ]),
    ).toEqual([
      { label: 'All https:// sites', origins: ['https://*/*'] },
      { label: '127.0.0.1 (http only)', origins: ['http://127.0.0.1/*'] },
      {
        label: 'api.example.com and subdomains',
        origins: ['*://api.example.com/*', '*://*.api.example.com/*'],
      },
      { label: 'localhost and subdomains', origins: ['*://localhost/*', '*://*.localhost/*'] },
    ]);
    expect(
      groupGrants([
        'https://a.test/*',
        'http://a.test/*',
        'https://*.a.test/*',
        'http://*.a.test/*',
        'https://b.test/*',
      ]),
    ).toEqual([
      {
        label: 'a.test and subdomains',
        origins: ['https://a.test/*', 'http://a.test/*', 'https://*.a.test/*', 'http://*.a.test/*'],
      },
      { label: 'b.test (https only)', origins: ['https://b.test/*'] },
    ]);
    expect(groupGrants(['*://*.example.com/*'])).toEqual([
      { label: 'Subdomains of example.com', origins: ['*://*.example.com/*'] },
    ]);
  });

  it('summarises Pro state from real data', () => {
    expect(
      proSummary(
        { pro: false, source: null, trialEndsAt: null, licenseExpiresAt: null, plan: null },
        NOW,
      ),
    ).toBe('Free plan');
    expect(
      proSummary(
        {
          pro: true,
          source: 'trial',
          trialEndsAt: NOW + 3 * DAY,
          licenseExpiresAt: null,
          plan: null,
        },
        NOW,
      ),
    ).toBe('Pro trial: 3 days left');
    expect(
      proSummary(
        { pro: false, source: null, trialEndsAt: NOW - 1, licenseExpiresAt: null, plan: null },
        NOW,
      ),
    ).toMatch(/trial has ended/);
  });
});

describe('popup', () => {
  it('shows an empty state with one clear action', async () => {
    const t = uiSetup();
    await t.mount(<Popup />);
    expect(screen.getByText('No profiles yet')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Create a profile/ })).toBeTruthy();
    expect(screen.getByText('Free plan')).toBeTruthy();
  });

  it('lists real profiles and turns one on through the service worker', async () => {
    const t = uiSetup();
    const p = profile('Staging API', {
      env: 'staging',
      requestHeaders: [header('X-Api-Key', 'k')],
      filters: [domain('api.staging.example.com')],
    });
    await t.save(stateWith([p]));
    await t.mount(<Popup />);
    expect(screen.getByText('Staging API')).toBeTruthy();
    expect(screen.getByText('1 header · api.staging.example.com')).toBeTruthy();
    fireEvent.click(screen.getByRole('switch', { name: 'Turn on Staging API' }));
    await waitFor(() => expect(t.fake.dynamicRules).toHaveLength(1));
    expect(await screen.findByRole('switch', { name: 'Turn off Staging API' })).toBeTruthy();
  });

  it('asks for site access after turning a profile on, and marks a refusal as blocked', async () => {
    const t = uiSetup();
    const p = profile('Api', {
      requestHeaders: [header('X-A', '1')],
      filters: [domain('api.example.com')],
    });
    await t.save(
      stateWith([p], { activations: [{ profileId: p.id, tabId: null, pauseAt: null }] }),
    );
    await t.mount(<Popup />);
    expect(
      await screen.findByText(/needs access to api.example.com to change its headers/),
    ).toBeTruthy();
    t.fake.grantOnRequest = false;
    fireEvent.click(screen.getByRole('button', { name: 'Grant access' }));
    expect(
      await screen.findByText(/Blocked by Chrome: no site access to api.example.com/),
    ).toBeTruthy();
    expect(t.fake.requests).toEqual([
      [
        'http://*.api.example.com/*',
        'http://api.example.com/*',
        'https://*.api.example.com/*',
        'https://api.example.com/*',
      ],
    ]);
    t.fake.grantOnRequest = true;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByText(/Blocked by Chrome/)).toBeNull());
  });

  it('asks for the profile’s sites and this page in one request when turning a profile on', async () => {
    const t = uiSetup({ tab: { id: 5, url: 'http://localhost:5173/app' } });
    const p = profile('Local API', {
      requestHeaders: [header('X-Debug', '1')],
      filters: [domain('127.0.0.1')],
    });
    await t.save(stateWith([p]));
    await t.mount(<Popup />);
    await screen.findByRole('region', { name: 'Applied on this tab' });
    t.fake.grantOnRequest = false;
    fireEvent.click(screen.getByRole('switch', { name: 'Turn on Local API' }));
    await waitFor(() =>
      expect(t.fake.requests).toEqual([
        [
          'http://*.127.0.0.1/*',
          'http://127.0.0.1/*',
          'https://*.127.0.0.1/*',
          'https://127.0.0.1/*',
          'http://localhost/*',
        ],
      ]),
    );
    expect(await screen.findByText(/Blocked by Chrome: no site access to 127.0.0.1/)).toBeTruthy();
    expect(t.fake.dynamicRules).toHaveLength(1);
  });

  it('names this page in the explainer when Chrome needs it too', async () => {
    const t = uiSetup({ tab: { id: 5, url: 'http://localhost:5173/app' } });
    const p = profile('Local API', {
      requestHeaders: [header('X-Debug', '1')],
      filters: [domain('127.0.0.1')],
    });
    await t.save(
      stateWith([p], { activations: [{ profileId: p.id, tabId: null, pauseAt: null }] }),
    );
    await t.mount(<Popup />);
    expect(
      await screen.findByText(
        'Headerbench needs access to 127.0.0.1 and to this page (localhost), which sends the requests, to change its headers. It reads nothing.',
      ),
    ).toBeTruthy();
  });

  it('offers to grant this page when a profile is on but the page is not granted', async () => {
    const t = uiSetup({ tab: { id: 5, url: 'http://localhost:5173/app' } });
    const p = profile('Local API', {
      requestHeaders: [header('X-Debug', '1')],
      filters: [domain('127.0.0.1')],
    });
    t.fake.granted
      .add('https://127.0.0.1/*')
      .add('http://127.0.0.1/*')
      .add('https://*.127.0.0.1/*')
      .add('http://*.127.0.0.1/*');
    await t.save(
      stateWith([p], { activations: [{ profileId: p.id, tabId: null, pauseAt: null }] }),
    );
    await t.mount(<Popup />);
    const applied = await screen.findByRole('region', { name: 'Applied on this tab' });
    expect(
      await within(applied).findByText(
        'Chrome only lets Headerbench change requests sent from pages it can access. Grant access to localhost?',
      ),
    ).toBeTruthy();
    fireEvent.click(within(applied).getByRole('button', { name: 'Grant' }));
    await waitFor(() => expect(t.fake.requests).toEqual([['http://localhost/*']]));
    await waitFor(() =>
      expect(within(applied).queryByText(/Grant access to localhost/)).toBeNull(),
    );
  });

  it('does not ask about the page when no profile that is on changes requests', async () => {
    const t = uiSetup({ tab: { id: 5, url: 'http://localhost:5173/app' } });
    const p = profile('Blocks only', {
      blocks: [{ id: 'b', enabled: true, kind: 'urlFilter', pattern: '/ads', comment: '' }],
    });
    await t.save(
      stateWith([p], { activations: [{ profileId: p.id, tabId: null, pauseAt: null }] }),
    );
    await t.mount(<Popup />);
    await screen.findByText(/Nothing applied|Checking/);
    expect(screen.queryByText(/Grant access to localhost/)).toBeNull();
  });

  it('confirms before turning on a Prod profile', async () => {
    const t = uiSetup();
    const p = profile('Prod', {
      env: 'prod',
      requestHeaders: [header('X-A', '1')],
      filters: [domain('api.example.com')],
    });
    await t.save(stateWith([p]));
    await t.mount(<Popup />);
    fireEvent.click(screen.getByRole('switch', { name: 'Turn on Prod' }));
    const dialog = await screen.findByRole('dialog', { hidden: true });
    expect(within(dialog).getByText(/is tagged Prod/)).toBeTruthy();
    expect(t.fake.dynamicRules).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Turn on', hidden: true }));
    await waitFor(() => expect(t.fake.dynamicRules).toHaveLength(1));
  });

  it('shows what applied on this tab from Chrome’s matched rules', async () => {
    const t = uiSetup({ tab: { id: 5, url: 'https://api.example.com/app' } });
    const p = profile('Staging API', { requestHeaders: [header('X-Api-Key', 'stg_1')] });
    await t.save(
      stateWith([p], { activations: [{ profileId: p.id, tabId: null, pauseAt: null }] }),
    );
    t.fake.matched = [{ rule: { ruleId: 1, rulesetId: '_dynamic' }, tabId: 5, timeStamp: NOW }];
    await t.mount(<Popup />);
    expect(await screen.findByText('Set X-Api-Key')).toBeTruthy();
    expect(screen.getByText('stg_1')).toBeTruthy();
    expect(screen.getByText('api.example.com')).toBeTruthy();
  });

  it('explains why nothing applied when a rule lacks site access', async () => {
    const t = uiSetup({ tab: { id: 5, url: 'https://api.example.com/app' } });
    const p = profile('Api', {
      requestHeaders: [header('X-A', '1')],
      filters: [domain('api.example.com')],
    });
    await t.save(
      stateWith([p], { activations: [{ profileId: p.id, tabId: null, pauseAt: null }] }),
    );
    await t.mount(<Popup />);
    expect(
      await screen.findByText(
        /Nothing applied since this page loaded. No site access for api.example.com/,
      ),
    ).toBeTruthy();
  });

  it('shows the review prompt once it is due, and hides it for good on Not now', async () => {
    const t = uiSetup();
    const p = profile('Used', { requestHeaders: [header('X-A', '1')] });
    await t.save(
      stateWith([p], { activations: [{ profileId: p.id, tabId: null, pauseAt: null }] }),
    );
    for (let d = 0; d < 3; d++) {
      t.clock.now = NOW + d * DAY;
      await t.call({ type: 'getState' });
    }
    await t.mount(<Popup />);
    expect(await screen.findByText(/Rate it on the Chrome Web Store/)).toBeTruthy();
    await waitFor(async () =>
      expect((await t.call({ type: 'getState' })).state.settings.review.state).toBe('shown'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    await waitFor(() => expect(screen.queryByText(/Rate it on/)).toBeNull());
    expect((await t.call({ type: 'getState' })).state.settings.review.state).toBe('dismissed');
  });
});

describe('editor', () => {
  it('renders a profile’s headers and inline Chrome warnings', async () => {
    const t = uiSetup();
    const p = profile('Staging API', {
      requestHeaders: [header('Authorization', 'Bearer abc'), header('X-Custom', 'a', 'append')],
    });
    await t.save(
      stateWith([p], { activations: [{ profileId: p.id, tabId: null, pauseAt: null }] }),
    );
    location.hash = `#/profile/${p.id}`;
    await t.mount(<AppShell />);
    expect(screen.getByRole('heading', { name: 'Staging API' })).toBeTruthy();
    expect((screen.getAllByLabelText('Header name')[0] as HTMLInputElement).value).toBe(
      'Authorization',
    );
    expect(
      screen.getByText(
        'Chrome cannot append to the X-Custom request header, so it is set instead.',
      ),
    ).toBeTruthy();
  });

  it('asks only for the sites when turned on in the editor, then explains the page', async () => {
    const t = uiSetup();
    const p = profile('Local API', {
      requestHeaders: [header('X-Debug', '1')],
      filters: [domain('127.0.0.1')],
    });
    await t.save(stateWith([p]));
    location.hash = `#/profile/${p.id}`;
    await t.mount(<AppShell />);
    expect(screen.queryByText(/Requests sent from other sites/)).toBeNull();
    fireEvent.click(screen.getAllByRole('switch', { name: 'Turn on Local API' })[0] as HTMLElement);
    await waitFor(() =>
      expect(t.fake.requests).toEqual([
        [
          'http://*.127.0.0.1/*',
          'http://127.0.0.1/*',
          'https://*.127.0.0.1/*',
          'https://127.0.0.1/*',
        ],
      ]),
    );
    const note = await screen.findByText(
      "Requests sent from other sites (like your localhost app) also need access to that site. Open Headerbench's popup on that page to allow it, or allow all sites.",
    );
    const banner = note.closest('.banner') as HTMLElement;
    expect(banner.classList.contains('banner--info')).toBe(true);
    fireEvent.click(within(banner).getByRole('button', { name: 'Allow on all sites' }));
    await waitFor(() => expect(t.fake.requests.at(-1)).toEqual(['https://*/*', 'http://*/*']));
    await waitFor(() => expect(screen.queryByText(/Requests sent from other sites/)).toBeNull());
  });

  it('offers all sites next to Grant access in the editor explainer', async () => {
    const t = uiSetup();
    const p = profile('Api', {
      requestHeaders: [header('X-A', '1')],
      filters: [domain('api.example.com')],
    });
    await t.save(
      stateWith([p], { activations: [{ profileId: p.id, tabId: null, pauseAt: null }] }),
    );
    location.hash = `#/profile/${p.id}`;
    await t.mount(<AppShell />);
    await screen.findByText(/needs access to api.example.com/);
    fireEvent.click(screen.getByRole('button', { name: 'Allow on all sites' }));
    await waitFor(() => expect(t.fake.requests).toEqual([['https://*/*', 'http://*/*']]));
    await waitFor(() => expect(screen.queryByText(/needs access to api.example.com/)).toBeNull());
  });

  it('lists a page origin on the Permissions page like any other site', async () => {
    const t = uiSetup();
    const p = profile('Local API', {
      requestHeaders: [header('X-Debug', '1')],
      filters: [domain('127.0.0.1')],
    });
    t.fake.granted
      .add('https://127.0.0.1/*')
      .add('http://127.0.0.1/*')
      .add('https://*.127.0.0.1/*')
      .add('http://*.127.0.0.1/*')
      .add('http://localhost/*');
    await t.save(stateWith([p]));
    location.hash = '#/permissions';
    await t.mount(<AppShell />);
    const item = (await screen.findByText('localhost (http only)')).closest('li') as HTMLElement;
    expect(within(item).getByText(/No profile changes requests to this site/)).toBeTruthy();
    expect(within(item).getByRole('button', { name: 'Revoke' })).toBeTruthy();
    expect(screen.getByText('Changed by Local API')).toBeTruthy();
  });

  it('keeps the last checked request type enabled but refuses to uncheck it', async () => {
    const t = uiSetup();
    const p = profile('Api', {
      requestHeaders: [header('X-A', '1')],
      resourceTypes: ['xmlhttprequest'],
    });
    await t.save(stateWith([p]));
    location.hash = `#/profile/${p.id}/filters`;
    await t.mount(<AppShell />);
    const box = screen.getByRole('checkbox', { name: 'Fetch / XHR' }) as HTMLInputElement;
    expect(box.disabled).toBe(false);
    expect(box.closest('label')?.title).toBe('Keep at least one type, or choose All types.');
    fireEvent.click(box);
    await t.store.flush();
    expect(box.checked).toBe(true);
    expect((await t.call({ type: 'getState' })).state.profiles[0]?.resourceTypes).toEqual([
      'xmlhttprequest',
    ]);
  });

  it('adds a row with Enter and saves edits to the service worker', async () => {
    const t = uiSetup();
    const p = profile('Edit me', { requestHeaders: [header('X-A', '1')] });
    await t.save(stateWith([p]));
    location.hash = `#/profile/${p.id}`;
    await t.mount(<AppShell />);
    const name = screen.getByLabelText('Header name') as HTMLInputElement;
    fireEvent.keyDown(name, { key: 'Enter' });
    const names = screen.getAllByLabelText('Header name') as HTMLInputElement[];
    expect(names).toHaveLength(2);
    fireEvent.input(names[1] as HTMLInputElement, { target: { value: 'X-Debug' } });
    await t.store.flush();
    const [saved] = (await t.call({ type: 'getState' })).state.profiles;
    expect(saved?.requestHeaders.map((h) => h.name)).toEqual(['X-A', 'X-Debug']);
  });

  it('shows the Licence section in Settings and activates a pasted key', async () => {
    const t = uiSetup();
    location.hash = '#/settings';
    await t.mount(<AppShell />);
    expect(screen.getByRole('heading', { name: 'Licence' })).toBeTruthy();
    fireEvent.input(screen.getByLabelText('Licence key'), { target: { value: licenseKey() } });
    fireEvent.click(screen.getByRole('button', { name: 'Activate' }));
    expect(await screen.findByText(/Pro yearly is active until/)).toBeTruthy();
  });

  const page = (): HTMLElement => document.querySelector('.page') as HTMLElement;

  it('shows both plans on the Pro page to free users', async () => {
    const t = uiSetup();
    location.hash = '#/pro';
    await t.mount(<AppShell />);
    expect(screen.getByRole('region', { name: 'Plans' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Buy on headerbench.com' })).toHaveLength(2);
    expect(screen.getByRole('heading', { name: 'Already bought Pro?' })).toBeTruthy();
  });

  it('hides the plans from a yearly licence and offers only a switch to lifetime', async () => {
    const t = uiSetup();
    await t.call({ type: 'applyLicense', key: licenseKey() });
    location.hash = '#/pro';
    await t.mount(<AppShell />);
    expect(within(page()).getByText(/^Pro \(yearly\), active until/)).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Plans' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Buy on headerbench.com' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Switch to lifetime' }));
    expect(t.opened).toEqual(['https://headerbench.com/pro']);
    expect(screen.getByRole('heading', { name: 'Your licence key' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Refresh licence' })).toBeTruthy();
    expect(screen.getByLabelText('Replace licence key')).toBeTruthy();
  });

  it('shows no buy option at all to a lifetime licence', async () => {
    const t = uiSetup();
    await t.call({
      type: 'applyLicense',
      key: licenseKey({ lid: 'txn_02', plan: 'pro_lifetime', sub: null, exp: null }),
    });
    location.hash = '#/pro';
    await t.mount(<AppShell />);
    expect(within(page()).getByText('Pro (lifetime)')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Plans' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Buy on|Switch to lifetime/ })).toBeNull();
    expect(screen.getByLabelText('Replace licence key')).toBeTruthy();
  });

  it('shows the plans again once a licence has expired', async () => {
    const t = uiSetup();
    await t.call({ type: 'applyLicense', key: licenseKey() });
    t.clock.now = NOW + 301 * DAY;
    location.hash = '#/pro';
    await t.mount(<AppShell />);
    expect(within(page()).getByText('Your Pro licence has expired')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Buy on headerbench.com' })).toHaveLength(2);
  });

  it('shows the plans again once a licence was refunded', async () => {
    const t = uiSetup();
    await t.call({ type: 'applyLicense', key: licenseKey() });
    (t.env.config.revokedLicenses as string[]).push('sub_01');
    location.hash = '#/pro';
    await t.mount(<AppShell />);
    expect(within(page()).getByText('Free plan')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Buy on headerbench.com' })).toHaveLength(2);
  });

  it('opens the import dialog on #/import and shows the report before saving', async () => {
    const t = uiSetup();
    location.hash = '#/import';
    await t.mount(<AppShell />);
    fireEvent.click(screen.getByRole('button', { name: 'Paste JSON instead', hidden: true }));
    const json = JSON.stringify([
      {
        title: 'From ModHeader',
        headers: [{ enabled: true, name: 'X-A', value: '1' }],
        version: 2,
      },
    ]);
    fireEvent.input(screen.getByLabelText('Exported JSON'), { target: { value: json } });
    expect(await screen.findByText(/1 profile, 1 header imported/)).toBeTruthy();
    expect((await t.call({ type: 'getState' })).state.profiles).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Import 1 profile', hidden: true }));
    await waitFor(async () =>
      expect((await t.call({ type: 'getState' })).state.profiles).toHaveLength(1),
    );
  });
});

describe('welcome', () => {
  it('offers import and a blank profile as the two starting points', async () => {
    const t = uiSetup();
    await t.mount(<Welcome />);
    expect(screen.getByRole('button', { name: /Import from ModHeader/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Start with a blank profile/ })).toBeTruthy();
    expect(screen.getByText(/has no access to any site yet/)).toBeTruthy();
  });
});
