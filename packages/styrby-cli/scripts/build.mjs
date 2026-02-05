#!/usr/bin/env node
/**
 * Production Build Script
 *
 * Bundles the CLI into a single self-contained file using esbuild.
 * This ensures npm users don't have dependency resolution issues
 * with workspace packages like styrby-shared.
 *
 * WHY: When publishing to npm, workspace dependencies don't resolve.
 * Bundling inlines all code into one file, making it self-contained.
 */

import * as esbuild from 'esbuild';
import { execSync } from 'node:child_process';
import { rmSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Clean dist folder
console.log('🧹 Cleaning dist folder...');
rmSync(join(ROOT, 'dist'), { recursive: true, force: true });
mkdirSync(join(ROOT, 'dist'), { recursive: true });

// First, run tsc to generate declaration files (.d.ts)
// These are needed for library consumers
console.log('📝 Generating type declarations...');
try {
  execSync('npx tsc --emitDeclarationOnly --declaration --declarationMap', {
    cwd: ROOT,
    stdio: 'inherit',
  });
} catch (error) {
  console.error('⚠️  Type declaration generation had issues (non-fatal)');
}

// Bundle with esbuild
console.log('📦 Bundling with esbuild...');

/**
 * External packages that should NOT be bundled.
 * These are:
 * - Native Node modules that can't be bundled
 * - Large packages that users likely already have
 * - Packages with native bindings
 */
const external = [
  // Native modules
  'fsevents',
  // React (ink uses it, better to keep external for deduplication)
  'react',
  'react-dom',
  // Large packages that are better external
  'typescript',
];

await esbuild.build({
  entryPoints: [join(ROOT, 'src/index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: join(ROOT, 'dist/index.js'),
  external,
  sourcemap: true,
  minify: false, // Keep readable for security audits
  keepNames: true, // Preserve function names for stack traces

  // Resolve workspace packages
  alias: {
    'styrby-shared': join(ROOT, '..', 'styrby-shared', 'src', 'index.ts'),
  },

  // Handle path aliases
  plugins: [{
    name: 'path-alias',
    setup(build) {
      // Resolve @/* to src/*.ts
      build.onResolve({ filter: /^@\// }, args => {
        const relativePath = args.path.slice(2); // Remove '@/'
        let fullPath = join(ROOT, 'src', relativePath);

        // Try with .ts extension first
        if (existsSync(fullPath + '.ts')) {
          return { path: fullPath + '.ts' };
        }
        // Try as directory with index.ts
        if (existsSync(join(fullPath, 'index.ts'))) {
          return { path: join(fullPath, 'index.ts') };
        }
        // Fallback
        return { path: fullPath };
      });
    },
  }],

  // Note: Shebang comes from src/index.ts, no need to add via banner

  // Define environment
  define: {
    'process.env.NODE_ENV': '"production"',
  },
});

// Also build the library entry point (for programmatic usage)
console.log('📚 Building library entry point...');
await esbuild.build({
  entryPoints: [join(ROOT, 'src/lib.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: join(ROOT, 'dist/lib.js'),
  external: [...external, './index.js'],
  sourcemap: true,
  minify: false,
  keepNames: true,
  alias: {
    'styrby-shared': join(ROOT, '..', 'styrby-shared', 'src', 'index.ts'),
  },
  plugins: [{
    name: 'path-alias',
    setup(build) {
      build.onResolve({ filter: /^@\// }, args => {
        const relativePath = args.path.slice(2);
        let fullPath = join(ROOT, 'src', relativePath);

        if (existsSync(fullPath + '.ts')) {
          return { path: fullPath + '.ts' };
        }
        if (existsSync(join(fullPath, 'index.ts'))) {
          return { path: join(fullPath, 'index.ts') };
        }
        return { path: fullPath };
      });
    },
  }],
});

console.log('✅ Build complete!');
console.log('');
console.log('Output:');
console.log('  dist/index.js  - CLI entry point (bundled)');
console.log('  dist/lib.js    - Library entry point');
console.log('  dist/*.d.ts    - Type declarations');
