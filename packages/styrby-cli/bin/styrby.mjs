#!/usr/bin/env node
/**
 * Styrby CLI entry point.
 *
 * Uses tsx to run TypeScript directly with path alias support.
 * For production, we'll bundle with esbuild or similar.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Find tsx - could be in local or root node_modules
const localTsx = join(__dirname, '..', 'node_modules', '.bin', 'tsx');
const rootTsx = join(__dirname, '..', '..', '..', 'node_modules', '.bin', 'tsx');
const tsxPath = existsSync(localTsx) ? localTsx : rootTsx;

const srcPath = join(__dirname, '..', 'src', 'index.ts');

const child = spawn(tsxPath, [srcPath, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', (code) => {
  process.exit(code ?? 0);
});
