/**
 * Chrome applies header rules only with host access to the request URL and to the page that sends
 * it. This build is granted 127.0.0.1 only, so a localhost page fetching 127.0.0.1 is left alone,
 * and the popup on that page asks for access to it.
 */
import type { ExtensionHarness } from '../support/extension.ts';
import { extensionVariant, launchExtension } from '../support/extension.ts';
import { expect, header, tag, test } from '../support/fixtures.ts';
import { filter, headers, profile } from '../support/profiles.ts';

let variant: ReturnType<typeof extensionVariant>;
let ext: ExtensionHarness;

test.beforeEach(async () => {
  variant = extensionVariant((manifest) => ({
    ...manifest,
    host_permissions: ['http://127.0.0.1/*'],
    // Lets the harness and the popup (opened as a page) read the localhost tab's URL, which a
    // toolbar click would share through activeTab.
    permissions: [...(manifest.permissions as string[]), 'tabs'],
  }));
  ext = await launchExtension({ extensionDir: variant.dir });
  await ext.apply(
    profile('Local API', {
      requestHeaders: headers(['X-Hb-Test', 'on']),
      filters: [filter('domain', '127.0.0.1')],
    }),
  );
});

test.afterEach(async () => {
  await ext.close();
  variant.dispose();
});

async function open(url: string) {
  const page = await ext.context.newPage();
  await page.goto(url);
  await page.waitForFunction(() => 'hb' in window);
  return page;
}

test('changes requests only from pages Headerbench can access', async ({ echo }) => {
  // Control: the page on 127.0.0.1 is granted, so its request is changed.
  const granted = await open(`${echo.origin}/harness`);
  const ok = tag('granted-page');
  await granted.evaluate((t) => window.hb.fetch(t), ok);
  expect(header(await echo.waitFor(ok), 'X-Hb-Test')).toBe('on');

  // The same request sent from localhost: Chrome needs that page too, so nothing changes.
  const local = await open(`${echo.localhostOrigin}/harness`);
  const id = tag('ungranted-page');
  await local.evaluate(([t, url]) => window.hb.fetch(t, url).catch(() => undefined), [
    id,
    `${echo.origin}/echo/cross`,
  ] as const);
  expect(header(await echo.waitFor(id), 'X-Hb-Test')).toBeUndefined();

  const popup = await ext.context.newPage();
  await popup.setViewportSize({ width: 380, height: 560 });
  await popup.goto(ext.url(`popup.html?tab=${await ext.tabId(local)}`));
  const applied = popup.getByRole('region', { name: 'Applied on this tab' });
  await expect(applied).toContainText(
    'Chrome only lets Headerbench change requests sent from pages it can access. Grant access to localhost?',
  );
  await expect(applied.getByRole('button', { name: 'Grant' })).toBeVisible();
});
