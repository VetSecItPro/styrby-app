#!/usr/bin/env node
/**
 * Styrby CLI entry point.
 *
 * In production (npm install -g styrby), this runs the compiled JavaScript.
 * In development, use `npm run dev` which uses tsx directly.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Import and run the compiled CLI
const distPath = join(__dirname, '..', 'dist', 'index.js');

try {
  await import(distPath);
} catch (error) {
  if (error.code === 'ERR_MODULE_NOT_FOUND') {
    console.error('Error: Styrby CLI not built. Run `npm run build` first.');
    console.error('If you installed via npm, please report this issue.');
    process.exit(1);
  }
  throw error;
}
