/** Spec 4: with two profiles setting the same header, the higher one in the list wins. */
import { expect, header, tag, test } from '../support/fixtures.ts';
import { headers, profile } from '../support/profiles.ts';

test('priority order decides a conflict, and reordering flips it', async ({
  ext,
  echo,
  openHarness,
}) => {
  const staging = profile('Staging', { requestHeaders: headers(['X-Env', 'staging']) });
  const local = profile('Local', { requestHeaders: headers(['X-Env', 'local']) });
  const snap = await ext.apply(staging, local);
  expect(snap.state.settings.activations.map((a) => a.profileId)).toEqual([staging.id, local.id]);

  const page = await openHarness();
  const first = tag('priority-1');
  await page.evaluate((t) => window.hb.fetch(t), first);
  expect(header(await echo.waitFor(first), 'X-Env')).toBe('staging');

  const reordered = await ext.setProfiles([local, staging]);
  expect(reordered.state.settings.activations.map((a) => a.profileId)).toEqual([
    local.id,
    staging.id,
  ]);
  const second = tag('priority-2');
  await page.evaluate((t) => window.hb.fetch(t), second);
  expect(header(await echo.waitFor(second), 'X-Env')).toBe('local');
});
