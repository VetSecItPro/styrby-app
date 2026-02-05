import nextConfig from 'eslint-config-next';

/** @type {import('eslint').Linter.Config[]} */
const config = [
  ...nextConfig,
  {
    rules: {
      // Allow unused vars prefixed with underscore (common pattern for intentionally unused params)
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    ignores: ['.next/', 'node_modules/', 'playwright-report/', 'test-results/'],
  },
];

export default config;
