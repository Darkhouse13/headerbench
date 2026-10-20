/** Spec 10: a ModHeader export imported through the UI produces working rules. */
import { fileURLToPath } from 'node:url';
import { expect, header, tag, test } from '../support/fixtures.ts';

const FIXTURE = fileURLToPath(new URL('../fixtures/modheader-local.json', import.meta.url));

test('imports a ModHeader file through the dialog and applies its headers', async ({
  ext,
  echo,
  openHarness,
}) => {
  const app = await ext.context.newPage();
  await app.goto(ext.url('app.html#/import'));
  const dialog = app.getByRole('dialog', { name: 'Import profiles' });
  await dialog.locator('input[type="file"]').setInputFiles(FIXTURE);

  await expect(dialog.getByText('ModHeader export', { exact: true })).toBeVisible();
  await expect(dialog.getByText('function', { exact: false }).first()).toBeVisible();
  await dialog.getByRole('button', { name: 'Import 2 profiles' }).click();
  await expect(dialog).toBeHidden();

  const sidebar = app.getByRole('complementary', { name: 'Profiles' });
  await expect(sidebar.getByRole('link', { name: /Local API/ })).toBeVisible();
  await expect(sidebar.getByRole('link', { name: /iPhone Safari/ })).toBeVisible();

  // Turning it on from the editor. The regex filter needs all-sites access, which the E2E build
  // does not have, so the editor asks for it; Chrome still applies the rules on localhost.
  await sidebar.getByRole('switch', { name: 'Turn on Local API' }).click();
  await expect(sidebar.getByRole('switch', { name: 'Turn off Local API' })).toBeVisible();

  const snap = await ext.snapshot();
  const imported = snap.state.profiles.find((p) => p.name === 'Local API');
  expect(imported?.requestHeaders.find((h) => h.name === 'X-Request-Time')?.enabled).toBe(false);

  const page = await openHarness();
  const id = tag('imported');
  const res = await page.evaluate((t) => window.hb.fetch(t), id);
  const received = await echo.waitFor(id);
  expect(header(received, 'X-Imported')).toBe('modheader');
  expect(header(received, 'Authorization')).toBe('Bearer eyJhbGciOiJIUzI1NiJ9.e2e.sig');
  expect(header(received, 'X-Request-Time')).toBeUndefined();
  expect(header(received, 'Accept-Language')).toBeUndefined();
  expect(res.headers['x-imported-response']).toBe('yes');
});
