/**
 * Vitest configuration for @styrby/native
 *
 * Runs in Node.js environment since the module uses Node.js `require()` and
 * file system APIs. All tests in src/__tests__/ are included.
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
    globals: false,
    testTimeout: 10000,
    reporters: ['verbose'],
  },
});
