/** Spec 1: request headers are set and removed on every request type, as seen by the server. */
import { expect, header, tag, test } from '../support/fixtures.ts';
import { headers, profile } from '../support/profiles.ts';

const SET = {
  'X-Hb-Test': 'on',
  Authorization: 'Bearer e2e-token',
  'User-Agent': 'HeaderbenchE2E/1.0',
  Referer: 'https://referrer.example.com/',
  Cookie: 'session=e2e',
  'X-Forwarded-For': '203.0.113.7',
} as const;

test.beforeEach(async ({ ext }) => {
  await ext.apply(
    profile('Request headers', {
      requestHeaders: [
        ...headers(...Object.entries(SET)),
        ...headers(['Accept-Language', '', 'remove']),
      ],
    }),
  );
});

const KINDS = ['fetch', 'xhr', 'post', 'put', 'iframe', 'image'] as const;

for (const kind of KINDS) {
  test(`sets and removes request headers on ${kind}`, async ({ echo, openHarness }) => {
    const page = await openHarness();
    const id = tag(kind);
    await page.evaluate(([k, t]) => window.hb[k](t).then(() => undefined), [kind, id] as const);
    const received = await echo.waitFor(id);

    for (const [name, value] of Object.entries(SET)) {
      expect(header(received, name), name).toBe(value);
    }
    expect(header(received, 'Accept-Language')).toBeUndefined();
    if (kind === 'post') expect(JSON.parse(received.body)).toEqual({ tag: id });
    if (kind === 'put') expect(received.body).toBe(`put-${id}`);
    expect(received.method).toBe(kind === 'post' ? 'POST' : kind === 'put' ? 'PUT' : 'GET');
  });
}

test('sets request headers on the page navigation itself', async ({ ext, echo }) => {
  const page = await ext.context.newPage();
  const id = tag('document');
  await page.goto(`${echo.origin}/echo/document?tag=${id}`);
  const received = await echo.waitFor(id);
  expect(header(received, 'X-Hb-Test')).toBe('on');
  expect(header(received, 'Accept-Language')).toBeUndefined();
});
