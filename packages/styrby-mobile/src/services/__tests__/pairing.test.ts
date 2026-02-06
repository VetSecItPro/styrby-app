/**
 * Tests for the pairing service module.
 *
 * Tests the complete device pairing flow including QR code validation,
 * user authentication checks, secure storage, key exchange, and push
 * notification registration.
 */

import * as SecureStore from 'expo-secure-store';
import {
  executePairing,
  getStoredPairingInfo,
  isPaired,
  clearPairingInfo,
  getStoredPairingToken,
  type StoredPairingInfo,
} from '../pairing';
import {
  type PairingPayload,
  decodePairingUrl,
  validatePairingPayload,
  isPairingExpired,
} from 'styrby-shared';
import { supabase } from '../../lib/supabase';
import {
  registerPublicKey,
  getRecipientPublicKey,
  clearEncryptionCache,
} from '../encryption';
import {
  registerForPushNotifications,
  savePushToken,
} from '../notifications';

// ============================================================================
// Mocks
// ============================================================================

jest.mock('styrby-shared', () => ({
  decodePairingUrl: jest.fn(),
  validatePairingPayload: jest.fn(),
  isPairingExpired: jest.fn(),
}));

jest.mock('../encryption', () => ({
  registerPublicKey: jest.fn(async () => {}),
  getRecipientPublicKey: jest.fn(async () => new Uint8Array(32)),
  clearEncryptionCache: jest.fn(),
}));

jest.mock('../notifications', () => ({
  registerForPushNotifications: jest.fn(async () => 'mock-push-token'),
  savePushToken: jest.fn(async () => true),
}));

jest.mock('../../lib/supabase', () => ({
  supabase: {
    auth: {
      getUser: jest.fn(async () => ({
        data: { user: { id: 'test-user-id' } },
        error: null,
      })),
    },
  },
}));

// ============================================================================
// Type assertions for mocked functions
// ============================================================================

const mockDecodePairingUrl = decodePairingUrl as jest.MockedFunction<typeof decodePairingUrl>;
const mockValidatePairingPayload = validatePairingPayload as jest.MockedFunction<typeof validatePairingPayload>;
const mockIsPairingExpired = isPairingExpired as jest.MockedFunction<typeof isPairingExpired>;
const mockGetUser = supabase.auth.getUser as jest.MockedFunction<typeof supabase.auth.getUser>;
const mockRegisterPublicKey = registerPublicKey as jest.MockedFunction<typeof registerPublicKey>;
const mockGetRecipientPublicKey = getRecipientPublicKey as jest.MockedFunction<typeof getRecipientPublicKey>;
const mockClearEncryptionCache = clearEncryptionCache as jest.MockedFunction<typeof clearEncryptionCache>;
const mockRegisterForPushNotifications = registerForPushNotifications as jest.MockedFunction<typeof registerForPushNotifications>;
const mockSavePushToken = savePushToken as jest.MockedFunction<typeof savePushToken>;

// ============================================================================
// Test Data
// ============================================================================

const validPayload: PairingPayload = {
  version: 1,
  userId: 'test-user-id',
  machineId: 'test-machine-id',
  deviceName: 'Test-MacBook',
  supabaseUrl: 'https://test.supabase.co',
  token: 'test-pairing-token',
  expiresAt: new Date(Date.now() + 300000).toISOString(),
};

// ============================================================================
// Tests
// ============================================================================

describe('pairing service', () => {
  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();

    // WHY global helper: jest.setup.js exposes __resetSecureStore to clear
    // the internal mockSecureStoreData Map. The mock doesn't expose __store__.
    (global as any).__resetSecureStore();

    // Set default mock implementations (success path)
    mockDecodePairingUrl.mockReturnValue(validPayload);
    mockValidatePairingPayload.mockReturnValue(true);
    mockIsPairingExpired.mockReturnValue(false);
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'test-user-id' } },
      error: null,
    } as any);
    mockRegisterPublicKey.mockResolvedValue();
    mockGetRecipientPublicKey.mockResolvedValue(new Uint8Array(32));
    mockRegisterForPushNotifications.mockResolvedValue('mock-push-token');
    mockSavePushToken.mockResolvedValue(true);
  });

  // ==========================================================================
  // executePairing() Tests
  // ==========================================================================

  describe('executePairing()', () => {
    it('should return INVALID_QR if decodePairingUrl returns null', async () => {
      mockDecodePairingUrl.mockReturnValue(null);

      const result = await executePairing('invalid-qr-data');

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('INVALID_QR');
      expect(result.error).toContain('Invalid QR code');
      expect(mockDecodePairingUrl).toHaveBeenCalledWith('invalid-qr-data');
      expect(mockValidatePairingPayload).not.toHaveBeenCalled();
    });

    it('should return INVALID_PAYLOAD if validatePairingPayload returns false', async () => {
      mockValidatePairingPayload.mockReturnValue(false);

      const result = await executePairing('styrby://pair?data=...');

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('INVALID_PAYLOAD');
      expect(result.error).toContain('Unrecognized QR code format');
      expect(mockValidatePairingPayload).toHaveBeenCalledWith(validPayload);
      expect(mockIsPairingExpired).not.toHaveBeenCalled();
    });

    it('should return EXPIRED_QR if isPairingExpired returns true', async () => {
      mockIsPairingExpired.mockReturnValue(true);

      const result = await executePairing('styrby://pair?data=...');

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('EXPIRED_QR');
      expect(result.error).toContain('QR code has expired');
      expect(mockIsPairingExpired).toHaveBeenCalledWith(validPayload);
      expect(mockGetUser).not.toHaveBeenCalled();
    });

    it('should return NOT_AUTHENTICATED if no user is logged in', async () => {
      mockGetUser.mockResolvedValue({
        data: { user: null },
        error: null,
      } as any);

      const result = await executePairing('styrby://pair?data=...');

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('NOT_AUTHENTICATED');
      expect(result.error).toContain('need to be logged in');
      expect(mockGetUser).toHaveBeenCalled();
    });

    it('should return NOT_AUTHENTICATED if auth returns an error', async () => {
      mockGetUser.mockResolvedValue({
        data: { user: null },
        error: { message: 'Auth failed' } as any,
      } as any);

      const result = await executePairing('styrby://pair?data=...');

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('NOT_AUTHENTICATED');
    });

    it('should return USER_MISMATCH if QR userId does not match authenticated user', async () => {
      mockGetUser.mockResolvedValue({
        data: { user: { id: 'different-user-id' } },
        error: null,
      } as any);

      const result = await executePairing('styrby://pair?data=...');

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('USER_MISMATCH');
      expect(result.error).toContain('different account');
    });

    it('should return STORAGE_FAILED if SecureStore.setItemAsync throws', async () => {
      const mockSetItemAsync = SecureStore.setItemAsync as jest.MockedFunction<typeof SecureStore.setItemAsync>;
      // WHY mockRejectedValueOnce: Using mockRejectedValue persists across tests
      // even after jest.clearAllMocks(). Once resets after a single call.
      mockSetItemAsync.mockRejectedValueOnce(new Error('Storage error'));

      const result = await executePairing('styrby://pair?data=...');

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('STORAGE_FAILED');
      expect(result.error).toContain('Failed to save pairing data');
    });

    it('should successfully pair and store info on happy path', async () => {
      const result = await executePairing('styrby://pair?data=...');

      expect(result.success).toBe(true);
      expect(result.errorCode).toBeUndefined();
      expect(result.error).toBeUndefined();
      expect(result.pairingInfo).toBeDefined();
      expect(result.pairingInfo?.userId).toBe('test-user-id');
      expect(result.pairingInfo?.machineId).toBe('test-machine-id');
      expect(result.pairingInfo?.deviceName).toBe('Test-MacBook');
      expect(result.pairingInfo?.supabaseUrl).toBe('https://test.supabase.co');
      expect(result.pairingInfo?.pairedAt).toBeDefined();

      // Verify storage calls
      const stored = await SecureStore.getItemAsync('styrby_pairing_info');
      expect(stored).toBeDefined();
      const parsed = JSON.parse(stored!);
      expect(parsed.userId).toBe('test-user-id');

      const storedToken = await SecureStore.getItemAsync('styrby_pairing_token');
      expect(storedToken).toBe('test-pairing-token');
    });

    it('should call registerPublicKey and getRecipientPublicKey for key exchange', async () => {
      await executePairing('styrby://pair?data=...');

      expect(mockRegisterPublicKey).toHaveBeenCalledWith('test-user-id');
      expect(mockGetRecipientPublicKey).toHaveBeenCalledWith('test-machine-id');
    });

    it('should succeed even if key exchange fails (non-fatal)', async () => {
      mockRegisterPublicKey.mockRejectedValue(new Error('Key exchange failed'));

      const result = await executePairing('styrby://pair?data=...');

      expect(result.success).toBe(true);
      expect(result.pairingInfo).toBeDefined();
      expect(mockRegisterPublicKey).toHaveBeenCalled();
    });

    it('should call push notification registration (fire-and-forget)', async () => {
      await executePairing('styrby://pair?data=...');

      // Wait for async fire-and-forget to complete
      await new Promise(resolve => setImmediate(resolve));

      expect(mockRegisterForPushNotifications).toHaveBeenCalled();
      expect(mockSavePushToken).toHaveBeenCalledWith('mock-push-token');
    });

    it('should succeed even if push notification registration fails', async () => {
      mockRegisterForPushNotifications.mockRejectedValue(new Error('Push failed'));

      const result = await executePairing('styrby://pair?data=...');

      expect(result.success).toBe(true);
      expect(result.pairingInfo).toBeDefined();
    });
  });

  // ==========================================================================
  // getStoredPairingInfo() Tests
  // ==========================================================================

  describe('getStoredPairingInfo()', () => {
    it('should return null if nothing is stored', async () => {
      const result = await getStoredPairingInfo();

      expect(result).toBeNull();
    });

    it('should return parsed pairing info if stored', async () => {
      const pairingInfo: StoredPairingInfo = {
        userId: 'test-user-id',
        machineId: 'test-machine-id',
        deviceName: 'Test-MacBook',
        supabaseUrl: 'https://test.supabase.co',
        pairedAt: new Date().toISOString(),
      };

      await SecureStore.setItemAsync('styrby_pairing_info', JSON.stringify(pairingInfo));

      const result = await getStoredPairingInfo();

      expect(result).toEqual(pairingInfo);
    });

    it('should return null if stored data is invalid JSON', async () => {
      await SecureStore.setItemAsync('styrby_pairing_info', 'invalid-json{');

      const result = await getStoredPairingInfo();

      expect(result).toBeNull();
    });
  });

  // ==========================================================================
  // isPaired() Tests
  // ==========================================================================

  describe('isPaired()', () => {
    it('should return false if no pairing info is stored', async () => {
      const result = await isPaired();

      expect(result).toBe(false);
    });

    it('should return true if pairing info exists', async () => {
      const pairingInfo: StoredPairingInfo = {
        userId: 'test-user-id',
        machineId: 'test-machine-id',
        deviceName: 'Test-MacBook',
        supabaseUrl: 'https://test.supabase.co',
        pairedAt: new Date().toISOString(),
      };

      await SecureStore.setItemAsync('styrby_pairing_info', JSON.stringify(pairingInfo));

      const result = await isPaired();

      expect(result).toBe(true);
    });
  });

  // ==========================================================================
  // clearPairingInfo() Tests
  // ==========================================================================

  describe('clearPairingInfo()', () => {
    it('should clear both storage keys and call clearEncryptionCache', async () => {
      // Store some data first
      await SecureStore.setItemAsync('styrby_pairing_info', JSON.stringify(validPayload));
      await SecureStore.setItemAsync('styrby_pairing_token', 'test-token');

      await clearPairingInfo();

      // Verify storage is cleared
      const info = await SecureStore.getItemAsync('styrby_pairing_info');
      const token = await SecureStore.getItemAsync('styrby_pairing_token');

      expect(info).toBeNull();
      expect(token).toBeNull();
      expect(mockClearEncryptionCache).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // getStoredPairingToken() Tests
  // ==========================================================================

  describe('getStoredPairingToken()', () => {
    it('should return null if no token is stored', async () => {
      const result = await getStoredPairingToken();

      expect(result).toBeNull();
    });

    it('should return the stored token', async () => {
      await SecureStore.setItemAsync('styrby_pairing_token', 'test-token-123');

      const result = await getStoredPairingToken();

      expect(result).toBe('test-token-123');
    });

    it('should return null if SecureStore.getItemAsync throws', async () => {
      const mockGetItemAsync = SecureStore.getItemAsync as jest.MockedFunction<typeof SecureStore.getItemAsync>;
      // WHY mockRejectedValueOnce: Prevents mock state leak to subsequent tests
      mockGetItemAsync.mockRejectedValueOnce(new Error('Storage error'));

      const result = await getStoredPairingToken();

      expect(result).toBeNull();
    });
  });
});
