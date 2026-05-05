/**
 * Tests for the keychain-backed secret store (CLI-006, audit 2026-05-04).
 *
 * Verifies:
 *  - keytar success path: getSecret/setSecret/deleteSecret round-trip
 *  - keytar failure path: encrypted-fallback file is used
 *  - migration from legacy data.json plaintext into the keychain
 *
 * @module auth/__tests__/secret-store
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ----------------------------------------------------------------------
// Per-test isolated $HOME so the AES-encrypted fallback file lives in
// a tmpdir we can clean up between tests.
// ----------------------------------------------------------------------
let tmpHome: string;
const realHomedir = os.homedir;

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'styrby-secret-store-'));
  vi.spyOn(os, 'homedir').mockImplementation(() => tmpHome);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  try { await fs.rm(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ----------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------
function mockKeytarSuccess() {
  const store = new Map<string, string>();
  vi.doMock('keytar', () => ({
    getPassword: vi.fn(async (_svc: string, name: string) => store.get(name) ?? null),
    setPassword: vi.fn(async (_svc: string, name: string, value: string) => { store.set(name, value); }),
    deletePassword: vi.fn(async (_svc: string, name: string) => store.delete(name)),
    findCredentials: vi.fn(async () => Array.from(store, ([account, password]) => ({ account, password }))),
  }));
  return store;
}

function mockKeytarUnavailable() {
  // Simulate import-time failure: dynamic import throws.
  vi.doMock('keytar', () => { throw new Error('libsecret not available'); });
}

// ----------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------
describe('secret-store: keytar success path', () => {
  it('round-trips a value through the keychain', async () => {
    mockKeytarSuccess();
    const mod = await import('../secret-store');
    mod.__resetForTests();

    expect(await mod.getSecret('styrby_api_key')).toBeNull();
    await mod.setSecret('styrby_api_key', 'styrby_test_xyz');
    expect(await mod.getSecret('styrby_api_key')).toBe('styrby_test_xyz');
    await mod.deleteSecret('styrby_api_key');
    expect(await mod.getSecret('styrby_api_key')).toBeNull();
  });
});

describe('secret-store: keytar fallback path (encrypted file)', () => {
  it('persists into the AES-GCM fallback when keytar import fails', async () => {
    mockKeytarUnavailable();
    const mod = await import('../secret-store');
    mod.__resetForTests();

    await mod.setSecret('styrby_api_key', 'fallback_value');
    const stored = await mod.getSecret('styrby_api_key');
    expect(stored).toBe('fallback_value');

    // Verify the on-disk blob is NOT plaintext — should not contain the value.
    const fallbackFile = path.join(tmpHome, '.styrby', 'secrets.enc');
    const raw = await fs.readFile(fallbackFile);
    expect(raw.includes(Buffer.from('fallback_value'))).toBe(false);
  });
});

describe('secret-store: migrateLegacySecret', () => {
  it('moves a legacy plaintext value into the keychain (returns "migrated")', async () => {
    const store = mockKeytarSuccess();
    const mod = await import('../secret-store');
    mod.__resetForTests();

    const result = await mod.migrateLegacySecret('styrby_api_key', 'legacy_plaintext_value');
    expect(result).toBe('migrated');
    expect(store.get('styrby_api_key')).toBe('legacy_plaintext_value');
  });

  it('returns "already-keychain" when the secret is already present', async () => {
    const store = mockKeytarSuccess();
    store.set('styrby_api_key', 'already_there');
    const mod = await import('../secret-store');
    mod.__resetForTests();

    const result = await mod.migrateLegacySecret('styrby_api_key', 'legacy_value');
    expect(result).toBe('already-keychain');
    // Did not overwrite.
    expect(store.get('styrby_api_key')).toBe('already_there');
  });

  it('returns "not-present" when no legacy value exists', async () => {
    mockKeytarSuccess();
    const mod = await import('../secret-store');
    mod.__resetForTests();

    expect(await mod.migrateLegacySecret('styrby_api_key', null)).toBe('not-present');
    expect(await mod.migrateLegacySecret('styrby_api_key', undefined)).toBe('not-present');
    expect(await mod.migrateLegacySecret('styrby_api_key', '')).toBe('not-present');
  });

  it('returns "keytar-unavailable" when the keychain cannot be reached', async () => {
    mockKeytarUnavailable();
    const mod = await import('../secret-store');
    mod.__resetForTests();

    const result = await mod.migrateLegacySecret('styrby_api_key', 'legacy_value');
    expect(result).toBe('keytar-unavailable');
  });
});
