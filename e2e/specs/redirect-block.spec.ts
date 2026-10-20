/** Spec 6: a URL redirect sends the request elsewhere, and a block stops it reaching the server. */
import { expect, tag, test } from '../support/fixtures.ts';
import { block, profile, redirect } from '../support/profiles.ts';

test('redirects one URL to another', async ({ ext, echo, openHarness }) => {
  const id = tag('redirect');
  await ext.apply(
    profile('Redirects', {
      redirects: [
        redirect(
          'url',
          `${echo.origin}/old/config.json?tag=${id}`,
          `${echo.origin}/echo/new?tag=${id}`,
        ),
      ],
    }),
  );
  const page = await openHarness();
  const res = await page.evaluate(
    ([origin, t]) =>
      fetch(`${origin}/old/config.json?tag=${t}`).then(async (r) => ({
        url: r.url,
        body: await r.json(),
      })),
    [echo.origin, id] as const,
  );
  expect(res.body.path).toBe('/echo/new');
  expect(res.url).toBe(`${echo.origin}/echo/new?tag=${id}`);
  expect(echo.tagged(id).map((r) => r.path)).toEqual(['/echo/new']);
});

test('redirects by URL pattern', async ({ ext, echo, openHarness }) => {
  await ext.apply(
    profile('Pattern redirect', {
      redirects: [redirect('urlFilter', '/legacy/api^', `${echo.origin}/echo/modern`)],
    }),
  );
  const page = await openHarness();
  const res = await page.evaluate(() => fetch('/legacy/api?x=1').then((r) => r.json()));
  expect(res.path).toBe('/echo/modern');
});

test('blocks matching requests before they reach the server', async ({
  ext,
  echo,
  openHarness,
}) => {
  await ext.apply(profile('Blocks', { blocks: [block('urlFilter', '/echo/tracker')] }));
  const page = await openHarness();
  const blocked = tag('blocked');
  const allowed = tag('allowed');
  const outcome = await page.evaluate(
    (t) =>
      window.hb.fetch(t, '/echo/tracker').then(
        () => 'loaded',
        (e: Error) => e.name,
      ),
    blocked,
  );
  expect(outcome).toBe('TypeError');
  await page.evaluate((t) => window.hb.fetch(t, '/echo/app'), allowed);
  await echo.waitFor(allowed);
  expect(echo.tagged(blocked)).toHaveLength(0);
});
