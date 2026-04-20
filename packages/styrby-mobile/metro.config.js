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
config.watchFolders = [workspaceRoot];

// WHY: Tell Metro's resolver where to look for modules. The order matters:
// 1. Package's own node_modules (highest priority)
// 2. Workspace root node_modules (catches hoisted packages via public-hoist-pattern)
// 3. pnpm's virtual store .pnpm/node_modules (catches all packages via symlinks)
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules/.pnpm/node_modules'),
];

module.exports = withNativeWind(config, { input: './global.css' });
