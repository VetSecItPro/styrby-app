import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

/**
 * Vitest configuration for styrby-web.
 *
 * WHY jsdom: API route tests run Node server code, but component tests
 * need a DOM. jsdom covers both — server tests ignore the DOM, component
 * tests use it. Avoids needing separate environments.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.{ts,tsx}', '__tests__/**/*.test.{ts,tsx}'],
    exclude: ['node_modules', '.next', 'tests/e2e'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      reportsDirectory: '../../.test-reports/coverage',
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/**/*.d.ts',
        'src/emails/**',
        'src/components/ui/**',
      ],
    },
    globals: true,
  },
  resolve: {
    // WHY array form (not object): we need both an exact match for `@styrby/shared`
    // AND a regex match for subpath imports like `@styrby/shared/logging`,
    // `@styrby/shared/context-sync`, etc. Object form does prefix matching that
    // doesn't distinguish these cases cleanly without the broader regex.
    alias: [
      { find: '@', replacement: path.resolve(__dirname, './src') },
      // WHY: @styrby/shared dist/ is not pre-built in dev/test environments.
      // Pointing vitest directly to the TypeScript source avoids the "Failed
      // to resolve import" error during test collection. The mock layer
      // (vi.mock('@styrby/shared')) still intercepts at runtime as expected.
      {
        find: /^@styrby\/shared$/,
        replacement: path.resolve(__dirname, '../styrby-shared/src/index.ts'),
      },
      // Subpath imports like `@styrby/shared/logging`, `/context-sync`, `/billing`
      // resolve to `../styrby-shared/src/<subpath>`. Vite's TypeScript extension
      // resolution handles `.ts` / `index.ts` automatically.
      {
        find: /^@styrby\/shared\/(.*)$/,
        replacement: path.resolve(__dirname, '../styrby-shared/src/$1'),
      },
    ],
  },
});
