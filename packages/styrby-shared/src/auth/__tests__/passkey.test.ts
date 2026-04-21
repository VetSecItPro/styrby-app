/**
 * Tests for WebAuthn passkey helpers (auth/passkey.ts).
 *
 * Covers: extractRpId, buildPublicKeyCredentialCreationOptions,
 * buildPublicKeyCredentialRequestOptions, isCounterValid, and constants.
 *
 * All helpers are pure functions — no mocks needed.
 *
 * @module auth/__tests__/passkey
 */

import { describe, it, expect } from 'vitest';
import {
  extractRpId,
  buildPublicKeyCredentialCreationOptions,
  buildPublicKeyCredentialRequestOptions,
  isCounterValid,
  DEFAULT_PASSKEY_TIMEOUT_MS,
  PASSKEY_CHALLENGE_BYTES,
  PASSKEY_CHALLENGE_TTL_MS,
} from '../passkey.js';

// ============================================================================
// extractRpId
// ============================================================================

describe('extractRpId', () => {
  it('returns the hostname from an https URL', () => {
    expect(extractRpId('https://styrby.com/login')).toBe('styrby.com');
  });

  it('returns localhost for local dev', () => {
    expect(extractRpId('http://localhost:3000')).toBe('localhost');
  });

  it('handles Vercel preview deploy hostnames', () => {
    expect(extractRpId('https://preview-xyz.vercel.app')).toBe('preview-xyz.vercel.app');
  });

  it('normalizes to lowercase', () => {
    expect(extractRpId('https://Styrby.COM/path')).toBe('styrby.com');
  });

  it('strips port numbers', () => {
    expect(extractRpId('https://styrby.com:443/dashboard')).toBe('styrby.com');
  });

  it('handles subdomain URLs', () => {
    expect(extractRpId('https://app.styrby.com')).toBe('app.styrby.com');
  });

  it('throws TypeError for invalid URLs', () => {
    expect(() => extractRpId('not-a-url')).toThrow(TypeError);
    expect(() => extractRpId('')).toThrow(TypeError);
  });
});

// ============================================================================
// buildPublicKeyCredentialCreationOptions
// ============================================================================

describe('buildPublicKeyCredentialCreationOptions', () => {
  const baseInput = {
    rpId: 'styrby.com',
    rpName: 'Styrby',
    userId: 'dXNlcklk', // base64url of "userId"
    userName: 'test@styrby.com',
    userDisplayName: 'Test User',
    challenge: 'Y2hhbGxlbmdl', // base64url of "challenge"
  };

  it('includes correct rp fields', () => {
    const opts = buildPublicKeyCredentialCreationOptions(baseInput);
    expect(opts.rp).toEqual({ id: 'styrby.com', name: 'Styrby' });
  });

  it('includes correct user fields', () => {
    const opts = buildPublicKeyCredentialCreationOptions(baseInput);
    expect(opts.user).toEqual({
      id: baseInput.userId,
      name: baseInput.userName,
      displayName: baseInput.userDisplayName,
    });
  });

  it('echoes the challenge unchanged', () => {
    const opts = buildPublicKeyCredentialCreationOptions(baseInput);
    expect(opts.challenge).toBe(baseInput.challenge);
  });

  it('includes ES256, EdDSA, and RS256 alg params in preference order', () => {
    const opts = buildPublicKeyCredentialCreationOptions(baseInput);
    expect(opts.pubKeyCredParams).toEqual([
      { type: 'public-key', alg: -7 },   // ES256
      { type: 'public-key', alg: -8 },   // EdDSA
      { type: 'public-key', alg: -257 }, // RS256
    ]);
  });

  it('uses DEFAULT_PASSKEY_TIMEOUT_MS when timeoutMs is omitted', () => {
    const opts = buildPublicKeyCredentialCreationOptions(baseInput);
    expect(opts.timeout).toBe(DEFAULT_PASSKEY_TIMEOUT_MS);
  });

  it('uses the provided timeoutMs when given', () => {
    const opts = buildPublicKeyCredentialCreationOptions({ ...baseInput, timeoutMs: 30_000 });
    expect(opts.timeout).toBe(30_000);
  });

  it('produces an empty excludeCredentials array when none provided', () => {
    const opts = buildPublicKeyCredentialCreationOptions(baseInput);
    expect(opts.excludeCredentials).toEqual([]);
  });

  it('maps excludeCredentials ids to public-key objects', () => {
    const opts = buildPublicKeyCredentialCreationOptions({
      ...baseInput,
      excludeCredentials: ['cred-1', 'cred-2'],
    });
    expect(opts.excludeCredentials).toEqual([
      { type: 'public-key', id: 'cred-1' },
      { type: 'public-key', id: 'cred-2' },
    ]);
  });

  it('enforces residentKey: required (discoverable credentials)', () => {
    const opts = buildPublicKeyCredentialCreationOptions(baseInput);
    expect(opts.authenticatorSelection.residentKey).toBe('required');
  });

  it('enforces userVerification: required (NIST AAL3)', () => {
    const opts = buildPublicKeyCredentialCreationOptions(baseInput);
    expect(opts.authenticatorSelection.userVerification).toBe('required');
  });

  it('uses attestation: none (privacy-preserving)', () => {
    const opts = buildPublicKeyCredentialCreationOptions(baseInput);
    expect(opts.attestation).toBe('none');
  });

  it('requests credProps extension', () => {
    const opts = buildPublicKeyCredentialCreationOptions(baseInput);
    expect(opts.extensions).toEqual({ credProps: true });
  });
});

// ============================================================================
// buildPublicKeyCredentialRequestOptions
// ============================================================================

describe('buildPublicKeyCredentialRequestOptions', () => {
  const baseInput = {
    rpId: 'styrby.com',
    challenge: 'Y2hhbGxlbmdl',
  };

  it('echoes rpId and challenge', () => {
    const opts = buildPublicKeyCredentialRequestOptions(baseInput);
    expect(opts.rpId).toBe('styrby.com');
    expect(opts.challenge).toBe('Y2hhbGxlbmdl');
  });

  it('enforces userVerification: required (NIST AAL3)', () => {
    const opts = buildPublicKeyCredentialRequestOptions(baseInput);
    expect(opts.userVerification).toBe('required');
  });

  it('produces an empty allowCredentials array when none provided', () => {
    const opts = buildPublicKeyCredentialRequestOptions(baseInput);
    expect(opts.allowCredentials).toEqual([]);
  });

  it('maps allowCredentials ids to public-key objects', () => {
    const opts = buildPublicKeyCredentialRequestOptions({
      ...baseInput,
      allowCredentials: ['abc', 'def'],
    });
    expect(opts.allowCredentials).toEqual([
      { type: 'public-key', id: 'abc' },
      { type: 'public-key', id: 'def' },
    ]);
  });

  it('uses DEFAULT_PASSKEY_TIMEOUT_MS when timeoutMs is omitted', () => {
    const opts = buildPublicKeyCredentialRequestOptions(baseInput);
    expect(opts.timeout).toBe(DEFAULT_PASSKEY_TIMEOUT_MS);
  });

  it('respects an explicit timeoutMs', () => {
    const opts = buildPublicKeyCredentialRequestOptions({ ...baseInput, timeoutMs: 45_000 });
    expect(opts.timeout).toBe(45_000);
  });
});

// ============================================================================
// isCounterValid
// ============================================================================

describe('isCounterValid', () => {
  it('returns true for a normal monotonic increment', () => {
    expect(isCounterValid(5, 6)).toBe(true);
    expect(isCounterValid(0, 1)).toBe(true);
    expect(isCounterValid(100, 200)).toBe(true);
  });

  it('returns false when incoming equals stored (replay attack)', () => {
    expect(isCounterValid(5, 5)).toBe(false);
    expect(isCounterValid(1, 1)).toBe(false);
  });

  it('returns false when incoming is less than stored (rollback / clone)', () => {
    expect(isCounterValid(5, 4)).toBe(false);
    expect(isCounterValid(10, 0)).toBe(false);
  });

  it('returns true when both counters are zero (Apple/Google fixed-zero behavior)', () => {
    // WHY: Apple platform keys and certain TPM authenticators deliberately
    // return signCount=0. Spec permits skipping the check when both are zero.
    expect(isCounterValid(0, 0)).toBe(true);
  });

  it('returns false when stored=0 but incoming=0 is already covered, and stored>0 incoming=0 is a rollback', () => {
    expect(isCounterValid(1, 0)).toBe(false);
  });
});

// ============================================================================
// Constants
// ============================================================================

describe('Passkey constants', () => {
  it('DEFAULT_PASSKEY_TIMEOUT_MS is 60 seconds', () => {
    expect(DEFAULT_PASSKEY_TIMEOUT_MS).toBe(60_000);
  });

  it('PASSKEY_CHALLENGE_BYTES is 32 (NIST 800-63B >= 64 bits)', () => {
    expect(PASSKEY_CHALLENGE_BYTES).toBe(32);
  });

  it('PASSKEY_CHALLENGE_TTL_MS is 5 minutes', () => {
    expect(PASSKEY_CHALLENGE_TTL_MS).toBe(5 * 60 * 1000);
  });
});
