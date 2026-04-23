/**
 * Jest configuration for Detox E2E tests.
 *
 * WHY a separate config (not the root jest.config.js):
 *   Detox E2E tests run in Node environment against a real emulator/simulator.
 *   The root jest.config.js is configured for jsdom + React Native's jest preset.
 *   Mixing the two would cause transform conflicts (Babel vs. native) and env mismatches.
 *
 * WHY testTimeout 180000:
 *   Cold-start tests boot an emulator, install an APK, launch the app 5 times,
 *   and wait for UI elements. Total wall-clock time can exceed 2 minutes on a
 *   slow GitHub Actions runner. 3 minutes gives comfortable headroom.
 *
 * @see https://wix.github.io/Detox/docs/introduction/testrunner
 */

/** @type {import('@jest/types').Config.ProjectConfig} */
module.exports = {
  rootDir: '..',
  testMatch: ['<rootDir>/e2e/**/*.test.ts'],
  testTimeout: 180000,
  maxWorkers: 1,      // WHY 1: Emulator tests cannot safely parallelise on a single host
  globalSetup: 'detox/runners/jest/globalSetup',
  globalTeardown: 'detox/runners/jest/globalTeardown',
  reporters: ['detox/runners/jest/reporter'],
  testEnvironment: 'detox/runners/jest/testEnvironment',
  verbose: true,
};
