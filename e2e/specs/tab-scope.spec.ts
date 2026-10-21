/** Spec 5: a profile turned on for one tab (or several) changes those tabs' requests only. */
import type { Page } from '@playwright/test';
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

test('one profile scoped to two tabs; turning it off in one keeps the other', async ({
  ext,
  echo,
  openHarness,
}) => {
  const tabA = await openHarness();
  const tabB = await openHarness();
  const tabC = await openHarness();
  const idA = await ext.tabId(tabA);
  const idB = await ext.tabId(tabB);
  const p = profile('Two tabs', { requestHeaders: headers(['X-Tab', 'scoped']) });
  await ext.setProfiles([p]);
  await ext.activate(p.id, { tabId: idA });
  const snap = await ext.activate(p.id, { tabId: idB });
  const scopedTo = (s: typeof snap) =>
    s.state.settings.activations.map((a) => a.tabId).sort((x, y) => (x ?? 0) - (y ?? 0));
  expect(scopedTo(snap)).toEqual([idA, idB].sort((x, y) => x - y));

  const sent = async (page: Page, label: string): Promise<string | undefined> => {
    const id = tag(label);
    await page.evaluate((t) => window.hb.fetch(t), id);
    return header(await echo.waitFor(id), 'X-Tab');
  };
  expect(await sent(tabA, 'two-a')).toBe('scoped');
  expect(await sent(tabB, 'two-b')).toBe('scoped');
  expect(await sent(tabC, 'two-c')).toBeUndefined();

  const after = await ext.send({ type: 'deactivate', profileId: p.id, tabId: idA });
  expect(scopedTo(after)).toEqual([idB]);
  expect(await sent(tabA, 'off-a')).toBeUndefined();
  expect(await sent(tabB, 'still-b')).toBe('scoped');
  expect(await sent(tabC, 'off-c')).toBeUndefined();
});
