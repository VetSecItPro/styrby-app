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
    // Map styrby-shared to its source directory so jest can resolve and transform it
    // WHY: styrby-shared publishes ESM dist/ but jest runs in CJS mode.
    // Pointing at source lets babel-jest handle the transform.
    '^styrby-shared$': '<rootDir>/../styrby-shared/src/index.ts',
    // Subpath: encryption module is exported separately to keep libsodium
    // (~700KB WASM) out of bundles that don't need crypto.
    '^styrby-shared/encryption$': '<rootDir>/../styrby-shared/src/encryption.ts',
    // Strip .js extensions from relative imports inside styrby-shared source files.
    // WHY: TypeScript ESM source files use `./foo.js` extensions (Node16 module
    // resolution), but Jest (CJS mode) resolves `./foo.ts` not `./foo.js`.
    // This mapper drops the `.js` suffix so Jest can find the TypeScript source.
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
    // Transform Expo/RN packages that ship untranspiled ESM
    // WHY @supabase: @supabase/supabase-js ships ESM. We need to transform it
    // so Jest can mock the createClient export in supabase.test.ts.
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|react-navigation|@react-navigation/.*|native-base|react-native-svg|styrby-shared|@supabase)/)',
  ],
  setupFiles: ['./jest.setup.js'],
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/*.d.ts',
    '!src/**/index.ts',
  ],
};
