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
 *
 * WHY: We use the react-hooks flat config but disable the React Compiler rules
 * (set-state-in-effect, immutability, purity, etc.) because they are designed
 * for codebases already using the React Compiler. Calling setState in useEffect
 * callbacks is a standard pattern in React Native for responding to relay
 * messages, subscriptions, and other async events.
 */
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooksPlugin from 'eslint-plugin-react-hooks';

/** @type {import('eslint').Linter.Config[]} */
const config = [
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // React hooks rules (flat config preset from .configs.flat namespace)
  reactHooksPlugin.configs.flat['recommended-latest'],

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

      // Core hooks rules — keep enforced (these catch real bugs)
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',

      // React Compiler rules — disable for now. These are designed for
      // codebases using the React Compiler and are too strict for standard
      // React Native patterns (e.g., setState in effect callbacks for
      // relay messages, subscriptions, navigation state).
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/immutability': 'off',
      'react-hooks/purity': 'off',
      'react-hooks/set-state-in-render': 'off',
      'react-hooks/static-components': 'off',
      'react-hooks/use-memo': 'off',
      'react-hooks/void-use-memo': 'off',
      'react-hooks/component-hook-factories': 'off',
      'react-hooks/preserve-manual-memoization': 'off',
      'react-hooks/incompatible-library': 'off',
      'react-hooks/globals': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/error-boundaries': 'off',
      'react-hooks/unsupported-syntax': 'off',
      'react-hooks/config': 'off',
      'react-hooks/gating': 'off',
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
