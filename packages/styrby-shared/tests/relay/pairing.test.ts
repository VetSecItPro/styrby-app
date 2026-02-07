/**
 * Tests for the Styrby Pairing Flow Module
 *
 * Validates QR code-based pairing between CLI and mobile app, including
 * token generation, payload creation, URL encoding/decoding,
 * expiration checks, payload validation, and token hashing.
 *
 * Note: Uses Web Crypto API (crypto.subtle, crypto.getRandomValues)
 * which is available in Node.js 20+ and vitest environments.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  generatePairingToken,
  hashPairingToken,
  createPairingPayload,
  encodePairingUrl,
  decodePairingUrl,
  isPairingExpired,
  validatePairingPayload,
  PAIRING_EXPIRY_MINUTES,
  PAIRING_TOKEN_EXPIRY_MS,
  PAIRING_SCHEME,
} from '../../src/relay/pairing';

describe('Pairing Module', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // generatePairingToken()
  // ==========================================================================

  describe('generatePairingToken()', () => {
    it('returns a non-empty string', () => {
      const token = generatePairingToken();
      expect(typeof token).toBe('string');
      expect(token.length).toBeGreaterThan(0);
    });

    it('returns a base64url-encoded string (no +, /, or = characters)', () => {
      const token = generatePairingToken();
      // base64url uses - instead of + and _ instead of /
      // and strips trailing = padding
      expect(token).not.toContain('+');
      expect(token).not.toContain('/');
      expect(token).not.toContain('=');
      // Should only contain alphanumeric, dash, and underscore
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('returns unique tokens on each call', () => {
      const tokens = new Set<string>();
      for (let i = 0; i < 20; i++) {
        tokens.add(generatePairingToken());
      }
      expect(tokens.size).toBe(20);
    });

    it('returns a token of consistent length from 32 random bytes', () => {
      // 32 bytes -> 44 base64 chars -> 43 base64url chars (no padding)
      const token = generatePairingToken();
      // base64url of 32 bytes is always 43 chars (44 minus trailing =)
      expect(token.length).toBe(43);
    });
  });

  // ==========================================================================
  // createPairingPayload()
  // ==========================================================================

  describe('createPairingPayload()', () => {
    it('creates a valid payload with version 1', () => {
      const payload = createPairingPayload(
        'test-token',
        'user-123',
        'machine-456',
        'My MacBook',
        'https://example.supabase.co'
      );

      expect(payload.version).toBe(1);
    });

    it('includes all provided fields', () => {
      const payload = createPairingPayload(
        'test-token',
        'user-123',
        'machine-456',
        'My MacBook',
        'https://example.supabase.co',
        'claude'
      );

      expect(payload.token).toBe('test-token');
      expect(payload.userId).toBe('user-123');
      expect(payload.machineId).toBe('machine-456');
      expect(payload.deviceName).toBe('My MacBook');
      expect(payload.supabaseUrl).toBe('https://example.supabase.co');
      expect(payload.activeAgent).toBe('claude');
    });

    it('sets activeAgent as undefined when not provided', () => {
      const payload = createPairingPayload(
        'test-token',
        'user-123',
        'machine-456',
        'My MacBook',
        'https://example.supabase.co'
      );

      expect(payload.activeAgent).toBeUndefined();
    });

    it('sets expiresAt to 5 minutes in the future', () => {
      const before = Date.now();
      const payload = createPairingPayload(
        'test-token',
        'user-123',
        'machine-456',
        'My MacBook',
        'https://example.supabase.co'
      );
      const after = Date.now();

      const expiresAt = new Date(payload.expiresAt).getTime();
      // Should be ~5 minutes from now
      expect(expiresAt).toBeGreaterThanOrEqual(before + PAIRING_TOKEN_EXPIRY_MS);
      expect(expiresAt).toBeLessThanOrEqual(after + PAIRING_TOKEN_EXPIRY_MS);
    });

    it('returns a valid ISO timestamp for expiresAt', () => {
      const payload = createPairingPayload(
        'test-token',
        'user-123',
        'machine-456',
        'My MacBook',
        'https://example.supabase.co'
      );

      const parsed = new Date(payload.expiresAt);
      expect(parsed.toISOString()).toBe(payload.expiresAt);
    });
  });

  // ==========================================================================
  // encodePairingUrl() + decodePairingUrl() Round-Trip
  // ==========================================================================

  describe('encodePairingUrl() + decodePairingUrl() round-trip', () => {
    it('encodes and decodes a full payload', () => {
      const payload = createPairingPayload(
        'test-token-abc123',
        'user-id-456',
        'machine-id-789',
        'Test MacBook Pro',
        'https://test.supabase.co',
        'claude'
      );

      const url = encodePairingUrl(payload);
      const decoded = decodePairingUrl(url);

      expect(decoded).not.toBeNull();
      expect(decoded!.version).toBe(payload.version);
      expect(decoded!.token).toBe(payload.token);
      expect(decoded!.userId).toBe(payload.userId);
      expect(decoded!.machineId).toBe(payload.machineId);
      expect(decoded!.deviceName).toBe(payload.deviceName);
      expect(decoded!.supabaseUrl).toBe(payload.supabaseUrl);
      expect(decoded!.activeAgent).toBe(payload.activeAgent);
      expect(decoded!.expiresAt).toBe(payload.expiresAt);
    });

    it('creates a URL starting with styrby://pair', () => {
      const payload = createPairingPayload(
        'token',
        'user',
        'machine',
        'device',
        'https://test.supabase.co'
      );

      const url = encodePairingUrl(payload);
      expect(url.startsWith('styrby://pair')).toBe(true);
    });

    it('includes a data query parameter', () => {
      const payload = createPairingPayload(
        'token',
        'user',
        'machine',
        'device',
        'https://test.supabase.co'
      );

      const url = encodePairingUrl(payload);
      expect(url).toContain('?data=');
    });

    it('handles special characters in device name', () => {
      const payload = createPairingPayload(
        'token',
        'user',
        'machine',
        "John's MacBook Pro (2024)",
        'https://test.supabase.co'
      );

      const url = encodePairingUrl(payload);
      const decoded = decodePairingUrl(url);

      expect(decoded).not.toBeNull();
      expect(decoded!.deviceName).toBe("John's MacBook Pro (2024)");
    });
  });

  // ==========================================================================
  // decodePairingUrl() Edge Cases
  // ==========================================================================

  describe('decodePairingUrl() edge cases', () => {
    it('returns null for completely invalid data', () => {
      expect(decodePairingUrl('not-a-valid-url')).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(decodePairingUrl('')).toBeNull();
    });

    it('returns null for a URL with invalid base64 data', () => {
      expect(decodePairingUrl('styrby://pair?data=!!!invalid!!!')).toBeNull();
    });

    it('returns null for a URL with valid base64 but invalid JSON', () => {
      const invalidJson = btoa('not json');
      expect(decodePairingUrl(`styrby://pair?data=${encodeURIComponent(invalidJson)}`)).toBeNull();
    });

    it('returns null for a URL with valid JSON but wrong version', () => {
      const wrongVersion = btoa(JSON.stringify({ version: 2, token: 'abc' }));
      expect(decodePairingUrl(`styrby://pair?data=${encodeURIComponent(wrongVersion)}`)).toBeNull();
    });

    it('returns null for a URL with missing data parameter', () => {
      expect(decodePairingUrl('styrby://pair?other=value')).toBeNull();
    });
  });

  // ==========================================================================
  // isPairingExpired()
  // ==========================================================================

  describe('isPairingExpired()', () => {
    it('returns false for a freshly created payload', () => {
      const payload = createPairingPayload(
        'token',
        'user',
        'machine',
        'device',
        'https://test.supabase.co'
      );

      expect(isPairingExpired(payload)).toBe(false);
    });

    it('returns true for a payload with expiresAt in the past', () => {
      const payload = createPairingPayload(
        'token',
        'user',
        'machine',
        'device',
        'https://test.supabase.co'
      );
      // Override expiresAt to the past
      payload.expiresAt = new Date(Date.now() - 60000).toISOString();

      expect(isPairingExpired(payload)).toBe(true);
    });

    it('returns true for a payload that expired 5 minutes ago', () => {
      const payload = createPairingPayload(
        'token',
        'user',
        'machine',
        'device',
        'https://test.supabase.co'
      );
      payload.expiresAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();

      expect(isPairingExpired(payload)).toBe(true);
    });

    it('returns false for a payload that expires 1 hour from now', () => {
      const payload = createPairingPayload(
        'token',
        'user',
        'machine',
        'device',
        'https://test.supabase.co'
      );
      payload.expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

      expect(isPairingExpired(payload)).toBe(false);
    });
  });

  // ==========================================================================
  // validatePairingPayload()
  // ==========================================================================

  describe('validatePairingPayload()', () => {
    it('returns true for a valid payload', () => {
      const payload = createPairingPayload(
        'token',
        'user',
        'machine',
        'device',
        'https://test.supabase.co'
      );

      expect(validatePairingPayload(payload)).toBe(true);
    });

    it('returns true for a valid payload with activeAgent', () => {
      const payload = createPairingPayload(
        'token',
        'user',
        'machine',
        'device',
        'https://test.supabase.co',
        'claude'
      );

      expect(validatePairingPayload(payload)).toBe(true);
    });

    it('rejects null', () => {
      expect(validatePairingPayload(null)).toBe(false);
    });

    it('rejects undefined', () => {
      expect(validatePairingPayload(undefined)).toBe(false);
    });

    it('rejects a non-object', () => {
      expect(validatePairingPayload('string')).toBe(false);
      expect(validatePairingPayload(42)).toBe(false);
      expect(validatePairingPayload(true)).toBe(false);
    });

    it('rejects payload with missing token', () => {
      expect(validatePairingPayload({
        version: 1,
        userId: 'user',
        machineId: 'machine',
        deviceName: 'device',
        supabaseUrl: 'https://test.supabase.co',
        expiresAt: new Date().toISOString(),
      })).toBe(false);
    });

    it('rejects payload with missing userId', () => {
      expect(validatePairingPayload({
        version: 1,
        token: 'token',
        machineId: 'machine',
        deviceName: 'device',
        supabaseUrl: 'https://test.supabase.co',
        expiresAt: new Date().toISOString(),
      })).toBe(false);
    });

    it('rejects payload with missing machineId', () => {
      expect(validatePairingPayload({
        version: 1,
        token: 'token',
        userId: 'user',
        deviceName: 'device',
        supabaseUrl: 'https://test.supabase.co',
        expiresAt: new Date().toISOString(),
      })).toBe(false);
    });

    it('rejects payload with missing deviceName', () => {
      expect(validatePairingPayload({
        version: 1,
        token: 'token',
        userId: 'user',
        machineId: 'machine',
        supabaseUrl: 'https://test.supabase.co',
        expiresAt: new Date().toISOString(),
      })).toBe(false);
    });

    it('rejects payload with missing supabaseUrl', () => {
      expect(validatePairingPayload({
        version: 1,
        token: 'token',
        userId: 'user',
        machineId: 'machine',
        deviceName: 'device',
        expiresAt: new Date().toISOString(),
      })).toBe(false);
    });

    it('rejects payload with missing expiresAt', () => {
      expect(validatePairingPayload({
        version: 1,
        token: 'token',
        userId: 'user',
        machineId: 'machine',
        deviceName: 'device',
        supabaseUrl: 'https://test.supabase.co',
      })).toBe(false);
    });

    it('rejects payload with wrong version', () => {
      expect(validatePairingPayload({
        version: 2,
        token: 'token',
        userId: 'user',
        machineId: 'machine',
        deviceName: 'device',
        supabaseUrl: 'https://test.supabase.co',
        expiresAt: new Date().toISOString(),
      })).toBe(false);
    });

    it('rejects payload with non-string field types', () => {
      expect(validatePairingPayload({
        version: 1,
        token: 123, // should be string
        userId: 'user',
        machineId: 'machine',
        deviceName: 'device',
        supabaseUrl: 'https://test.supabase.co',
        expiresAt: new Date().toISOString(),
      })).toBe(false);
    });

    it('rejects an empty object', () => {
      expect(validatePairingPayload({})).toBe(false);
    });
  });

  // ==========================================================================
  // hashPairingToken()
  // ==========================================================================

  describe('hashPairingToken()', () => {
    it('returns a hex string', async () => {
      const hash = await hashPairingToken('test-token');
      expect(typeof hash).toBe('string');
      expect(hash).toMatch(/^[0-9a-f]+$/);
    });

    it('returns a 64-character hex string (SHA-256 = 32 bytes = 64 hex chars)', async () => {
      const hash = await hashPairingToken('test-token');
      expect(hash.length).toBe(64);
    });

    it('returns the same hash for the same input', async () => {
      const hash1 = await hashPairingToken('identical-token');
      const hash2 = await hashPairingToken('identical-token');
      expect(hash1).toBe(hash2);
    });

    it('returns different hashes for different inputs', async () => {
      const hash1 = await hashPairingToken('token-one');
      const hash2 = await hashPairingToken('token-two');
      expect(hash1).not.toBe(hash2);
    });

    it('produces only lowercase hex characters', async () => {
      const hash = await hashPairingToken('test-token');
      expect(hash).toBe(hash.toLowerCase());
    });
  });

  // ==========================================================================
  // Constants
  // ==========================================================================

  describe('Pairing Constants', () => {
    it('PAIRING_EXPIRY_MINUTES is 5', () => {
      expect(PAIRING_EXPIRY_MINUTES).toBe(5);
    });

    it('PAIRING_TOKEN_EXPIRY_MS is 5 minutes in milliseconds', () => {
      expect(PAIRING_TOKEN_EXPIRY_MS).toBe(5 * 60 * 1000);
      expect(PAIRING_TOKEN_EXPIRY_MS).toBe(300000);
    });

    it('PAIRING_SCHEME is styrby://pair', () => {
      expect(PAIRING_SCHEME).toBe('styrby://pair');
    });
  });
});
