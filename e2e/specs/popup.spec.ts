/** Spec 11: the popup lists what Chrome applied on the current tab. */
import { expect, tag, test } from '../support/fixtures.ts';
import { filter, headers, profile } from '../support/profiles.ts';

test('the popup shows "Applied on this tab"', async ({ ext, echo, openHarness }) => {
  await ext.apply(
    profile('Local API', {
      requestHeaders: headers(['X-Debug', '1'], ['Accept-Language', '', 'remove']),
      responseHeaders: headers(['Access-Control-Allow-Origin', '*']),
      filters: [filter('domain', '127.0.0.1')],
    }),
    profile('Elsewhere', {
      requestHeaders: headers(['X-Other', '1']),
      filters: [filter('domain', 'api.staging.example.com')],
    }),
  );
  const page = await openHarness();
  const id = tag('popup');
  await page.evaluate((t) => window.hb.fetch(t), id);
  await echo.waitFor(id);

  const popup = await ext.context.newPage();
  await popup.setViewportSize({ width: 380, height: 560 });
  await popup.goto(ext.url(`popup.html?tab=${await ext.tabId(page)}`));

  const applied = popup.getByRole('region', { name: 'Applied on this tab' });
  await expect(applied).toContainText(`127.0.0.1:${echo.port}`);
  const items = applied.getByRole('listitem');
  await expect(items.filter({ hasText: 'X-Debug' })).toContainText('Local API');
  await expect(items.filter({ hasText: 'Accept-Language' })).toBeVisible();
  await expect(items.filter({ hasText: 'Access-Control-Allow-Origin' })).toBeVisible();
  await expect(applied).not.toContainText('Elsewhere');
});
