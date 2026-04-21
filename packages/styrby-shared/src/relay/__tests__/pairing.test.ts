/**
 * Tests for relay pairing helpers (relay/pairing.ts).
 *
 * Covers: generatePairingToken, hashPairingToken, createPairingPayload,
 * encodePairingUrl, decodePairingUrl, isPairingExpired, validatePairingPayload.
 *
 * @module relay/__tests__/pairing
 */

import { describe, it, expect } from 'vitest';
import {
  generatePairingToken,
  hashPairingToken,
  createPairingPayload,
  encodePairingUrl,
  decodePairingUrl,
  isPairingExpired,
  validatePairingPayload,
  PAIRING_SCHEME,
  PAIRING_TOKEN_EXPIRY_MS,
  PAIRING_EXPIRY_MINUTES,
} from '../pairing.js';
import type { PairingPayload } from '../pairing.js';

// ============================================================================
// generatePairingToken
// ============================================================================

describe('generatePairingToken', () => {
  it('returns a non-empty string', () => {
    const token = generatePairingToken();
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);
  });

  it('produces URL-safe base64 (no +, /, or = characters)', () => {
    const token = generatePairingToken();
    expect(token).not.toMatch(/[+/=]/);
  });

  it('produces unique tokens on successive calls', () => {
    const a = generatePairingToken();
    const b = generatePairingToken();
    expect(a).not.toBe(b);
  });

  it('has sufficient length (>= 40 chars for 32 bytes base64url)', () => {
    // 32 bytes → ~43 base64url chars (32 * 4/3, rounded, minus padding)
    expect(generatePairingToken().length).toBeGreaterThanOrEqual(40);
  });
});

// ============================================================================
// hashPairingToken
// ============================================================================

describe('hashPairingToken', () => {
  it('returns a 64-character hex string (SHA-256)', async () => {
    const hash = await hashPairingToken('test-token');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for the same input', async () => {
    const a = await hashPairingToken('my-token');
    const b = await hashPairingToken('my-token');
    expect(a).toBe(b);
  });

  it('produces different hashes for different inputs', async () => {
    const a = await hashPairingToken('token-a');
    const b = await hashPairingToken('token-b');
    expect(a).not.toBe(b);
  });
});

// ============================================================================
// createPairingPayload
// ============================================================================

describe('createPairingPayload', () => {
  const payload = createPairingPayload(
    'tok123',
    'user-id-456',
    'machine-abc',
    'My MacBook',
    'https://akmtmxunjhsgldjztdtt.supabase.co',
    'claude',
  );

  it('sets version to 1', () => {
    expect(payload.version).toBe(1);
  });

  it('echoes all provided fields', () => {
    expect(payload.token).toBe('tok123');
    expect(payload.userId).toBe('user-id-456');
    expect(payload.machineId).toBe('machine-abc');
    expect(payload.deviceName).toBe('My MacBook');
    expect(payload.supabaseUrl).toBe('https://akmtmxunjhsgldjztdtt.supabase.co');
    expect(payload.activeAgent).toBe('claude');
  });

  it('sets expiresAt to roughly now + PAIRING_TOKEN_EXPIRY_MS', () => {
    const before = Date.now();
    const p = createPairingPayload('t', 'u', 'm', 'd', 'https://x.supabase.co');
    const after = Date.now();
    const expiresTs = new Date(p.expiresAt).getTime();
    expect(expiresTs).toBeGreaterThanOrEqual(before + PAIRING_TOKEN_EXPIRY_MS - 50);
    expect(expiresTs).toBeLessThanOrEqual(after + PAIRING_TOKEN_EXPIRY_MS + 50);
  });

  it('allows undefined activeAgent', () => {
    const p = createPairingPayload('t', 'u', 'm', 'd', 'https://x.supabase.co');
    expect(p.activeAgent).toBeUndefined();
  });
});

// ============================================================================
// encodePairingUrl / decodePairingUrl round-trip
// ============================================================================

describe('encodePairingUrl + decodePairingUrl', () => {
  const payload: PairingPayload = {
    version: 1,
    token: 'abc123',
    userId: 'user-1',
    machineId: 'machine-1',
    deviceName: 'Dev Machine',
    supabaseUrl: 'https://test.supabase.co',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };

  it('produces a URL starting with the pairing scheme', () => {
    const url = encodePairingUrl(payload);
    expect(url.startsWith(PAIRING_SCHEME)).toBe(true);
  });

  it('round-trips a payload through encode then decode', () => {
    const url = encodePairingUrl(payload);
    const decoded = decodePairingUrl(url);
    expect(decoded).not.toBeNull();
    expect(decoded?.token).toBe(payload.token);
    expect(decoded?.userId).toBe(payload.userId);
    expect(decoded?.machineId).toBe(payload.machineId);
    expect(decoded?.deviceName).toBe(payload.deviceName);
    expect(decoded?.supabaseUrl).toBe(payload.supabaseUrl);
    expect(decoded?.version).toBe(1);
  });

  it('decodePairingUrl returns null for an invalid URL', () => {
    expect(decodePairingUrl('not-a-valid-url')).toBeNull();
  });

  it('decodePairingUrl returns null for a URL with wrong version', () => {
    const badPayload = { ...payload, version: 2 as unknown as 1 };
    const url = `${PAIRING_SCHEME}?data=${encodeURIComponent(btoa(JSON.stringify(badPayload)))}`;
    expect(decodePairingUrl(url)).toBeNull();
  });

  it('decodePairingUrl returns null for malformed base64', () => {
    const url = `${PAIRING_SCHEME}?data=!!!notbase64!!!`;
    expect(decodePairingUrl(url)).toBeNull();
  });
});

// ============================================================================
// isPairingExpired
// ============================================================================

describe('isPairingExpired', () => {
  it('returns false for a future expiresAt', () => {
    const payload: PairingPayload = {
      version: 1,
      token: 't',
      userId: 'u',
      machineId: 'm',
      deviceName: 'd',
      supabaseUrl: 'https://x.supabase.co',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    expect(isPairingExpired(payload)).toBe(false);
  });

  it('returns true for a past expiresAt', () => {
    const payload: PairingPayload = {
      version: 1,
      token: 't',
      userId: 'u',
      machineId: 'm',
      deviceName: 'd',
      supabaseUrl: 'https://x.supabase.co',
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    };
    expect(isPairingExpired(payload)).toBe(true);
  });
});

// ============================================================================
// validatePairingPayload
// ============================================================================

describe('validatePairingPayload', () => {
  const validPayload: PairingPayload = {
    version: 1,
    token: 'tok',
    userId: 'user',
    machineId: 'machine',
    deviceName: 'name',
    supabaseUrl: 'https://x.supabase.co',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };

  it('accepts a well-formed payload', () => {
    expect(validatePairingPayload(validPayload)).toBe(true);
  });

  it('rejects null', () => {
    expect(validatePairingPayload(null)).toBe(false);
  });

  it('rejects a string', () => {
    expect(validatePairingPayload('payload')).toBe(false);
  });

  it('rejects when version is not 1', () => {
    expect(validatePairingPayload({ ...validPayload, version: 2 })).toBe(false);
  });

  it('rejects when a required field is missing', () => {
    const { token: _omit, ...missing } = validPayload;
    expect(validatePairingPayload(missing)).toBe(false);
  });

  it('rejects when a required field is not a string', () => {
    expect(validatePairingPayload({ ...validPayload, userId: 123 })).toBe(false);
  });
});

// ============================================================================
// Constants
// ============================================================================

describe('Pairing constants', () => {
  it('PAIRING_EXPIRY_MINUTES is 5', () => {
    expect(PAIRING_EXPIRY_MINUTES).toBe(5);
  });

  it('PAIRING_TOKEN_EXPIRY_MS is 5 minutes in ms', () => {
    expect(PAIRING_TOKEN_EXPIRY_MS).toBe(5 * 60 * 1000);
  });

  it('PAIRING_SCHEME is the styrby://pair deep link', () => {
    expect(PAIRING_SCHEME).toBe('styrby://pair');
  });
});
