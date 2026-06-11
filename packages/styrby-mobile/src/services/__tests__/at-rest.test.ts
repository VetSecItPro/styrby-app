/**
 * Unit tests for `services/at-rest` (SEC-MOB-001 offline-queue at-rest crypto).
 *
 * The shared XChaCha20 primitive + libsodium WASM are mocked with a
 * deterministic identity stand-in so these tests exercise THIS module's logic —
 * the version tag, the legacy-plaintext passthrough, the device-key
 * get-or-create, and the blob round-trip — without pulling WASM into jest.
 */

// In-memory SecureStore.
const mockStore = new Map<string, string>();
jest.mock('expo-secure-store', () => ({
  getItemAsync: (k: string) => Promise.resolve(mockStore.get(k) ?? null),
  setItemAsync: (k: string, v: string) => { mockStore.set(k, v); return Promise.resolve(); },
  deleteItemAsync: (k: string) => { mockStore.delete(k); return Promise.resolve(); },
}));

jest.mock('react-native-get-random-values', () => ({}));

// Deterministic identity "crypto": ciphertext === plaintext bytes, fixed nonce.
jest.mock('styrby-shared/encryption', () => ({
  XCHACHA20_KEY_BYTES: 32,
  encryptStream: (plaintext: Uint8Array) =>
    Promise.resolve({ ciphertext: plaintext, nonce: new Uint8Array(24).fill(7) }),
  decryptStream: (ciphertext: Uint8Array) => Promise.resolve(ciphertext),
  encodeBase64: (b: Uint8Array) => Promise.resolve(Buffer.from(b).toString('base64')),
  decodeBase64: (s: string) => Promise.resolve(new Uint8Array(Buffer.from(s, 'base64'))),
}));

import { encryptAtRest, decryptAtRest, clearAtRestKey } from '../at-rest';

beforeEach(async () => {
  // crypto.getRandomValues polyfill for the key generation.
  (globalThis as any).crypto = { getRandomValues: (a: Uint8Array) => { a.fill(3); return a; } };
  await clearAtRestKey(); // reset both the in-memory key cache AND the store
  mockStore.clear();
});

describe('at-rest encryption', () => {
  it('round-trips a payload (encrypt then decrypt === original)', async () => {
    const plain = JSON.stringify({ content: 'hello agent', agent: 'claude' });
    const blob = await encryptAtRest(plain);
    expect(blob).not.toBe(plain);
    expect(blob.startsWith('sqar1.')).toBe(true); // versioned, tagged
    expect(await decryptAtRest(blob)).toBe(plain);
  });

  it('passes legacy untagged plaintext through unchanged (backward compat)', async () => {
    const legacy = '{"content":"old row written before encryption"}';
    expect(await decryptAtRest(legacy)).toBe(legacy); // no tag → no decrypt attempt
  });

  it('does not throw on a malformed tagged blob (returns it verbatim)', async () => {
    expect(await decryptAtRest('sqar1.onlyonepart')).toBe('sqar1.onlyonepart');
  });

  it('persists + reuses one device key across calls', async () => {
    await encryptAtRest('a');
    const keyAfterFirst = mockStore.get('styrby_atrest_key');
    expect(keyAfterFirst).toBeDefined();
    await encryptAtRest('b');
    expect(mockStore.get('styrby_atrest_key')).toBe(keyAfterFirst); // not regenerated
  });

  it('clearAtRestKey removes the device key', async () => {
    await encryptAtRest('x');
    expect(mockStore.get('styrby_atrest_key')).toBeDefined();
    await clearAtRestKey();
    expect(mockStore.get('styrby_atrest_key')).toBeUndefined();
  });
});
