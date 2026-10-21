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

test('a regex with a (?i) flag group installs and matches any case', async ({
  ext,
  echo,
  openHarness,
}) => {
  const snap = await ext.apply(
    profile('Case-insensitive block', { blocks: [block('regex', '(?i)/echo/tracker/')] }),
  );
  expect(snap.warnings.map((w) => w.code)).not.toContain('INVALID_ITEM');
  expect(snap.warnings.filter((w) => w.severity === 'error')).toEqual([]);
  expect(snap.ruleError).toBeNull();

  const page = await openHarness();
  const outcome = (t: string, path: string): Promise<string> =>
    page.evaluate(
      ([id, p]) =>
        window.hb.fetch(id, p).then(
          () => 'loaded',
          (e: Error) => e.name,
        ),
      [t, path] as const,
    );
  const lower = tag('regex-lower');
  const upper = tag('regex-upper');
  const other = tag('regex-other');
  expect(await outcome(lower, '/echo/tracker/a')).toBe('TypeError');
  expect(await outcome(upper, '/ECHO/Tracker/b')).toBe('TypeError');
  expect(await outcome(other, '/echo/app')).toBe('loaded');
  expect(echo.tagged(lower)).toHaveLength(0);
  expect(echo.tagged(upper)).toHaveLength(0);

  // Chrome's regex rules ignore case by default, so the flag mostly matters for installing at all;
  // Test URL must agree with what Chrome just did.
  const tested = await ext.send({
    type: 'testUrl',
    url: `${echo.origin}/ECHO/Tracker/b`,
    resourceType: 'xmlhttprequest',
    method: 'get',
  });
  expect(tested.matches).toEqual([
    expect.objectContaining({ kind: 'block', applied: true, previewed: true }),
  ]);
});

test('an exact-URL redirect also applies to a page load with a #fragment', async ({
  ext,
  echo,
}) => {
  const id = tag('fragment');
  const to = `${echo.origin}/echo/moved?tag=${id}`;
  await ext.apply(
    profile('Docs moved', {
      redirects: [redirect('url', `${echo.origin}/docs/start?tag=${id}`, to)],
    }),
  );
  const page = await ext.context.newPage();
  await page.goto(`${echo.origin}/docs/start?tag=${id}#section`);
  expect([to, `${to}#section`]).toContain(page.url());
  expect(echo.tagged(id).map((r) => r.path)).toEqual(['/echo/moved']);
});
