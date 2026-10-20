/** Spec 3: a domain filter scopes the profile, and excludes carve URLs out of it. */
import { expect, header, tag, test } from '../support/fixtures.ts';
import { filter, headers, profile } from '../support/profiles.ts';

test('a domain filter applies only to that domain', async ({ ext, echo, openHarness }) => {
  await ext.apply(
    profile('Localhost only', {
      requestHeaders: headers(['X-Scoped', 'localhost']),
      filters: [filter('domain', 'localhost')],
    }),
  );
  const onLocalhost = await openHarness(echo.localhostOrigin);
  const inScope = tag('domain-in');
  await onLocalhost.evaluate((t) => window.hb.fetch(t), inScope);
  expect(header(await echo.waitFor(inScope), 'X-Scoped')).toBe('localhost');

  const onIp = await openHarness(echo.origin);
  const outOfScope = tag('domain-out');
  await onIp.evaluate((t) => window.hb.fetch(t), outOfScope);
  expect(header(await echo.waitFor(outOfScope), 'X-Scoped')).toBeUndefined();
});

test('a URL-pattern exclude skips matching URLs only', async ({ ext, echo, openHarness }) => {
  await ext.apply(
    profile('API minus health', {
      requestHeaders: headers(['X-Scoped', 'api']),
      filters: [filter('domain', '127.0.0.1'), filter('urlFilter', '/echo/health', true)],
    }),
  );
  const page = await openHarness();
  const api = tag('exclude-api');
  const health = tag('exclude-health');
  await page.evaluate((t) => window.hb.fetch(t, '/echo/api/users'), api);
  await page.evaluate((t) => window.hb.fetch(t, '/echo/health'), health);
  expect(header(await echo.waitFor(api), 'X-Scoped')).toBe('api');
  expect(header(await echo.waitFor(health), 'X-Scoped')).toBeUndefined();
});

test('a domain exclude skips that domain', async ({ ext, echo, openHarness }) => {
  await ext.apply(
    profile('Everywhere but localhost', {
      requestHeaders: headers(['X-Scoped', 'not-localhost']),
      filters: [filter('domain', 'localhost', true)],
    }),
  );
  const onIp = await openHarness(echo.origin);
  const kept = tag('dx-kept');
  await onIp.evaluate((t) => window.hb.fetch(t), kept);
  expect(header(await echo.waitFor(kept), 'X-Scoped')).toBe('not-localhost');

  const onLocalhost = await openHarness(echo.localhostOrigin);
  const skipped = tag('dx-skipped');
  await onLocalhost.evaluate((t) => window.hb.fetch(t), skipped);
  expect(header(await echo.waitFor(skipped), 'X-Scoped')).toBeUndefined();
});

test('a resource-type filter leaves other request types alone', async ({
  ext,
  echo,
  openHarness,
}) => {
  await ext.apply(
    profile('XHR only', {
      requestHeaders: headers(['X-Scoped', 'xhr']),
      resourceTypes: ['xmlhttprequest'],
    }),
  );
  const page = await openHarness();
  const xhr = tag('type-xhr');
  const image = tag('type-image');
  await page.evaluate((t) => window.hb.xhr(t), xhr);
  await page.evaluate((t) => window.hb.image(t), image);
  expect(header(await echo.waitFor(xhr), 'X-Scoped')).toBe('xhr');
  expect(header(await echo.waitFor(image), 'X-Scoped')).toBeUndefined();
});
