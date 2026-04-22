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
    include: [
      'src/**/*.test.ts',
      // WHY: The CLI startup benchmark test lives in scripts/perf/__tests__/
      // (repo root, not inside this package) because the benchmark script
      // itself is a repo-level tool rather than a CLI source file. We include
      // it here because (a) it validates CLI binary behaviour, and (b) the
      // `pnpm --filter styrby-cli test` invocation in CI is the right owner.
      // The path is relative to repo root (vitest resolves from CWD = repo root
      // when run via `pnpm --filter`).
      '../../scripts/perf/__tests__/**/*.test.mjs',
    ],
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
    },
  },
});
