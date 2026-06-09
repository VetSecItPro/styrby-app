/**
 * Jest Configuration for Styrby Mobile
 *
 * WHY no jest-expo preset: jest-expo@52's setup.js has a compatibility
 * issue with React Native 0.76 where mockNativeModules.UIManager is
 * undefined during setup, causing Object.defineProperty to fail.
 * Since our tests cover pure functions, services, and hooks (not rendered
 * React Native components), we configure Jest directly with babel-jest
 * for TypeScript transpilation.
 *
 * If we later need to test rendered components (e.g., with
 * @testing-library/react-native), we can revisit this when jest-expo
 * releases a fix for RN 0.76 compatibility.
 */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts', '**/__tests__/**/*.test.tsx'],
  // WHY workerIdleMemoryLimit: The mobile test suite accumulates heap across
  // all test files in a single worker (>4 GB) causing OOM crashes. Setting a
  // 512 MB idle limit recycles the worker process between files, keeping memory
  // manageable. Each worker still grows to 4 GB+ before recycling, so we also
  // use maxWorkers=1 to ensure only one worker processes files at a time.
  workerIdleMemoryLimit: '512MB',
  // WHY maxWorkers 1: With multiple workers each consuming 4 GB simultaneously,
  // the host machine runs out of RAM. Serializing test files through a single
  // worker ensures the GC can reclaim memory between suites.
  maxWorkers: 1,
  moduleNameMapper: {
    // Map the @/ path alias to src/ (mirrors tsconfig.json paths)
    '^@/(.*)$': '<rootDir>/src/$1',
    // WHY @expo/vector-icons mock: The package ships ESM (import statements in
    // .js files) that babel-jest cannot parse when running in CJS mode under
    // pnpm's virtual store layout (.pnpm/). Rather than fighting pnpm symlinks
    // in transformIgnorePatterns, we stub the entire icon library — icon
    // rendering is cosmetic and not logic-under-test in unit/integration tests.
    '^@expo/vector-icons$': '<rootDir>/__mocks__/@expo/vector-icons.js',
    '^@expo/vector-icons/(.*)$': '<rootDir>/__mocks__/@expo/vector-icons.js',
    // Map styrby-shared to its source directory so jest can resolve and transform it
    // WHY: styrby-shared publishes ESM dist/ but jest runs in CJS mode.
    // Pointing at source lets babel-jest handle the transform.
    '^styrby-shared$': '<rootDir>/../styrby-shared/src/index.ts',
    // Subpath: encryption module is exported separately to keep libsodium
    // (~700KB WASM) out of bundles that don't need crypto.
    '^styrby-shared/encryption$': '<rootDir>/../styrby-shared/src/encryption.ts',
    // WHY (Phase 1.6.6): Map @styrby/shared/logging subpath to source so
    // babel-jest can transform it in CJS mode. The package.json exports field
    // points at dist/logging/index.js (ESM) which Jest cannot consume directly.
    '^@styrby/shared/logging$': '<rootDir>/../styrby-shared/src/logging/index.ts',
    // WHY: Map @styrby/shared/billing subpath to source so babel-jest can
    // transform it in CJS mode. The package.json exports field points at
    // dist/billing/index.js (ESM) which Jest cannot consume directly. Consumed
    // by useSubscriptionTier / useBudgetAlerts (normalizeTier tier-gate fixes).
    '^@styrby/shared/billing$': '<rootDir>/../styrby-shared/src/billing/index.ts',
    // WHY strip the .js extension on RELATIVE imports: the shared source is
    // authored ESM-style ('./tier-logic.js') but the files on disk are .ts.
    // When we map a subpath barrel (billing/index.ts) to source, Jest resolves
    // that barrel's own './tier-logic.js' literally and fails. Rewriting any
    // relative '*.js' import back to extensionless lets Jest's default resolver
    // find the .ts/.tsx source. Scoped to ./ and ../ so it never touches
    // package or absolute-path mappings above.
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    // Use babel-jest with Expo's Babel config for TypeScript support
    '\\.[jt]sx?$': [
      'babel-jest',
      {
        caller: { name: 'metro', bundler: 'metro', platform: 'ios' },
      },
    ],
  },
  transformIgnorePatterns: [
    // Transform Expo/RN packages that ship untranspiled ESM.
    //
    // WHY @supabase: @supabase/supabase-js ships ESM. We need to transform it
    // so Jest can mock the createClient export in supabase.test.ts.
    //
    // WHY the optional `\\.pnpm/.*\\/node_modules/` prefix: pnpm uses a
    // content-addressable store at `node_modules/.pnpm/<pkg>@<version>_<hash>/
    // node_modules/<pkg>/`. The first `node_modules/` matches but then
    // `.pnpm/` doesn't match the allow-list, so files get incorrectly
    // skipped from transformation. The optional prefix lets the regex
    // recognise the pnpm layout and apply the allow-list to the inner
    // `<pkg>` path. (npm's flat layout is unaffected — the prefix is
    // optional.) Surfaced during the SDK 52→54 upgrade when
    // `expo/virtual/env.js` (a new internal SDK 54 module) failed to
    // transpile and broke ~20 test suites.
    //
    // NOTE on expo-passkey: it is deliberately NOT in this allow-list. It is an
    // Expo *native* module (`requireNativeModule`) that cannot load in this
    // pure-node test environment regardless of transpilation. The suites that
    // touch it mock the `expo-passkey/native` subpath the source actually
    // imports (see app/__tests__/login-passkey, app/settings/__tests__/passkeys,
    // app/__tests__/auth-screens) rather than transforming it.
    'node_modules/(?!(\\.pnpm/.*/node_modules/)?((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|react-navigation|@react-navigation/.*|native-base|react-native-svg|styrby-shared|@styrby/shared|@supabase)/)',
  ],
  setupFiles: ['./jest.setup.js'],
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/*.d.ts',
    '!src/**/index.ts',
  ],
};
