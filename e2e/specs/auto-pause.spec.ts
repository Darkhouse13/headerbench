/** Spec 12: a profile with an auto-pause time turns itself off when the alarm fires. */
import { expect, header, tag, test } from '../support/fixtures.ts';
import { headers, profile } from '../support/profiles.ts';

test('auto-pause turns the profile off on time', async ({ ext, echo, openHarness }) => {
  const p = profile('Short-lived', { requestHeaders: headers(['X-Timed', 'on']) });
  await ext.setProfiles([p]);
  const pauseAt = Date.now() + 4000;
  const snap = await ext.activate(p.id, { pauseAt });
  expect(snap.state.settings.activations[0]?.pauseAt).toBe(pauseAt);

  const page = await openHarness();
  const during = tag('timed-during');
  await page.evaluate((t) => window.hb.fetch(t), during);
  expect(header(await echo.waitFor(during), 'X-Timed')).toBe('on');

  // The alarm drops the expired activation and replaces the rules.
  await expect
    .poll(async () => (await ext.snapshot()).state.settings.activations.length, {
      timeout: 30_000,
      intervals: [500],
    })
    .toBe(0);
  expect(Date.now()).toBeGreaterThanOrEqual(pauseAt);

  const after = tag('timed-after');
  await page.evaluate((t) => window.hb.fetch(t), after);
  expect(header(await echo.waitFor(after), 'X-Timed')).toBeUndefined();
});
