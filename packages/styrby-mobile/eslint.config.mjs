/**
 * ESLint flat config for Styrby Mobile (Expo / React Native).
 *
 * Uses ESLint 9 flat config format with:
 * - @eslint/js recommended rules
 * - typescript-eslint for TypeScript support
 * - eslint-plugin-react-hooks for hooks rule enforcement
 *
 * We skip eslint-config-expo because it does not support flat config yet.
 * Rules are intentionally light — the goal is catching real bugs, not style.
 */
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooksPlugin from 'eslint-plugin-react-hooks';

/** @type {import('eslint').Linter.Config[]} */
const config = [
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // React hooks rules - manually configured since flat config format varies by version
  {
    plugins: {
      'react-hooks': reactHooksPlugin,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  // Project-specific overrides
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      // Allow unused vars prefixed with underscore (common for intentionally unused params)
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      // Allow require() calls — needed in Expo config files and asset loading
      '@typescript-eslint/no-require-imports': 'off',

      // Allow explicit `any` as warning, not error — tighten later
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },

  // Ignore build artifacts and generated files
  {
    ignores: [
      'node_modules/',
      '.expo/',
      'dist/',
      'android/',
      'ios/',
      'babel.config.js',
      'metro.config.js',
      'tailwind.config.js',
    ],
  },
];

export default config;
