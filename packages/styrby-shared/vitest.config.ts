import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration for styrby-shared.
 *
 * Uses the Node environment since this package has no DOM dependencies.
 * Includes both src/ (for colocated tests) and tests/ (for the dedicated
 * test directory that mirrors the src structure).
 */
export default defineConfig({
  test: {
    environment: 'node',
    root: '.',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
  },
});
