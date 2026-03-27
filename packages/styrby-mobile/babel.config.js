module.exports = function (api) {
  api.cache(true);

  /**
   * WHY: NativeWind's babel preset injects `_ReactNativeCSSInterop` references
   * at compile time. In Jest's node test environment, these references fail
   * because the css-interop runtime depends on Appearance API, DOM globals,
   * and other browser/RN-only features. We conditionally exclude the NativeWind
   * preset during test runs so screens can be rendered with react-test-renderer.
   */
  const isTest = process.env.NODE_ENV === 'test';

  return {
    presets: isTest
      ? ['babel-preset-expo']
      : [
          ['babel-preset-expo', { jsxImportSource: 'nativewind' }],
          'nativewind/babel',
        ],
  };
};
