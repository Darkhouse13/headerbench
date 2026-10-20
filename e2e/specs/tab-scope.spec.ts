/** Spec 5: a profile turned on for one tab changes that tab's requests only. */
import { expect, header, tag, test } from '../support/fixtures.ts';
import { headers, profile } from '../support/profiles.ts';

test('a tab-scoped profile applies in tab A, not in tab B', async ({ ext, echo, openHarness }) => {
  const tabA = await openHarness();
  const tabB = await openHarness();
  const p = profile('This tab only', { requestHeaders: headers(['X-Tab', 'A']) });
  await ext.setProfiles([p]);
  const snap = await ext.activate(p.id, { tabId: await ext.tabId(tabA) });
  expect(snap.state.settings.activations[0]?.tabId).toBe(await ext.tabId(tabA));

  const inA = tag('tab-a');
  const inB = tag('tab-b');
  await tabA.evaluate((t) => window.hb.fetch(t), inA);
  await tabB.evaluate((t) => window.hb.fetch(t), inB);
  expect(header(await echo.waitFor(inA), 'X-Tab')).toBe('A');
  expect(header(await echo.waitFor(inB), 'X-Tab')).toBeUndefined();
});
