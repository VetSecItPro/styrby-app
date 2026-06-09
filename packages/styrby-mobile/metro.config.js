const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');

/**
 * WHY monorepo watch folders: pnpm uses an isolated node_modules structure
 * where packages are stored in .pnpm/node_modules and symlinked into each
 * workspace's own node_modules. Metro's default resolver only looks in
 * packages/styrby-mobile/node_modules and the immediate parent directories.
 * Without the explicit watchFolders and nodeModulesPaths, Metro cannot resolve
 * packages like @babel/runtime that live in the pnpm virtual store.
 *
 * @see https://docs.expo.dev/guides/monorepos/
 */
const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// WHY: Add the monorepo root to Metro's watch list so it can resolve packages
// from the pnpm store (node_modules/.pnpm/node_modules) and workspace siblings.
// WHY append (not replace): preserve Expo's default watchFolders entries and
// add the workspace root on top — replacing the array drops Expo's defaults
// (flagged by `expo-doctor`'s Metro-config check). Appending is strictly
// additive, so monorepo resolution is unchanged and the defaults are retained.
config.watchFolders = [...(config.watchFolders ?? []), workspaceRoot];

// WHY: Tell Metro's resolver where to look for modules. The order matters:
// 1. Package's own node_modules (highest priority)
// 2. Workspace root node_modules (catches hoisted packages via public-hoist-pattern)
// 3. pnpm's virtual store .pnpm/node_modules (catches all packages via symlinks)
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules/.pnpm/node_modules'),
];

// WHY extraNodeModules for Node built-ins: Expo SDK 54's expo-notifications
// pulls in @ide/backoff which does `require('assert')` — Node's built-in,
// not bundled by Metro for React Native. The userland `assert` package
// (https://github.com/browserify/commonjs-assert) is the standard Node-API
// polyfill. Adding it here makes Metro resolve `require('assert')` to the
// polyfill regardless of pnpm's isolated-store hoisting layout.
//
// If a future SDK upgrade pulls in another Node built-in (path, util, fs,
// etc.) and the bundle errors with "Unable to resolve module <name>", add
// the matching polyfill (`path-browserify`, `util`, etc.) here. Don't rely
// on pnpm hoisting — the .pnpm/<pkg>@<ver>/node_modules layout means a
// transitive dep can't see siblings outside its own scope.
config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  assert: require.resolve('assert/'),
};

// WHY blockList for tokenizer packages:
// `@anthropic-ai/tokenizer` and `gpt-tokenizer` are installed as
// optionalDependencies of `@styrby/shared` for the CLI's exact-token-count
// path. They transitively pull `tiktoken` (Rust/WASM) which catastrophically
// breaks Metro. The shared module hides the import via dynamic
// `import('@anthropic-ai/tokenizer'.toString())`, but `@anthropic-ai/tokenizer`
// internally uses CommonJS `require('tiktoken/lite')` which Metro's static
// resolver still finds.
//
// Blocking these packages at the Metro layer guarantees the mobile bundle
// never tries to compile them, regardless of how they get pulled in. The
// shared module's heuristic fallback path runs on mobile.
//
// If a future feature needs exact counts on mobile, route through a server
// proxy (`/api/tokenize`) — do NOT lift this block.
config.resolver.blockList = [
  /node_modules\/@anthropic-ai\/tokenizer\/.*/,
  /node_modules\/gpt-tokenizer\/.*/,
  /node_modules\/tiktoken\/.*/,
  // WHY block __tests__ directories under app/: SDK 54 / expo-router v6 uses
  // require.context() to scan every file in app/ as a potential route.
  // Test files inside app/__tests__ and app/**/__tests__ get bundled and
  // executed at module-load time, throwing `Property 'jest' doesn't exist`
  // because jest globals only exist under the jest-jsdom test runner. Blocking
  // them at the Metro layer keeps the route scan clean. Jest still finds these
  // files via its own resolver (jest.config.js' testMatch / roots), so unit
  // tests are unaffected.
  /\/app\/(.*\/)?__tests__\/.*$/,
];

module.exports = withNativeWind(config, { input: './global.css' });
