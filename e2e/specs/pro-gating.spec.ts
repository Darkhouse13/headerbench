/**
 * Spec 7: a regex redirect is Pro. Without a licence or trial it stays paused; the trial, a licence
 * applied through the message API, the website's external activation and the Settings paste box
 * each turn it on.
 */
import { defaultState, exportJson } from '@headerbench/core';
import type { Page } from '@playwright/test';
import type { EchoServer } from '../echo-server.ts';
import type { ExtensionHarness } from '../support/extension.ts';
import { expect, test } from '../support/fixtures.ts';
import { devLicense, tamper } from '../support/license.ts';
import { profile, redirect } from '../support/profiles.ts';

/** Imports (rather than saves) the profile: an import never starts the trial. */
async function importRegexRedirect(ext: ExtensionHarness, echo: EchoServer): Promise<void> {
  const p = profile('Bundle to local', {
    redirects: [
      redirect(
        'regex',
        `^http://127\\.0\\.0\\.1:${echo.port}/v1/(.*)$`,
        `${echo.origin}/echo/v2/$1`,
      ),
    ],
  });
  const text = exportJson({ ...defaultState(), profiles: [p] });
  const outcome = await ext.send({ type: 'importText', text, apply: true });
  expect(outcome.profileIds).toHaveLength(1);
  const snap = await ext.activate(outcome.profileIds[0] as string);
  expect(snap.pro).toMatchObject({ pro: false, source: null });
  expect(snap.warnings.map((w) => w.code)).toContain('PRO_PAUSED');
}

/** Path the server saw for `/v1/users` (404 means the redirect did not apply). */
const pathFor = (page: Page): Promise<{ status: number; path: string | null }> =>
  page.evaluate(async () => {
    const res = await fetch('/v1/users?id=42');
    return {
      status: res.status,
      path: res.ok ? ((await res.json()) as { path: string }).path : null,
    };
  });

test.beforeEach(async ({ ext, echo }) => {
  await importRegexRedirect(ext, echo);
});

test('without Pro the regex redirect is paused; the trial turns it on', async ({
  ext,
  openHarness,
}) => {
  const page = await openHarness();
  expect(await pathFor(page)).toEqual({ status: 404, path: null });

  const snap = await ext.send({ type: 'startTrial' });
  expect(snap.pro).toMatchObject({ pro: true, source: 'trial' });
  expect(await pathFor(page)).toEqual({ status: 200, path: '/echo/v2/users' });
});

test('a licence applied through the message API turns it on', async ({ ext, openHarness }) => {
  const page = await openHarness();
  const rejected = await ext.request({ type: 'applyLicense', key: tamper(devLicense()) });
  expect(rejected).toMatchObject({ ok: false, code: 'license_invalid' });
  expect(await pathFor(page)).toEqual({ status: 404, path: null });

  const outcome = await ext.send({ type: 'applyLicense', key: devLicense() });
  expect(outcome).toMatchObject({ plan: 'pro_yearly', expired: false });
  expect(outcome.snapshot.pro).toMatchObject({ pro: true, source: 'license' });
  expect(await pathFor(page)).toEqual({ status: 200, path: '/echo/v2/users' });
});

test('the website activation message turns it on', async ({ ext, echo, openHarness }) => {
  const site = await ext.context.newPage();
  await site.goto(`${echo.origin}/activate?ext=${ext.id}`);

  const bad = await site.evaluate((key) => window.activate(key), tamper(devLicense()));
  expect(bad).toMatchObject({ ok: false });
  const expired = await site.evaluate(
    (key) => window.activate(key),
    devLicense({ exp: Math.floor(Date.now() / 1000) - 60 }),
  );
  expect(expired).toMatchObject({ ok: false, reason: expect.stringContaining('expired') });
  expect((await ext.snapshot()).pro.pro).toBe(false);

  const good = await site.evaluate(
    (key) => window.activate(key),
    devLicense({ plan: 'pro_lifetime', sub: null, lid: 'txn_01e2elife', exp: null }),
  );
  expect(good).toMatchObject({ ok: true, plan: 'pro_lifetime', expiresAt: null });
  expect((await ext.snapshot()).pro).toMatchObject({ pro: true, source: 'license' });
  expect(await pathFor(await openHarness())).toEqual({ status: 200, path: '/echo/v2/users' });
});

test('a licence pasted in Settings turns it on', async ({ ext, openHarness }) => {
  const settings = await ext.context.newPage();
  await settings.goto(ext.url('app.html#/settings'));
  await settings.getByLabel('Licence key', { exact: true }).fill(devLicense());
  await settings.getByRole('button', { name: 'Activate' }).click();
  await expect(settings.getByText(/^Pro yearly is active until/)).toBeVisible();

  expect(await pathFor(await openHarness())).toEqual({ status: 200, path: '/echo/v2/users' });
});
