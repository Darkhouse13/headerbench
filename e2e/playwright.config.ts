import { defineConfig } from '@playwright/test';

/**
 * Each test launches its own headless Chromium with the unpacked E2E build of the extension
 * (`extension/dist-e2e`). Set PW_CHROMIUM_PATH to use a specific Chromium binary.
 */
export default defineConfig({
  testDir: '.',
  // Store and site screenshots rewrite tracked images, so they run only via `npm run screenshots`.
  testMatch: process.env.HB_SCREENSHOTS ? ['screenshots.spec.ts'] : ['specs/**/*.spec.ts'],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  outputDir: 'test-results',
  use: { trace: 'retain-on-failure' },
});
