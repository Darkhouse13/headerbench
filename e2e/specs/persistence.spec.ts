/** Spec 9: rules and state survive `chrome.runtime.reload()` (what an extension update does). */
import { expect, header, tag, test } from '../support/fixtures.ts';
import { headers, profile } from '../support/profiles.ts';

test('rules keep working after the extension reloads', async ({ ext, echo, openHarness }) => {
  const p = profile('Survives reload', { requestHeaders: headers(['X-Persist', 'yes']) });
  await ext.apply(p);
  const page = await openHarness();
  const before = tag('persist-before');
  await page.evaluate((t) => window.hb.fetch(t), before);
  expect(header(await echo.waitFor(before), 'X-Persist')).toBe('yes');

  await ext.reload();

  const after = tag('persist-after');
  await page.evaluate((t) => window.hb.fetch(t), after);
  expect(header(await echo.waitFor(after), 'X-Persist')).toBe('yes');

  const snap = await ext.snapshot();
  expect(snap.state.profiles.map((x) => x.name)).toEqual(['Survives reload']);
  expect(snap.state.settings.activations.map((a) => a.profileId)).toEqual([p.id]);
  expect(snap.ruleError).toBeNull();
});

test('rules, including tab-only ones, survive a service worker restart', async ({
  ext,
  echo,
  openHarness,
}) => {
  const everywhere = profile('Everywhere', { requestHeaders: headers(['X-Persist', 'yes']) });
  const tabOnly = profile('One tab', { requestHeaders: headers(['X-Tab-Only', 'yes']) });
  await ext.setProfiles([everywhere, tabOnly]);
  await ext.activate(everywhere.id);
  const page = await openHarness();
  await ext.activate(tabOnly.id, { tabId: await ext.tabId(page) });

  await ext.restartServiceWorker();

  const snap = await ext.snapshot();
  expect(snap.state.settings.activations.map((a) => a.profileId)).toEqual([
    everywhere.id,
    tabOnly.id,
  ]);
  const id = tag('after-sw-restart');
  await page.evaluate((t) => window.hb.fetch(t), id);
  const received = await echo.waitFor(id);
  expect(header(received, 'X-Persist')).toBe('yes');
  expect(header(received, 'X-Tab-Only')).toBe('yes');
});
