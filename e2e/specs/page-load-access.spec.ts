/**
 * Chrome applies header rules to page loads (main_frame) without access to the page that starts
 * them, but needs that access for the page's own requests. This build is granted 127.0.0.1 only;
 * a page on localhost fetches from 127.0.0.1 and then navigates to it.
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

test('a page load started from a page without access is changed; its fetch is not', async ({
  echo,
}) => {
  const page = await ext.context.newPage();
  await page.goto(`${echo.localhostOrigin}/harness`);
  await page.waitForFunction(() => 'hb' in window);

  const fetched = tag('ungranted-fetch');
  await page.evaluate(([t, url]) => window.hb.fetch(t, url).catch(() => undefined), [
    fetched,
    `${echo.origin}/echo/api`,
  ] as const);
  expect(header(await echo.waitFor(fetched), 'X-Hb-Test')).toBeUndefined();

  const loaded = tag('ungranted-navigation');
  const target = `${echo.origin}/echo/page?tag=${loaded}`;
  await Promise.all([
    page.waitForURL(target),
    page.evaluate((url) => {
      location.href = url;
    }, target),
  ]);
  const navigation = await echo.waitFor(loaded);
  // A top-level navigation that the localhost page started.
  expect(header(navigation, 'sec-fetch-dest')).toBe('document');
  expect(header(navigation, 'sec-fetch-site')).toBe('cross-site');
  expect(header(navigation, 'X-Hb-Test')).toBe('on');
});

test('Test URL reports page access for page loads, not for fetches', async ({ echo }) => {
  const ask = (resourceType: 'main_frame' | 'xmlhttprequest') =>
    ext.send({
      type: 'testUrl',
      url: `${echo.origin}/echo/page`,
      resourceType,
      method: 'get',
      initiator: `${echo.localhostOrigin}/harness`,
    });

  const load = await ask('main_frame');
  expect(load).toMatchObject({ hasHostAccess: true, hasPageAccess: true });
  expect(load.matches.length).toBeGreaterThan(0);

  const fetched = await ask('xmlhttprequest');
  expect(fetched).toMatchObject({ hasHostAccess: true, hasPageAccess: false });
});
