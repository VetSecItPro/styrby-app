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
  moduleNameMapper: {
    // Map the @/ path alias to src/ (mirrors tsconfig.json paths)
    '^@/(.*)$': '<rootDir>/src/$1',
    // Map styrby-shared to its source directory so jest can resolve and transform it
    // WHY: styrby-shared publishes ESM dist/ but jest runs in CJS mode.
    // Pointing at source lets babel-jest handle the transform.
    '^styrby-shared$': '<rootDir>/../styrby-shared/src/index.ts',
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
