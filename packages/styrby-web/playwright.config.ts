import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for Styrby web dashboard E2E tests.
 *
 * baseURL resolution (in priority order):
 *   1. PLAYWRIGHT_BASE_URL env var — for running against deployed environments
 *      (preview, production) without spinning up a local server. Set this when
 *      `npm run start` can't bind :3000 because another process holds it, or
 *      when you want to verify post-deploy behavior against the real prod stack.
 *   2. http://localhost:3000 — default local-dev path. Pairs with the
 *      webServer block below to auto-start `npm run start`.
 *
 * @see https://playwright.dev/docs/test-configuration
 */
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3000';
const IS_LOCAL = BASE_URL.startsWith('http://localhost');

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // Only auto-start a local webServer when we're targeting localhost. Against a
  // deployed URL the server is already running; spinning up `npm run start`
  // there is wasteful and races on port :3000 if something else holds it.
  ...(IS_LOCAL && {
    webServer: {
      command: 'npm run start',
      url: BASE_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  }),
});
