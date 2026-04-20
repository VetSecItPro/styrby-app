/**
 * Tests for the Web Encryption Service.
 *
 * WHY these tests matter: The encryption module protects E2E confidentiality
 * of session messages. Bugs here could expose user conversations that cross
 * Supabase servers in plaintext, allow wrong-key decryption to silently
 * return garbage, or corrupt key storage in ways that permanently lock out
 * users. Every code path is exercised.
 *
 * Covers:
 * - getOrCreateWebKeyPair: in-memory cache hit, localStorage load, fresh
 *   generation, corrupted-storage recovery
 * - registerWebDevice: already-registered early return, missing auth user,
 *   machines upsert error, machine_keys upsert error, success path
 * - tryDecryptMessage: no content, plaintext (no nonce), no machineId,
 *   missing sender key, successful decrypt, wrong-key rejection
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { encryptForStorage, generateKeyPair } from '@styrby/shared';

// ============================================================================
// Mocks
// ============================================================================

const mockLocalStorage = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string): string | null => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => { store[key] = value; }),
    removeItem: vi.fn((key: string) => { delete store[key]; }),
    clear: () => { store = {}; },
  };
})();

// Attach fake localStorage to globalThis before any module imports
Object.defineProperty(globalThis, 'localStorage', { value: mockLocalStorage, writable: true });

const mockSupabaseFrom = vi.fn();
const mockGetUser = vi.fn();
const mockCreateClient = vi.fn();

vi.mock('@/lib/supabase/client', () => ({
  createClient: mockCreateClient,
}));

/**
 * Builds a chainable Supabase query stub for a table operation.
 * Resolves to { data, error } from .single(), or { error } from bare await.
 */
function buildChain(
  data: Record<string, unknown> | null = null,
  error: { message: string } | null = null
) {
  return {
    upsert: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data, error }),
  };
}

// ============================================================================
// Module reset helpers
// ============================================================================

/**
 * WHY resetModules: encryption.ts holds module-level cached state
 * (cachedKeyPair and senderKeyCache). Without resetting the module between
 * tests, cache hits from a previous test contaminate subsequent tests.
 */
async function freshEncryption() {
  vi.resetModules();
  return import('../encryption');
}

// ============================================================================
// Tests
// ============================================================================

describe('getOrCreateWebKeyPair()', () => {
  beforeEach(() => {
    mockLocalStorage.clear();
    mockLocalStorage.getItem.mockClear();
    mockLocalStorage.setItem.mockClear();
    mockLocalStorage.removeItem.mockClear();
  });

  it('generates a new keypair on first call and persists it to localStorage', async () => {
    const { getOrCreateWebKeyPair } = await freshEncryption();

    const keypair = await getOrCreateWebKeyPair();

    expect(keypair.publicKey).toBeInstanceOf(Uint8Array);
    expect(keypair.publicKey).toHaveLength(32);
    expect(keypair.secretKey).toBeInstanceOf(Uint8Array);
    expect(keypair.secretKey).toHaveLength(32);
    expect(mockLocalStorage.setItem).toHaveBeenCalledOnce();
  });

  it('returns the cached keypair on a second call without re-reading localStorage', async () => {
    const { getOrCreateWebKeyPair } = await freshEncryption();

    const first = await getOrCreateWebKeyPair();
    const second = await getOrCreateWebKeyPair();

    // Identity equality — same object reference due to cache
    expect(second).toBe(first);
    // localStorage.getItem called once on initial load, not again for cache hit
    expect(mockLocalStorage.getItem).toHaveBeenCalledOnce();
  });

  it('loads an existing keypair from localStorage instead of regenerating', async () => {
    // Pre-populate localStorage with a known keypair
    const original = await generateKeyPair();
    const { encodeBase64 } = await import('@styrby/shared');
    const stored = JSON.stringify({
      publicKey: await encodeBase64(original.publicKey),
      secretKey: await encodeBase64(original.secretKey),
    });
    mockLocalStorage.getItem.mockReturnValue(stored);

    const { getOrCreateWebKeyPair } = await freshEncryption();
    const keypair = await getOrCreateWebKeyPair();

    expect(keypair.publicKey).toEqual(original.publicKey);
    expect(keypair.secretKey).toEqual(original.secretKey);
    // No new keypair written — loaded from storage
    expect(mockLocalStorage.setItem).not.toHaveBeenCalled();
  });

  it('recovers from corrupted localStorage by regenerating and removing bad data', async () => {
    mockLocalStorage.getItem.mockReturnValue('NOT_VALID_JSON{{{{');

    const { getOrCreateWebKeyPair } = await freshEncryption();
    const keypair = await getOrCreateWebKeyPair();

    expect(keypair.publicKey).toHaveLength(32);
    expect(mockLocalStorage.removeItem).toHaveBeenCalledOnce();
    // New keypair persisted after recovery
    expect(mockLocalStorage.setItem).toHaveBeenCalledOnce();
  });
});

// ============================================================================

describe('registerWebDevice()', () => {
  beforeEach(() => {
    // WHY full reset: mockLocalStorage.getItem may have been overridden via
    // mockImplementation in a prior test. We must restore the default behaviour
    // (return null for any key) so the "not yet registered" code path is taken.
    mockLocalStorage.clear();
    mockLocalStorage.getItem.mockReset();
    mockLocalStorage.getItem.mockReturnValue(null);
    mockLocalStorage.setItem.mockReset();
    mockLocalStorage.removeItem.mockReset();
    vi.clearAllMocks();

    // Re-apply default client mock after vi.clearAllMocks()
    mockCreateClient.mockReturnValue({
      auth: { getUser: mockGetUser },
      from: mockSupabaseFrom,
    });
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-123' } } });
  });

  it('returns the existing machine ID immediately when already registered', async () => {
    mockLocalStorage.getItem.mockImplementation((key: string) => {
      if (key === 'styrby_web_machine_id') return 'existing-machine-id';
      return null;
    });

    const { registerWebDevice } = await freshEncryption();
    const id = await registerWebDevice();

    expect(id).toBe('existing-machine-id');
    expect(mockGetUser).not.toHaveBeenCalled();
  });

  it('returns null when no authenticated user is found', async () => {
    // Ensure machine ID is NOT in storage so we reach the auth check
    mockLocalStorage.getItem.mockReturnValue(null);
    mockGetUser.mockResolvedValue({ data: { user: null } });

    const { registerWebDevice } = await freshEncryption();
    const id = await registerWebDevice();

    expect(id).toBeNull();
  });

  it('returns null when the machines upsert fails', async () => {
    // Ensure machine ID is NOT in storage
    mockLocalStorage.getItem.mockReturnValue(null);

    const machineChain = buildChain(null, { message: 'FK violation' });
    mockSupabaseFrom.mockReturnValue(machineChain);

    const { registerWebDevice } = await freshEncryption();
    const id = await registerWebDevice();

    expect(id).toBeNull();
  });

  it('returns null when the machine_keys upsert fails', async () => {
    // Ensure machine ID is NOT in storage
    mockLocalStorage.getItem.mockReturnValue(null);

    let callCount = 0;
    mockSupabaseFrom.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // machines upsert succeeds
        return buildChain({ id: 'new-machine-id' });
      }
      // machine_keys upsert fails
      return {
        upsert: vi.fn().mockResolvedValue({ error: { message: 'key conflict' } }),
      };
    });

    const { registerWebDevice } = await freshEncryption();
    const id = await registerWebDevice();

    expect(id).toBeNull();
  });

  it('persists the machine ID to localStorage on success', async () => {
    // Ensure machine ID is NOT in storage
    mockLocalStorage.getItem.mockReturnValue(null);

    let callCount = 0;
    mockSupabaseFrom.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return buildChain({ id: 'success-machine-id' });
      }
      return {
        upsert: vi.fn().mockResolvedValue({ error: null }),
      };
    });

    const { registerWebDevice } = await freshEncryption();
    const id = await registerWebDevice();

    expect(id).toBe('success-machine-id');
    expect(mockLocalStorage.setItem).toHaveBeenCalledWith(
      'styrby_web_machine_id',
      'success-machine-id'
    );
  });
});

// ============================================================================

describe('tryDecryptMessage()', () => {
  beforeEach(() => {
    mockLocalStorage.clear();
    mockLocalStorage.getItem.mockClear();
    vi.clearAllMocks();

    mockCreateClient.mockReturnValue({
      from: mockSupabaseFrom,
    });
  });

  it('returns { content: null, wasEncrypted: false } when contentEncrypted is null', async () => {
    const { tryDecryptMessage } = await freshEncryption();
    const result = await tryDecryptMessage(null, null, null);

    expect(result).toEqual({ content: null, wasEncrypted: false });
  });

  it('returns the content as plaintext when there is no nonce (unencrypted message)', async () => {
    const { tryDecryptMessage } = await freshEncryption();
    const result = await tryDecryptMessage('hello world', null, 'machine-id');

    expect(result).toEqual({ content: 'hello world', wasEncrypted: false });
  });

  it('returns { content: null, wasEncrypted: true } when nonce exists but machineId is null', async () => {
    const { tryDecryptMessage } = await freshEncryption();
    const result = await tryDecryptMessage('encrypted-base64', 'nonce-base64', null);

    expect(result).toEqual({ content: null, wasEncrypted: true });
  });

  it('returns { content: null, wasEncrypted: true } when sender public key is not found', async () => {
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: null, error: null }),
    };
    mockSupabaseFrom.mockReturnValue(chain);

    const { tryDecryptMessage } = await freshEncryption();
    const result = await tryDecryptMessage('encrypted', 'nonce', 'unknown-machine');

    expect(result).toEqual({ content: null, wasEncrypted: true });
  });

  it('successfully decrypts a message encrypted with matching keys', async () => {
    // Generate two keypairs: sender (CLI) and recipient (web)
    const senderKeypair = await generateKeyPair();
    const recipientKeypair = await generateKeyPair();

    const plaintext = 'Secret session message from CLI';
    const { encrypted, nonce } = await encryptForStorage(
      plaintext,
      recipientKeypair.publicKey,
      senderKeypair.secretKey
    );

    // Set up the web device's keypair in localStorage
    const { encodeBase64 } = await import('@styrby/shared');
    const storedKeypair = JSON.stringify({
      publicKey: await encodeBase64(recipientKeypair.publicKey),
      secretKey: await encodeBase64(recipientKeypair.secretKey),
    });
    mockLocalStorage.getItem.mockImplementation((key: string) => {
      if (key === 'styrby_web_encryption_keypair') return storedKeypair;
      return null;
    });

    // Mock Supabase returning the sender's public key
    const senderPublicKeyBase64 = await encodeBase64(senderKeypair.publicKey);
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { public_key: senderPublicKeyBase64 }, error: null }),
    };
    mockSupabaseFrom.mockReturnValue(chain);

    const { tryDecryptMessage } = await freshEncryption();
    const result = await tryDecryptMessage(encrypted, nonce, 'cli-machine-id');

    expect(result.wasEncrypted).toBe(true);
    expect(result.content).toBe(plaintext);
  });

  it('returns { content: null, wasEncrypted: true } when decryption fails with wrong key', async () => {
    // Sender encrypts for a DIFFERENT recipient — we try to decrypt with our key
    const senderKeypair = await generateKeyPair();
    const intendedRecipient = await generateKeyPair(); // NOT our web key
    const ourKeypair = await generateKeyPair();        // The web device's actual key

    const { encrypted, nonce } = await encryptForStorage(
      'Private message',
      intendedRecipient.publicKey,  // Encrypted for someone else
      senderKeypair.secretKey
    );

    // Set up our (wrong) keypair in localStorage
    const { encodeBase64 } = await import('@styrby/shared');
    const storedKeypair = JSON.stringify({
      publicKey: await encodeBase64(ourKeypair.publicKey),
      secretKey: await encodeBase64(ourKeypair.secretKey),
    });
    mockLocalStorage.getItem.mockImplementation((key: string) => {
      if (key === 'styrby_web_encryption_keypair') return storedKeypair;
      return null;
    });

    const senderPublicKeyBase64 = await encodeBase64(senderKeypair.publicKey);
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { public_key: senderPublicKeyBase64 }, error: null }),
    };
    mockSupabaseFrom.mockReturnValue(chain);

    const { tryDecryptMessage } = await freshEncryption();
    const result = await tryDecryptMessage(encrypted, nonce, 'cli-machine-id');

    // Must not succeed — message was encrypted for a different device
    expect(result.wasEncrypted).toBe(true);
    expect(result.content).toBeNull();
  });

  it('caches the sender public key so Supabase is only queried once per machineId', async () => {
    const senderKeypair = await generateKeyPair();
    const recipientKeypair = await generateKeyPair();

    const { encodeBase64 } = await import('@styrby/shared');
    const storedKeypair = JSON.stringify({
      publicKey: await encodeBase64(recipientKeypair.publicKey),
      secretKey: await encodeBase64(recipientKeypair.secretKey),
    });
    mockLocalStorage.getItem.mockReturnValue(storedKeypair);

    const senderPublicKeyBase64 = await encodeBase64(senderKeypair.publicKey);
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { public_key: senderPublicKeyBase64 }, error: null }),
    };
    mockSupabaseFrom.mockReturnValue(chain);

    const { tryDecryptMessage } = await freshEncryption();

    const { encrypted: e1, nonce: n1 } = await encryptForStorage(
      'msg1',
      recipientKeypair.publicKey,
      senderKeypair.secretKey
    );
    const { encrypted: e2, nonce: n2 } = await encryptForStorage(
      'msg2',
      recipientKeypair.publicKey,
      senderKeypair.secretKey
    );

    await tryDecryptMessage(e1, n1, 'same-machine');
    await tryDecryptMessage(e2, n2, 'same-machine');

    // Supabase should only have been queried once (second call hits cache)
    expect(chain.single).toHaveBeenCalledOnce();
  });
});
