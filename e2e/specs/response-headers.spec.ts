/** Spec 2: response headers are set, and the CSP preset removes Content-Security-Policy. */
import type { HeaderOp } from '@headerbench/core';
import { REMOVE_CSP_PRESET } from '@headerbench/core';
import { expect, tag, test } from '../support/fixtures.ts';
import { headers, profile } from '../support/profiles.ts';

const cspRemoval = REMOVE_CSP_PRESET.rows.map((r): [string, string, HeaderOp] => [
  r.name,
  r.value,
  r.op,
]);

test('sets a response header and removes CSP, as read by fetch', async ({ ext, openHarness }) => {
  const page = await openHarness();
  const before = await page.evaluate((t) => window.hb.fetch(t, '/csp'), tag('csp-before'));
  expect(before.headers['content-security-policy']).toBe("default-src 'none'");
  expect(before.headers['x-hb-resp']).toBeUndefined();

  await ext.apply(
    profile('Response headers', {
      responseHeaders: headers(['X-Hb-Resp', 'yes'], ['X-Server', 'rewritten'], ...cspRemoval),
    }),
  );
  const after = await page.evaluate((t) => window.hb.fetch(t, '/csp'), tag('csp-after'));
  expect(after.headers['x-hb-resp']).toBe('yes');
  expect(after.headers['x-server']).toBe('rewritten');
  expect(after.headers['content-security-policy']).toBeUndefined();
  expect(JSON.parse(after.text)).toEqual({ csp: true });
});

test('removing CSP lets a page run the inline script its CSP blocked', async ({ ext, echo }) => {
  const page = await ext.context.newPage();
  await page.goto(`${echo.origin}/csp-page`);
  await expect(page).toHaveTitle('csp-blocked');

  await ext.apply(profile('No CSP', { responseHeaders: headers(...cspRemoval) }));
  await page.reload();
  await expect(page).toHaveTitle('csp-removed');
});
