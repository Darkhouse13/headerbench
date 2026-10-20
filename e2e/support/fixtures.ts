/**
 * Playwright fixtures: one echo server per worker, and a fresh Chromium profile with the extension
 * per test, so no state leaks between specs.
 */
import { test as base, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { EchoServer, RecordedRequest } from '../echo-server.ts';
import { startEchoServer } from '../echo-server.ts';
import type { ExtensionHarness } from './extension.ts';
import { launchExtension } from './extension.ts';

interface TestFixtures {
  ext: ExtensionHarness;
  /** Opens the echo harness page (`window.hb`) on 127.0.0.1, or on another origin of the server. */
  openHarness: (origin?: string) => Promise<Page>;
}

export const test = base.extend<TestFixtures, { echo: EchoServer }>({
  echo: [
    async ({}, use) => {
      const server = await startEchoServer();
      await use(server);
      await server.close();
    },
    { scope: 'worker' },
  ],
  ext: async ({}, use) => {
    const harness = await launchExtension();
    await use(harness);
    await harness.close();
  },
  openHarness: async ({ ext, echo }, use) => {
    await use(async (origin = echo.origin) => {
      const page = await ext.context.newPage();
      await page.goto(`${origin}/harness?page=${Math.random().toString(36).slice(2)}`);
      await page.waitForFunction(() => 'hb' in window);
      return page;
    });
  },
});

export { expect };

let counter = 0;
/** A tag unique within the worker, so each request can be found at the echo server. */
export function tag(label: string): string {
  counter += 1;
  return `${label}-${process.pid}-${counter}`;
}

/** The value of a header as the echo server received it. */
export function header(req: RecordedRequest, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value.join(', ') : value;
}
