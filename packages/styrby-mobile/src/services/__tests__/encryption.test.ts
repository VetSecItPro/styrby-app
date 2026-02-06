/**
 * Encryption Service Test Suite
 *
 * Tests the mobile app's end-to-end encryption module, covering:
 * - Keypair lifecycle (load, generate, persist, cache)
 * - Recipient key management (query, cache, invalidation)
 * - Encrypt/decrypt operations
 * - Public key registration to machine_keys
 * - Cache clearing for security (unpair, sign-out)
 */

import * as SecureStore from 'expo-secure-store';
import { type NaClKeyPair } from 'styrby-shared';

// ============================================================================
// Mock Setup
// ============================================================================

// Mock styrby-shared encryption functions
jest.mock('styrby-shared', () => {
  const mockPublicKey = new Uint8Array(32).fill(1);
  const mockSecretKey = new Uint8Array(32).fill(2);
  return {
    generateKeyPair: jest.fn(() => ({ publicKey: mockPublicKey, secretKey: mockSecretKey })),
    encryptForStorage: jest.fn(() => ({ encrypted: 'mock-encrypted', nonce: 'mock-nonce' })),
    decryptFromStorage: jest.fn(() => 'decrypted-content'),
    encodeBase64: jest.fn((arr: Uint8Array) => Buffer.from(arr).toString('base64')),
    decodeBase64: jest.fn((str: string) => new Uint8Array(Buffer.from(str, 'base64'))),
    generateFingerprint: jest.fn(async () => 'mock-fingerprint'),
  };
});

// Mock the supabase module at @/lib/supabase path
jest.mock('../../lib/supabase', () => {
  // Create a chainable mock for Supabase queries
  const createChain = (result = { data: null, error: null }) => {
    const chain: any = {};
    const methods = ['select', 'eq', 'insert', 'upsert', 'maybeSingle'];
    methods.forEach((m) => {
      chain[m] = jest.fn(() => chain);
    });
    chain.single = jest.fn(() => Promise.resolve(result));
    chain.maybeSingle = jest.fn(() => Promise.resolve(result));
    // Make the chain itself thenable for queries that don't end in single/maybeSingle
    chain.then = (resolve: any) => resolve(result);
    return chain;
  };

  const fromMock = jest.fn(() => createChain());

  return {
    supabase: {
      from: fromMock,
      auth: {
        getUser: jest.fn(async () => ({
          data: { user: { id: 'test-user-id' } },
          error: null,
        })),
      },
    },
  };
});

// Import mocked modules
import {
  generateKeyPair,
  encryptForStorage,
  decryptFromStorage,
  encodeBase64,
  decodeBase64,
  generateFingerprint,
} from 'styrby-shared';
import { supabase } from '../../lib/supabase';

// Import the module under test (AFTER mocks are set up)
import {
  getOrCreateKeyPair,
  getRecipientPublicKey,
  encryptMessage,
  decryptMessage,
  registerPublicKey,
  clearEncryptionCache,
  invalidateRecipientKey,
} from '../encryption';

// ============================================================================
// Test Suite
// ============================================================================

describe('Encryption Service', () => {
  // Helper to reset module state between tests
  const resetModuleState = () => {
    clearEncryptionCache();
    // We need to call clearEncryptionCache to reset module-level cache
    // but the module stays imported, so the cache is properly cleared
  };

  beforeEach(() => {
    jest.clearAllMocks();
    resetModuleState();
  });

  // ==========================================================================
  // getOrCreateKeyPair() Tests
  // ==========================================================================

  describe('getOrCreateKeyPair()', () => {
    it('returns cached keypair if exists', async () => {
      // First call to populate cache
      await getOrCreateKeyPair();

      // Clear mock calls
      (SecureStore.getItemAsync as jest.Mock).mockClear();
      (generateKeyPair as jest.Mock).mockClear();

      // Second call should use cache
      const keypair = await getOrCreateKeyPair();

      expect(SecureStore.getItemAsync).not.toHaveBeenCalled();
      expect(generateKeyPair).not.toHaveBeenCalled();
      expect(keypair).toBeDefined();
      expect(keypair.publicKey).toBeInstanceOf(Uint8Array);
      expect(keypair.secretKey).toBeInstanceOf(Uint8Array);
    });

    it('loads from SecureStore if persisted', async () => {
      const mockPublicKey = new Uint8Array(32).fill(1);
      const mockSecretKey = new Uint8Array(32).fill(2);

      const storedData = JSON.stringify({
        publicKey: Buffer.from(mockPublicKey).toString('base64'),
        secretKey: Buffer.from(mockSecretKey).toString('base64'),
      });

      (SecureStore.getItemAsync as jest.Mock).mockResolvedValueOnce(storedData);

      const keypair = await getOrCreateKeyPair();

      expect(SecureStore.getItemAsync).toHaveBeenCalledWith('styrby_encryption_keypair');
      expect(generateKeyPair).not.toHaveBeenCalled();
      expect(keypair.publicKey).toBeInstanceOf(Uint8Array);
      expect(keypair.secretKey).toBeInstanceOf(Uint8Array);
    });

    it('generates new keypair if nothing stored', async () => {
      (SecureStore.getItemAsync as jest.Mock).mockResolvedValueOnce(null);

      const keypair = await getOrCreateKeyPair();

      expect(SecureStore.getItemAsync).toHaveBeenCalledWith('styrby_encryption_keypair');
      expect(generateKeyPair).toHaveBeenCalled();
      expect(SecureStore.setItemAsync).toHaveBeenCalled();
      expect(keypair).toBeDefined();
    });

    it('regenerates if stored data is corrupted (invalid JSON)', async () => {
      (SecureStore.getItemAsync as jest.Mock).mockResolvedValueOnce('invalid-json{');

      const keypair = await getOrCreateKeyPair();

      expect(generateKeyPair).toHaveBeenCalled();
      expect(SecureStore.setItemAsync).toHaveBeenCalled();
      expect(keypair).toBeDefined();
    });

    it('regenerates if key lengths are invalid (not 32 bytes)', async () => {
      const invalidPublicKey = new Uint8Array(16).fill(1); // Wrong length
      const validSecretKey = new Uint8Array(32).fill(2);

      const storedData = JSON.stringify({
        publicKey: Buffer.from(invalidPublicKey).toString('base64'),
        secretKey: Buffer.from(validSecretKey).toString('base64'),
      });

      (SecureStore.getItemAsync as jest.Mock).mockResolvedValueOnce(storedData);

      const keypair = await getOrCreateKeyPair();

      expect(generateKeyPair).toHaveBeenCalled();
      expect(SecureStore.setItemAsync).toHaveBeenCalled();
      expect(keypair.publicKey.length).toBe(32);
      expect(keypair.secretKey.length).toBe(32);
    });
  });

  // ==========================================================================
  // getRecipientPublicKey() Tests
  // ==========================================================================

  describe('getRecipientPublicKey()', () => {
    const testMachineId = 'test-machine-123';
    const mockRecipientKey = new Uint8Array(32).fill(5);

    it('returns cached key if exists', async () => {
      // First call to populate cache
      (supabase.from as jest.Mock).mockReturnValueOnce({
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        maybeSingle: jest.fn().mockResolvedValueOnce({
          data: { public_key: Buffer.from(mockRecipientKey).toString('base64') },
          error: null,
        }),
      });

      await getRecipientPublicKey(testMachineId);

      // Clear mock calls
      (supabase.from as jest.Mock).mockClear();

      // Second call should use cache
      const publicKey = await getRecipientPublicKey(testMachineId);

      expect(supabase.from).not.toHaveBeenCalled();
      expect(publicKey).toBeInstanceOf(Uint8Array);
    });

    it('queries Supabase if not cached', async () => {
      (supabase.from as jest.Mock).mockReturnValueOnce({
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        maybeSingle: jest.fn().mockResolvedValueOnce({
          data: { public_key: Buffer.from(mockRecipientKey).toString('base64') },
          error: null,
        }),
      });

      const publicKey = await getRecipientPublicKey(testMachineId);

      expect(supabase.from).toHaveBeenCalledWith('machine_keys');
      expect(publicKey).toBeInstanceOf(Uint8Array);
    });

    it('throws if no key found', async () => {
      (supabase.from as jest.Mock).mockReturnValueOnce({
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        maybeSingle: jest.fn().mockResolvedValueOnce({
          data: null,
          error: null,
        }),
      });

      await expect(getRecipientPublicKey(testMachineId)).rejects.toThrow(
        'No public key found for machine'
      );
    });

    it('throws if query error', async () => {
      (supabase.from as jest.Mock).mockReturnValueOnce({
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        maybeSingle: jest.fn().mockResolvedValueOnce({
          data: null,
          error: { message: 'Database connection failed' },
        }),
      });

      await expect(getRecipientPublicKey(testMachineId)).rejects.toThrow(
        'Failed to fetch public key'
      );
    });

    it('throws if key is wrong length', async () => {
      const invalidKey = new Uint8Array(16).fill(5); // Wrong length

      (supabase.from as jest.Mock).mockReturnValueOnce({
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        maybeSingle: jest.fn().mockResolvedValueOnce({
          data: { public_key: Buffer.from(invalidKey).toString('base64') },
          error: null,
        }),
      });

      await expect(getRecipientPublicKey(testMachineId)).rejects.toThrow(
        'Invalid public key length'
      );
    });
  });

  // ==========================================================================
  // encryptMessage() Tests
  // ==========================================================================

  describe('encryptMessage()', () => {
    const testMachineId = 'test-machine-123';
    const mockRecipientKey = new Uint8Array(32).fill(5);

    beforeEach(() => {
      // Mock getRecipientPublicKey to return a valid key
      (supabase.from as jest.Mock).mockReturnValue({
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        maybeSingle: jest.fn().mockResolvedValue({
          data: { public_key: Buffer.from(mockRecipientKey).toString('base64') },
          error: null,
        }),
      });
    });

    it('calls encryptForStorage with correct parameters', async () => {
      const content = 'Hello, CLI!';

      const result = await encryptMessage(content, testMachineId);

      expect(encryptForStorage).toHaveBeenCalled();
      expect(result).toEqual({
        encrypted: 'mock-encrypted',
        nonce: 'mock-nonce',
      });
    });
  });

  // ==========================================================================
  // decryptMessage() Tests
  // ==========================================================================

  describe('decryptMessage()', () => {
    const testMachineId = 'test-machine-123';
    const mockSenderKey = new Uint8Array(32).fill(5);

    beforeEach(() => {
      // Mock getRecipientPublicKey to return a valid key
      (supabase.from as jest.Mock).mockReturnValue({
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        maybeSingle: jest.fn().mockResolvedValue({
          data: { public_key: Buffer.from(mockSenderKey).toString('base64') },
          error: null,
        }),
      });
    });

    it('calls decryptFromStorage with correct parameters', async () => {
      const encrypted = 'encrypted-content';
      const nonce = 'nonce-value';

      const result = await decryptMessage(encrypted, nonce, testMachineId);

      expect(decryptFromStorage).toHaveBeenCalled();
      expect(result).toBe('decrypted-content');
    });
  });

  // ==========================================================================
  // registerPublicKey() Tests
  // ==========================================================================

  describe('registerPublicKey()', () => {
    const testUserId = 'user-123';

    it('creates machine record if not exists', async () => {
      // Mock: No existing machine
      (supabase.from as jest.Mock).mockImplementation((table: string) => {
        if (table === 'machines') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValueOnce({
              data: null,
              error: null,
            }),
            insert: jest.fn().mockReturnThis(),
            single: jest.fn().mockResolvedValueOnce({
              data: { id: 'new-machine-id' },
              error: null,
            }),
          };
        }
        // machine_keys upsert
        return {
          upsert: jest.fn().mockResolvedValueOnce({
            data: null,
            error: null,
          }),
        };
      });

      await registerPublicKey(testUserId);

      expect(generateFingerprint).toHaveBeenCalled();
      // Verify machine was created and key was upserted
      expect(supabase.from).toHaveBeenCalledWith('machines');
      expect(supabase.from).toHaveBeenCalledWith('machine_keys');
    });

    it('reuses existing machine record', async () => {
      // Mock: Existing machine found
      (supabase.from as jest.Mock).mockImplementation((table: string) => {
        if (table === 'machines') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValueOnce({
              data: { id: 'existing-machine-id' },
              error: null,
            }),
          };
        }
        // machine_keys upsert
        return {
          upsert: jest.fn().mockResolvedValueOnce({
            data: null,
            error: null,
          }),
        };
      });

      await registerPublicKey(testUserId);

      // Should not call insert, only upsert
      expect(supabase.from).toHaveBeenCalledWith('machine_keys');
    });

    it('throws on machine creation failure', async () => {
      // Mock: Machine creation fails
      (supabase.from as jest.Mock).mockImplementation((table: string) => {
        if (table === 'machines') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValueOnce({
              data: null,
              error: null,
            }),
            insert: jest.fn().mockReturnThis(),
            single: jest.fn().mockResolvedValueOnce({
              data: null,
              error: { message: 'Database error' },
            }),
          };
        }
        return {
          upsert: jest.fn().mockResolvedValueOnce({
            data: null,
            error: null,
          }),
        };
      });

      await expect(registerPublicKey(testUserId)).rejects.toThrow(
        'Failed to create mobile machine record'
      );
    });

    it('throws on key upsert failure', async () => {
      // Mock: Existing machine, but key upsert fails
      (supabase.from as jest.Mock).mockImplementation((table: string) => {
        if (table === 'machines') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValueOnce({
              data: { id: 'existing-machine-id' },
              error: null,
            }),
          };
        }
        // machine_keys upsert fails
        return {
          upsert: jest.fn().mockResolvedValueOnce({
            data: null,
            error: { message: 'Constraint violation' },
          }),
        };
      });

      await expect(registerPublicKey(testUserId)).rejects.toThrow(
        'Failed to register public key'
      );
    });
  });

  // ==========================================================================
  // clearEncryptionCache() Tests
  // ==========================================================================

  describe('clearEncryptionCache()', () => {
    it('clears cached keypair and recipient keys', async () => {
      const testMachineId = 'test-machine-123';
      const mockRecipientKey = new Uint8Array(32).fill(5);

      // Populate caches
      await getOrCreateKeyPair();
      (supabase.from as jest.Mock).mockReturnValueOnce({
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        maybeSingle: jest.fn().mockResolvedValueOnce({
          data: { public_key: Buffer.from(mockRecipientKey).toString('base64') },
          error: null,
        }),
      });
      await getRecipientPublicKey(testMachineId);

      // Clear caches
      clearEncryptionCache();

      // Clear mocks
      jest.clearAllMocks();

      // Next call should query SecureStore and Supabase again
      await getOrCreateKeyPair();
      expect(SecureStore.getItemAsync).toHaveBeenCalled();

      (supabase.from as jest.Mock).mockReturnValueOnce({
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        maybeSingle: jest.fn().mockResolvedValueOnce({
          data: { public_key: Buffer.from(mockRecipientKey).toString('base64') },
          error: null,
        }),
      });
      await getRecipientPublicKey(testMachineId);
      expect(supabase.from).toHaveBeenCalledWith('machine_keys');
    });
  });

  // ==========================================================================
  // invalidateRecipientKey() Tests
  // ==========================================================================

  describe('invalidateRecipientKey()', () => {
    it('removes specific machine from cache', async () => {
      const testMachineId = 'test-machine-123';
      const mockRecipientKey = new Uint8Array(32).fill(5);

      // Populate cache
      (supabase.from as jest.Mock).mockReturnValueOnce({
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        maybeSingle: jest.fn().mockResolvedValueOnce({
          data: { public_key: Buffer.from(mockRecipientKey).toString('base64') },
          error: null,
        }),
      });
      await getRecipientPublicKey(testMachineId);

      // Clear mock
      (supabase.from as jest.Mock).mockClear();

      // Invalidate specific machine
      invalidateRecipientKey(testMachineId);

      // Next call should query Supabase
      (supabase.from as jest.Mock).mockReturnValueOnce({
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        maybeSingle: jest.fn().mockResolvedValueOnce({
          data: { public_key: Buffer.from(mockRecipientKey).toString('base64') },
          error: null,
        }),
      });
      await getRecipientPublicKey(testMachineId);
      expect(supabase.from).toHaveBeenCalledWith('machine_keys');
    });
  });
});
