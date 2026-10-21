/**
 * The service worker refreshes a yearly licence in its last 14 days on its 6-hourly alarm: one
 * POST with only `{ key }`, and the renewed key replaces the stored one. Outside that window the
 * alarm makes no request.
 *
 * The E2E build talks to https://headerbench.com. The API base is a build-time constant and the
 * echo server's port is picked per worker, so each test runs a copy of the build whose constant
 * points at the echo server (which has a dev-key `/api/license/refresh`).
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EchoServer } from '../echo-server.ts';
import type { ExtensionHarness } from '../support/extension.ts';
import { extensionVariant, launchExtension } from '../support/extension.ts';
import { expect, test } from '../support/fixtures.ts';
import { devLicense } from '../support/license.ts';

const PROD_API_BASE = 'var API_BASE = "https://headerbench.com";';
const LICENSE_ALARM = 'headerbench-license';
const DAY_SEC = 86400;

let variant: ReturnType<typeof extensionVariant>;
let ext: ExtensionHarness;
/** The echo server lives for the whole worker; count only this test's requests. */
let seenBefore = 0;

/** Rewrites the bundled API base in a copy of the build; fails loudly if the bundle changed shape. */
function pointApiBaseAt(dir: string, origin: string): void {
  const assets = join(dir, 'assets');
  const files = readdirSync(assets).filter((f) =>
    readFileSync(join(assets, f), 'utf8').includes(PROD_API_BASE),
  );
  if (files.length !== 1) {
    throw new Error(`Expected one bundle defining API_BASE, found: ${files.join(', ') || 'none'}`);
  }
  const path = join(assets, files[0] as string);
  writeFileSync(
    path,
    readFileSync(path, 'utf8').replace(PROD_API_BASE, `var API_BASE = ${JSON.stringify(origin)};`),
  );
}

test.beforeEach(async ({ echo }) => {
  variant = extensionVariant((manifest) => manifest);
  pointApiBaseAt(variant.dir, echo.origin);
  ext = await launchExtension({ extensionDir: variant.dir });
  seenBefore = echo.requests.length;
});

test.afterEach(async () => {
  await ext.close();
  variant.dispose();
});

const refreshRequests = (echo: EchoServer) =>
  echo.requests.slice(seenBefore).filter((r) => r.path === '/api/license/refresh');

/** Fires the licence alarm now, as Chrome does every 6 hours, and waits until it has fired. */
async function fireLicenseAlarm(): Promise<void> {
  const control = await ext.control();
  await control.evaluate((name) => chrome.alarms.create(name, { when: Date.now() }), LICENSE_ALARM);
  await expect
    .poll(() => control.evaluate((name) => chrome.alarms.get(name), LICENSE_ALARM))
    .toBeUndefined();
}

const storedKey = async (): Promise<string | null> =>
  (await ext.snapshot()).state.settings.licenseKey;

test('the alarm renews a yearly licence that ends within 14 days', async ({ echo }) => {
  const exp = Math.floor(Date.now() / 1000) + 10 * DAY_SEC;
  const key = devLicense({ exp });
  await ext.send({ type: 'applyLicense', key });
  expect(refreshRequests(echo)).toHaveLength(0);

  await fireLicenseAlarm();
  await expect.poll(storedKey).not.toBe(key);

  const requests = refreshRequests(echo);
  expect(requests).toHaveLength(1);
  expect(requests[0]?.method).toBe('POST');
  expect(JSON.parse(requests[0]?.body ?? 'null')).toEqual({ key });

  const outcome = await ext.send({ type: 'refreshLicense', auto: true });
  expect(outcome.skipped).toBe(true);
  expect(outcome.plan).toBe('pro_yearly');
  expect(outcome.expiresAt).toBeGreaterThan((exp + 300 * DAY_SEC) * 1000);
  expect(outcome.snapshot.pro).toMatchObject({ pro: true, source: 'license' });
  expect(outcome.snapshot.licenseRefreshError).toBeNull();
  expect(refreshRequests(echo)).toHaveLength(1);
});

test('the alarm sends nothing for a licence that ends in 60 days', async ({ echo }) => {
  const key = devLicense({ exp: Math.floor(Date.now() / 1000) + 60 * DAY_SEC });
  await ext.send({ type: 'applyLicense', key });

  await fireLicenseAlarm();
  // Messages queue behind the alarm's own check, so this answers after it.
  const outcome = await ext.send({ type: 'refreshLicense', auto: true });
  expect(outcome.skipped).toBe(true);
  await new Promise((r) => setTimeout(r, 500));

  expect(refreshRequests(echo)).toHaveLength(0);
  expect(await storedKey()).toBe(key);
});
