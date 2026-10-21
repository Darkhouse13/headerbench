import type { MockRule } from '@headerbench/core';
import { MOCK_CSP_NOTE, NON_ASCII_REGEX_MESSAGE, REGEX_PREVIEW_NOTE } from '@headerbench/core';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/preact';
import { describe, expect, it, vi } from 'vitest';
import type { Reply, Request, RequestType } from '../src/messages';
import { AppShell } from '../src/ui/editor/AppShell';
import { navigate } from '../src/ui/editor/router';
import { Popup } from '../src/ui/popup/Popup';
import { DAY, NOW, domain, header, licenseKey, profile, stateWith } from './helpers';
import { uiSetup } from './ui-harness';

type Setup = ReturnType<typeof uiSetup>;

/** Holds replies to requests of `type` until released, to control the order answers arrive in. */
function holdReplies(t: Setup, type: RequestType) {
  const real = t.platform.send.bind(t.platform);
  const held: { req: Request; release: () => void }[] = [];
  t.platform.send = ((req: Request) => {
    if (req.type !== type) return real(req as never);
    return new Promise<Reply<RequestType>>((resolve) => {
      held.push({ req, release: () => void real(req as never).then(resolve) });
    });
  }) as typeof t.platform.send;
  return held;
}

const mock = (pattern: string): MockRule => ({
  id: crypto.randomUUID(),
  enabled: true,
  kind: 'urlFilter',
  pattern,
  contentType: 'application/json',
  body: '{"ok":true}',
  comment: '',
});

const modheader = (titles: string[]): string =>
  JSON.stringify(
    titles.map((title) => ({
      title,
      headers: [{ enabled: true, name: 'X-A', value: '1' }],
      version: 2,
    })),
  );

describe('import dialog', () => {
  const chooseFile = (file: File): HTMLInputElement => {
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });
    return input;
  };

  it('says so when a chosen file cannot be read', async () => {
    const t = uiSetup();
    location.hash = '#/import';
    await t.mount(<AppShell />);
    const file = new File(['{}'], 'profiles.json', { type: 'application/json' });
    file.text = () => Promise.reject(new DOMException('Gone', 'NotReadableError'));
    chooseFile(file);
    expect(
      await screen.findByText(
        'profiles.json could not be read. Choose it again, or paste its contents instead.',
      ),
    ).toBeTruthy();
  });

  it('clears the file input after reading, so choosing the same file again works', async () => {
    const t = uiSetup();
    location.hash = '#/import';
    await t.mount(<AppShell />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    // jsdom keeps no real selection; model the browser's, which stays until the value is cleared.
    let selected = 'C:\\fakepath\\export.json';
    Object.defineProperty(input, 'value', {
      configurable: true,
      get: () => selected,
      set: (value: string) => void (selected = value),
    });
    chooseFile(new File([modheader(['Again'])], 'export.json', { type: 'application/json' }));
    expect(
      await screen.findByRole('button', { name: 'Import 1 profile', hidden: true }),
    ).toBeTruthy();
    expect(input.value).toBe('');
  });

  const openPaste = async (t: Setup) => {
    location.hash = '#/import';
    await t.mount(<AppShell />);
    fireEvent.click(screen.getByRole('button', { name: 'Paste JSON instead', hidden: true }));
    return screen.getByLabelText('Exported JSON');
  };

  it('ignores the answer to text that was replaced, and imports exactly what was previewed', async () => {
    const t = uiSetup();
    const box = await openPaste(t);
    const held = holdReplies(t, 'importText');
    fireEvent.input(box, { target: { value: modheader(['Old']) } });
    await waitFor(() => expect(held).toHaveLength(1));
    fireEvent.input(box, { target: { value: modheader(['New A', 'New B']) } });
    await waitFor(() => expect(held).toHaveLength(2));
    held[1]?.release();
    const button = await screen.findByRole('button', { name: 'Import 2 profiles', hidden: true });
    held[0]?.release();
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(screen.getByRole('button', { name: 'Import 2 profiles', hidden: true })).toBe(button);
    expect(screen.queryByText(/^1 profile/)).toBeNull();

    // An edit makes the preview stale: nothing can be imported until it is analysed again.
    fireEvent.input(box, { target: { value: `${modheader(['New A', 'New B'])} ` } });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect(held).toHaveLength(3));
    held[2]?.release();
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
    await waitFor(() => expect(held).toHaveLength(4));
    expect(held[3]?.req).toMatchObject({ type: 'importText', apply: true });
    expect((held[3]?.req as { text: string }).text).toBe(`${modheader(['New A', 'New B'])} `);
    held[3]?.release();
    await waitFor(async () =>
      expect((await t.call({ type: 'getState' })).state.profiles.map((p) => p.name)).toEqual([
        'New A',
        'New B',
      ]),
    );
  });

  it('waits for typing to pause before analysing pasted text', async () => {
    const t = uiSetup();
    const box = await openPaste(t);
    const sent: string[] = [];
    const real = t.platform.send.bind(t.platform);
    t.platform.send = ((req: Request) => {
      if (req.type === 'importText') sent.push(req.text);
      return real(req as never);
    }) as typeof t.platform.send;
    fireEvent.input(box, { target: { value: '[' } });
    fireEvent.input(box, { target: { value: '[{' } });
    fireEvent.input(box, { target: { value: modheader(['Typed']) } });
    expect(await screen.findByText(/1 profile, 1 header imported/)).toBeTruthy();
    expect(sent).toEqual([modheader(['Typed'])]);
  });

  it('refuses pasted text over 5 MB without sending it', async () => {
    const t = uiSetup();
    const box = await openPaste(t);
    const sent = vi.fn();
    const real = t.platform.send.bind(t.platform);
    t.platform.send = ((req: Request) => {
      if (req.type === 'importText') sent();
      return real(req as never);
    }) as typeof t.platform.send;
    fireEvent.input(box, { target: { value: `["${'é'.repeat(2_700_000)}"]` } });
    expect(
      await screen.findByText(
        'The pasted text is larger than 5 MB, which is too big for a profile export.',
      ),
    ).toBeTruthy();
    await act(() => new Promise((r) => setTimeout(r, 300)));
    expect(sent).not.toHaveBeenCalled();
  });
});

describe('test a URL', () => {
  it('tests again when the address changes and shows the request that was tested', async () => {
    const t = uiSetup();
    location.hash = `#/test?url=${encodeURIComponent('https://a.example.com/one')}`;
    await t.mount(<AppShell />);
    expect(
      await screen.findByText(/GET https:\/\/a\.example\.com\/one · Page \(document\)/),
    ).toBeTruthy();
    act(() => navigate(`#/test?url=${encodeURIComponent('https://b.example.com/two')}`));
    expect(await screen.findByText(/GET https:\/\/b\.example\.com\/two/)).toBeTruthy();
    expect((screen.getByLabelText('URL') as HTMLInputElement).value).toBe(
      'https://b.example.com/two',
    );
    expect(screen.getByLabelText('URL').getAttribute('type')).toBe('text');
    expect(screen.getByLabelText('URL').getAttribute('inputmode')).toBe('url');

    fireEvent.change(screen.getByLabelText('Method'), { target: { value: 'post' } });
    fireEvent.change(screen.getByLabelText('Request type'), {
      target: { value: 'xmlhttprequest' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    expect(
      await screen.findByText(/POST https:\/\/b\.example\.com\/two · Fetch \/ XHR/),
    ).toBeTruthy();
  });

  it('shows only the latest test when answers arrive out of order', async () => {
    const t = uiSetup();
    location.hash = '#/test';
    await t.mount(<AppShell />);
    const held = holdReplies(t, 'testUrl');
    const input = screen.getByLabelText('URL');
    fireEvent.input(input, { target: { value: 'https://first.example.com/' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    await waitFor(() => expect(held).toHaveLength(1));
    fireEvent.input(input, { target: { value: 'https://second.example.com/' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    await waitFor(() => expect(held).toHaveLength(2));
    held[1]?.release();
    expect(await screen.findByText(/second\.example\.com/, { selector: 'p' })).toBeTruthy();
    held[0]?.release();
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(screen.queryByText(/first\.example\.com/, { selector: 'p' })).toBeNull();
  });

  it('re-runs the tested request, not later form edits, after granting access', async () => {
    const t = uiSetup();
    const p = profile('Api', {
      requestHeaders: [header('X-A', '1')],
      filters: [domain('api.example.com')],
    });
    await t.save(
      stateWith([p], { activations: [{ profileId: p.id, tabId: null, pauseAt: null }] }),
    );
    location.hash = '#/test';
    await t.mount(<AppShell />);
    const sent: Request[] = [];
    const real = t.platform.send.bind(t.platform);
    t.platform.send = ((req: Request) => {
      if (req.type === 'testUrl') sent.push(req);
      return real(req as never);
    }) as typeof t.platform.send;
    const url = screen.getByLabelText('URL');
    fireEvent.input(url, { target: { value: 'https://api.example.com/users' } });
    fireEvent.change(screen.getByLabelText('Request type'), {
      target: { value: 'xmlhttprequest' },
    });
    fireEvent.change(screen.getByLabelText('Method'), { target: { value: 'post' } });
    fireEvent.input(screen.getByLabelText(/Sent from page/), {
      target: { value: 'https://app.example.com/' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    const grant = await screen.findByRole('button', { name: 'Grant access' });
    fireEvent.input(url, { target: { value: 'https://other.example.com/' } });
    fireEvent.change(screen.getByLabelText('Method'), { target: { value: 'get' } });
    fireEvent.click(grant);
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]).toEqual(sent[0]);
    expect(sent[1]).toMatchObject({
      url: 'https://api.example.com/users',
      method: 'post',
      resourceType: 'xmlhttprequest',
      initiator: 'https://app.example.com/',
    });
  });

  it('shows an error banner when the test cannot run', async () => {
    const t = uiSetup();
    location.hash = '#/test';
    await t.mount(<AppShell />);
    t.platform.send = (async () => ({
      ok: false,
      code: 'internal',
      error: 'Headerbench could not read your rules.',
    })) as typeof t.platform.send;
    fireEvent.input(screen.getByLabelText('URL'), { target: { value: 'https://x.example.com/' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    const banner = await screen.findByRole('alert');
    expect(within(banner).getByText('The test did not run')).toBeTruthy();
    expect(within(banner).getByText('Headerbench could not read your rules.')).toBeTruthy();
  });

  it('marks a regex rule it cannot preview apart from rules that do not apply', async () => {
    const t = uiSetup();
    const p = profile('Api', {
      requestHeaders: [header('X-A', '1')],
      filters: [
        {
          id: 'f',
          enabled: true,
          kind: 'regex',
          value: '^https://api\\.example\\.com/(?i)users',
          exclude: false,
        },
      ],
    });
    await t.save(
      stateWith([p], { activations: [{ profileId: p.id, tabId: null, pauseAt: null }] }),
    );
    location.hash = `#/test?url=${encodeURIComponent('https://api.example.com/USERS')}`;
    await t.mount(<AppShell />);
    expect(await screen.findByText(REGEX_PREVIEW_NOTE)).toBeTruthy();
    expect(screen.getByLabelText("Can't preview")).toBeTruthy();
    expect(screen.queryByLabelText('Does not apply')).toBeNull();
    expect(
      screen.getByRole('heading', {
        name: /0 rules would apply to api\.example\.com, 1 can't be previewed/,
      }),
    ).toBeTruthy();
  });

  it('shows the CSP note on mock matches', async () => {
    const t = uiSetup();
    const p = profile('Mocks', { mocks: [mock('||api.example.com/user')] });
    await t.save(
      stateWith([p], { activations: [{ profileId: p.id, tabId: null, pauseAt: null }] }),
    );
    location.hash = `#/test?url=${encodeURIComponent('https://api.example.com/user')}`;
    await t.mount(<AppShell />);
    fireEvent.change(screen.getByLabelText('Request type'), {
      target: { value: 'xmlhttprequest' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    expect(await screen.findByText(MOCK_CSP_NOTE)).toBeTruthy();
  });
});

describe('Pro and licence', () => {
  it('offers the trial only to someone who never had Pro', async () => {
    const fresh = uiSetup();
    location.hash = '#/pro';
    const view = await fresh.mount(<AppShell />);
    expect(screen.getByRole('button', { name: 'Start 14-day free trial' })).toBeTruthy();
    view.unmount();

    const lapsed = uiSetup();
    await lapsed.call({ type: 'applyLicense', key: licenseKey() });
    lapsed.clock.now = NOW + 301 * DAY;
    await lapsed.mount(<AppShell />);
    expect(screen.getByText('Your Pro licence has expired')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Start 14-day free trial' })).toBeNull();
  });

  it('shows the last automatic refresh failure in Settings as soon as it is stored', async () => {
    const t = uiSetup();
    await t.call({ type: 'applyLicense', key: licenseKey() });
    location.hash = '#/settings';
    await t.mount(<AppShell />);
    expect(screen.getByText(/sends only the key to\s+headerbench\.com/)).toBeTruthy();
    expect(screen.queryByText('The automatic licence refresh failed')).toBeNull();
    await t.api.storage.local.set({
      licenseRefreshError: {
        at: NOW,
        code: 'network',
        message: 'Headerbench could not reach headerbench.com.',
      },
    });
    expect(await screen.findByText('The automatic licence refresh failed')).toBeTruthy();
    expect(screen.getByText(/Headerbench could not reach headerbench\.com\./)).toBeTruthy();
  });

  it('shows only the stored refresh failure and how long ago it was', async () => {
    const t = uiSetup();
    await t.call({ type: 'applyLicense', key: licenseKey() });
    const message =
      'Your subscription is no longer active, so the licence was not renewed. Pro rules pause when the current key expires; nothing is deleted.';
    await t.api.storage.local.set({
      licenseRefreshError: { at: NOW - 3 * 3600_000, code: 'subscription_inactive', message },
    });
    location.hash = '#/settings';
    await t.mount(<AppShell />);
    const banner = (await screen.findByText('The automatic licence refresh failed')).closest(
      '.banner',
    ) as HTMLElement;
    expect(banner.textContent).toContain(`${message} Last try 3 hours ago.`);
    expect(banner.textContent).not.toMatch(/try again|keeps working/);
  });

  it('warns in the popup a week before a yearly licence ends', async () => {
    const t = uiSetup();
    await t.call({
      type: 'applyLicense',
      key: licenseKey({ exp: Math.floor((NOW + 5 * DAY) / 1000) }),
    });
    await t.mount(<Popup />);
    expect(
      screen.getByText(
        /^Pro ends on .+\. It renews automatically while your subscription is active; open Pro to check\.$/,
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open Pro' }));
    await waitFor(() => expect(t.opened).toEqual(['app.html#/pro']));
  });

  it('says nothing about a licence that has weeks left', async () => {
    const t = uiSetup();
    await t.call({ type: 'applyLicense', key: licenseKey() });
    await t.mount(<Popup />);
    expect(screen.queryByText(/Pro ends on/)).toBeNull();
  });

  it('tells a lapsed customer with Pro rules that they are paused', async () => {
    const t = uiSetup();
    await t.call({ type: 'applyLicense', key: licenseKey() });
    await t.save(stateWith([profile('Mocks', { mocks: [mock('||api.example.com/user')] })]));
    t.clock.now = NOW + 301 * DAY;
    await t.mount(<Popup />);
    expect(
      screen.getByText(
        'Your Pro licence has ended, so Pro rules are paused. Open Pro to refresh the licence or renew.',
      ),
    ).toBeTruthy();
  });

  it('says nothing to a lapsed customer without Pro rules', async () => {
    const t = uiSetup();
    await t.call({ type: 'applyLicense', key: licenseKey() });
    await t.save(stateWith([profile('Plain', { requestHeaders: [header('X-A', '1')] })]));
    t.clock.now = NOW + 301 * DAY;
    await t.mount(<Popup />);
    expect(screen.queryByText(/Pro rules are paused/)).toBeNull();
  });
});

describe('popup tabs and access', () => {
  it('turns a profile off only in this tab, and offers all tabs when it is on in several', async () => {
    const t = uiSetup({ tab: { id: 5, url: 'https://api.example.com/app' } });
    const p = profile('Staging', { requestHeaders: [header('X-A', '1')] });
    await t.save(
      stateWith([p], {
        activations: [
          { profileId: p.id, tabId: 5, pauseAt: null },
          { profileId: p.id, tabId: 7, pauseAt: null },
        ],
      }),
    );
    await t.mount(<Popup />);
    expect(await screen.findByText(/^This tab and 1 other/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Options for Staging' }));
    expect(screen.getByRole('menuitem', { name: 'Turn off in all 2 tabs' })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });

    const toggle = screen.getByRole('switch', { name: 'Staging' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle);
    await waitFor(async () =>
      expect((await t.call({ type: 'getState' })).state.settings.activations).toEqual([
        { profileId: p.id, tabId: 7, pauseAt: null },
      ]),
    );
    expect(await screen.findByText(/^On in 1 other tab/)).toBeTruthy();
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });

  it('adds this tab to a profile that is on in another tab', async () => {
    const t = uiSetup({ tab: { id: 5, url: 'https://api.example.com/app' } });
    const p = profile('Staging', { requestHeaders: [header('X-A', '1')] });
    await t.save(stateWith([p], { activations: [{ profileId: p.id, tabId: 7, pauseAt: null }] }));
    await t.mount(<Popup />);
    fireEvent.click(screen.getByRole('button', { name: 'Options for Staging' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'This tab too' }));
    await waitFor(async () =>
      expect(
        (await t.call({ type: 'getState' })).state.settings.activations.map((a) => a.tabId).sort(),
      ).toEqual([5, 7]),
    );
  });

  it('shows the current auto-pause time as text, not as a menu choice', async () => {
    const t = uiSetup({ tab: { id: 5, url: 'https://api.example.com/app' } });
    const p = profile('Staging', { requestHeaders: [header('X-A', '1')] });
    await t.save(
      stateWith([p], { activations: [{ profileId: p.id, tabId: null, pauseAt: NOW + 3600_000 }] }),
    );
    await t.mount(<Popup />);
    fireEvent.click(screen.getByRole('button', { name: 'Options for Staging' }));
    const checked = screen
      .getAllByRole('menuitemradio')
      .filter((el) => el.getAttribute('aria-checked') === 'true')
      .map((el) => el.textContent);
    expect(checked).toEqual(['All tabs']);
    expect(screen.queryByRole('menuitemradio', { name: /Pauses at/ })).toBeNull();
    expect(screen.getByText(/^Auto-pause · pauses at /)).toBeTruthy();
    expect(screen.getByText(/Pauses at .* · All sites/)).toBeTruthy();
  });

  it('does not ask for the page when a profile only changes page loads', async () => {
    const t = uiSetup({ tab: { id: 5, url: 'http://localhost:5173/app' } });
    const p = profile('Docs only', {
      requestHeaders: [header('X-Debug', '1')],
      filters: [domain('127.0.0.1')],
      resourceTypes: ['main_frame', 'sub_frame'],
    });
    await t.save(
      stateWith([p], { activations: [{ profileId: p.id, tabId: null, pauseAt: null }] }),
    );
    await t.mount(<Popup />);
    expect(
      await screen.findByText(
        'Headerbench needs access to 127.0.0.1 to change its headers. It reads nothing.',
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Grant access' }));
    await waitFor(() =>
      expect(t.fake.requests).toEqual([['http://127.0.0.1/*', 'https://127.0.0.1/*']]),
    );
    await screen.findByRole('region', { name: 'Applied on this tab' });
    expect(screen.queryByText(/Grant access to localhost/)).toBeNull();
  });
});

describe('editor', () => {
  it('restores a deleted profile and its activation with Undo', async () => {
    const t = uiSetup();
    const keep = profile('Keep');
    const gone = profile('Gone', { requestHeaders: [header('X-A', '1')] });
    await t.save(
      stateWith([gone, keep], {
        activations: [{ profileId: gone.id, tabId: null, pauseAt: null }],
      }),
    );
    location.hash = `#/profile/${gone.id}`;
    await t.mount(<AppShell />);
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete profile' }));
    const dialog = await screen.findByRole('dialog', { hidden: true });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete', hidden: true }));
    await t.store.flush();
    expect((await t.call({ type: 'getState' })).state.profiles.map((p) => p.name)).toEqual([
      'Keep',
    ]);
    expect(screen.getByText('Deleted Gone.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await t.store.flush();
    const { state } = await t.call({ type: 'getState' });
    expect(state.profiles.map((p) => p.name)).toEqual(['Gone', 'Keep']);
    expect(state.settings.activations).toEqual([
      { profileId: gone.id, tabId: null, pauseAt: null },
    ]);
    expect(screen.getByRole('heading', { name: 'Gone' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('labels row switches with the row, and says on or off only through aria-checked', async () => {
    const t = uiSetup();
    const p = profile('Api', { requestHeaders: [header('X-Api-Key', 'k'), header('', '')] });
    await t.save(stateWith([p]));
    location.hash = `#/profile/${p.id}`;
    await t.mount(<AppShell />);
    const row = screen.getByRole('switch', { name: 'X-Api-Key' });
    expect(row.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(row);
    expect(screen.getByRole('switch', { name: 'X-Api-Key' }).getAttribute('aria-checked')).toBe(
      'false',
    );
    expect(screen.getByRole('switch', { name: 'Unnamed header' })).toBeTruthy();
    expect(screen.getAllByRole('switch', { name: 'Api' })).toHaveLength(2);
  });

  it('moves between profile sections with arrow keys, Home and End', async () => {
    const t = uiSetup();
    const p = profile('Api');
    await t.save(stateWith([p]));
    location.hash = `#/profile/${p.id}`;
    await t.mount(<AppShell />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1, -1, -1, -1]);
    fireEvent.keyDown(tabs[0] as HTMLElement, { key: 'ArrowRight' });
    expect(location.hash).toBe(`#/profile/${p.id}/response`);
    await waitFor(() => expect(document.activeElement?.id).toBe('tab-response'));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'End' });
    expect(location.hash).toBe(`#/profile/${p.id}/settings`);
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowRight' });
    expect(location.hash).toBe(`#/profile/${p.id}`);
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowLeft' });
    expect(location.hash).toBe(`#/profile/${p.id}/settings`);
    expect(screen.getByRole('radio', { name: 'Blue' })).toBeTruthy();
  });

  it('accepts RE2 flags, and shows the core’s reason for non-ASCII without asking Chrome', async () => {
    const t = uiSetup();
    const asked: string[] = [];
    t.platform.regexProblem = async (regex) => {
      asked.push(regex);
      return null;
    };
    const p = profile('Api', {
      requestHeaders: [header('X-A', '1')],
      filters: [
        { id: 'ok', enabled: true, kind: 'regex', value: '(?i)abc', exclude: false },
        { id: 'bad', enabled: true, kind: 'regex', value: 'café', exclude: false },
      ],
    });
    await t.save(stateWith([p]));
    location.hash = `#/profile/${p.id}/filters`;
    await t.mount(<AppShell />);
    expect(screen.getByText(NON_ASCII_REGEX_MESSAGE)).toBeTruthy();
    await waitFor(() => expect(asked).toEqual(['(?i)abc']), { timeout: 2000 });
    expect(screen.getAllByText(/regex|Regex/).filter((el) => el.closest('.issue'))).toHaveLength(0);
  });

  it('shows a bad $N in a regex redirect under the target field, once', async () => {
    const t = uiSetup();
    const p = profile('Local bundle', {
      redirects: [
        {
          id: 'r',
          enabled: true,
          kind: 'regex',
          from: '^https://cdn\\.example\\.com/(.*)$',
          to: 'http://localhost:3000/$2',
          comment: '',
        },
      ],
    });
    await t.save(stateWith([p]));
    location.hash = `#/profile/${p.id}/redirects`;
    await t.mount(<AppShell />);
    const messages = screen.getAllByText(/capture group/);
    expect(messages).toHaveLength(1);
    const field = screen.getByLabelText('Redirect to');
    expect(field.parentElement?.contains(messages[0] as HTMLElement)).toBe(true);
  });
});
