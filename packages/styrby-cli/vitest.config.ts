import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

/**
 * Vitest configuration for styrby-cli.
 *
 * Resolves the @/* path alias to match tsconfig paths,
 * so tests can import modules using the same alias syntax as production code.
 */
export default defineConfig({
  test: {
    root: '.',
    include: ['src/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
});
