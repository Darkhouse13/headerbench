/** Request-header append, typed in mixed case: Chrome only accepts lowercase append names. */
import { expect, header, tag, test } from '../support/fixtures.ts';
import { headers, profile } from '../support/profiles.ts';

test('appends to a request header typed in mixed case', async ({ ext, echo, openHarness }) => {
  await ext.apply(
    profile('Append', {
      requestHeaders: headers(['Accept-Language', 'fr-CH', 'append'], ['X-Hb-Same-Rule', 'yes']),
    }),
  );
  const page = await openHarness();
  const id = tag('append');
  await page.evaluate((t) => window.hb.fetch(t), id);
  const received = await echo.waitFor(id);
  // A rejected append would drop the whole rule, including the set in the same row list.
  expect(header(received, 'Accept-Language')).toMatch(/.+fr-CH$/);
  expect(header(received, 'X-Hb-Same-Rule')).toBe('yes');
  const snap = await ext.snapshot();
  expect(snap.warnings.filter((w) => w.severity === 'error')).toEqual([]);
});
