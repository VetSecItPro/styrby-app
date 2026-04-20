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
      // WHY (Phase 1.1): Mirror the tsconfig.json path mapping so vitest
      // can resolve `import ... from 'styrby-shared'` to the workspace
      // package's built `dist/` output. Without this alias, vite's
      // resolver fails because styrby-shared is not listed as a runtime
      // dependency in styrby-cli's package.json (it is referenced via the
      // tsconfig paths mechanism that the production esbuild build also
      // honours via tsc-alias).
      'styrby-shared': resolve(__dirname, '../styrby-shared/dist/index.js'),
    },
  },
});
