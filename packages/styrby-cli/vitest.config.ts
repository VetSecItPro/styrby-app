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
      // WHY: Mirror the tsconfig path for the cost module so vitest can
      // resolve `import ... from '@styrby/shared/cost'` during test runs.
      '@styrby/shared/cost': resolve(__dirname, '../styrby-shared/dist/cost/index.js'),
      // WHY (Phase 1.6.6): Mirror the tsconfig path for the logging subpath
      // so vitest can resolve `import ... from '@styrby/shared/logging'`
      // during test runs. The subpath export in styrby-shared's package.json
      // points to dist/logging/index.js, but vitest's Vite resolver needs an
      // explicit alias to find it since it doesn't traverse package.json exports.
      '@styrby/shared/logging': resolve(__dirname, '../styrby-shared/dist/logging/index.js'),
    },
  },
});
