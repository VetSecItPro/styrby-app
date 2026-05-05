/**
 * Tests for the CLI version constant (cli/version.ts).
 *
 * WHY: VERSION used to be a hand-synced string literal that drifted from
 * package.json every release. ESC-3 fixed the source by importing the
 * manifest directly. This test guards against re-introduction of a
 * hand-synced literal: it asserts that the exported VERSION is exactly
 * what package.json carries. If anyone ever reverts to a literal that
 * happens to match today's manifest version, this test still passes — but
 * the next package.json bump WILL break it, restoring the drift signal.
 *
 * @module cli/__tests__/version.test
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { VERSION } from '../version';

describe('CLI VERSION constant', () => {
  it('matches package.json version exactly', () => {
    const pkgPath = resolve(__dirname, '../../../package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };

    expect(VERSION).toBe(pkg.version);
  });

  it('is a non-empty semver-shaped string', () => {
    expect(typeof VERSION).toBe('string');
    expect(VERSION.length).toBeGreaterThan(0);
    // Loose semver shape — accepts pre-release tags like 0.2.0-beta.1
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+(-.+)?$/);
  });
});
