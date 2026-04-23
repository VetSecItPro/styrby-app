/**
 * Unit Tests: polar-webhook-signature.ts (Phase 2.6, Unit B, Deliverable 2)
 *
 * Covers:
 * - verifyPolarSignature() returns true for a valid HMAC-SHA256 signature
 * - verifyPolarSignature() returns false for an invalid signature
 * - verifyPolarSignature() returns false for a wrong-length signature (length pre-check)
 * - verifyPolarSignature() returns false when POLAR_WEBHOOK_SECRET is missing
 * - verifyPolarSignatureOrThrow() throws PolarSignatureError on invalid signature
 * - verifyPolarSignatureOrThrow() does NOT throw on a valid signature
 * - Security: timingSafeEqual is used (grep-verified separately in CI)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';
import {
  verifyPolarSignature,
  verifyPolarSignatureOrThrow,
  PolarSignatureError,
} from '../polar-webhook-signature';

// ============================================================================
// Helpers
// ============================================================================

const TEST_SECRET = 'test-webhook-secret-sig-unit';
const TEST_BODY = JSON.stringify({ type: 'subscription.updated', data: { id: 'sub_abc' } });

/**
 * Produces a valid HMAC-SHA256 hex signature for the given body and secret.
 * Mirrors the production verification logic.
 */
function makeValidSignature(body: string, secret = TEST_SECRET): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv('POLAR_WEBHOOK_SECRET', TEST_SECRET);
});

// ============================================================================
// verifyPolarSignature()
// ============================================================================

describe('verifyPolarSignature()', () => {
  it('returns true for a valid HMAC-SHA256 signature', () => {
    const sig = makeValidSignature(TEST_BODY);
    expect(verifyPolarSignature(TEST_BODY, sig)).toBe(true);
  });

  it('returns false when the signature does not match', () => {
    const sig = makeValidSignature(TEST_BODY);
    // Flip the first character
    const badSig = ('a' === sig[0] ? 'b' : 'a') + sig.slice(1);
    expect(verifyPolarSignature(TEST_BODY, badSig)).toBe(false);
  });

  it('returns false when the body has been tampered (signature was for different content)', () => {
    const sig = makeValidSignature(TEST_BODY);
    const tamperedBody = TEST_BODY + ' extra';
    expect(verifyPolarSignature(tamperedBody, sig)).toBe(false);
  });

  it('returns false for a short signature (length pre-check prevents timingSafeEqual RangeError)', () => {
    // WHY: crypto.timingSafeEqual throws if buffers differ in length.
    // The length pre-check must catch this and return false (not throw).
    expect(() => verifyPolarSignature(TEST_BODY, 'tooshort')).not.toThrow();
    expect(verifyPolarSignature(TEST_BODY, 'tooshort')).toBe(false);
  });

  it('returns false for an empty signature string', () => {
    expect(verifyPolarSignature(TEST_BODY, '')).toBe(false);
  });

  it('returns false for an all-zeros signature of the correct length', () => {
    // SHA-256 hex is always 64 chars; all-zeros is a valid length but wrong content.
    const allZeros = '0'.repeat(64);
    expect(verifyPolarSignature(TEST_BODY, allZeros)).toBe(false);
  });

  it('returns false when POLAR_WEBHOOK_SECRET is not set', () => {
    vi.stubEnv('POLAR_WEBHOOK_SECRET', '');
    const sig = makeValidSignature(TEST_BODY);
    expect(verifyPolarSignature(TEST_BODY, sig)).toBe(false);
  });

  it('returns false when signed with a different secret', () => {
    const sig = makeValidSignature(TEST_BODY, 'totally-different-secret');
    expect(verifyPolarSignature(TEST_BODY, sig)).toBe(false);
  });

  it('handles an empty body correctly (signature of empty string)', () => {
    const emptyBody = '';
    const sig = makeValidSignature(emptyBody);
    expect(verifyPolarSignature(emptyBody, sig)).toBe(true);
  });

  it('accepts an uppercase hex signature (case-insensitive after Fix 3 normalization)', () => {
    // WHY: Polar currently delivers lowercase hex, but RFC 2104 does not mandate
    // case. Some providers or intermediary proxies uppercase hex. After Fix 3,
    // incoming signatures are normalized to lowercase via .toLowerCase() before
    // the Buffer conversion, so an uppercase-hex signature representing the same
    // HMAC should produce a PASS verdict.
    const sig = makeValidSignature(TEST_BODY);
    const upperSig = sig.toUpperCase();
    // Upper and lower are the same HMAC — normalization means this must pass.
    expect(verifyPolarSignature(TEST_BODY, upperSig)).toBe(true);
  });

  it('rejects a mixed-case signature where the hex digits are genuinely wrong (not just case)', () => {
    // Ensure normalization does not accidentally make an invalid signature valid.
    // Flip the first hex digit to a different digit (not just case).
    const sig = makeValidSignature(TEST_BODY);
    const badSig = ('0' === sig[0] ? '1' : '0') + sig.slice(1).toUpperCase();
    expect(verifyPolarSignature(TEST_BODY, badSig)).toBe(false);
  });
});

// ============================================================================
// verifyPolarSignatureOrThrow()
// ============================================================================

describe('verifyPolarSignatureOrThrow()', () => {
  it('does not throw when the signature is valid', () => {
    const sig = makeValidSignature(TEST_BODY);
    expect(() => verifyPolarSignatureOrThrow(TEST_BODY, sig)).not.toThrow();
  });

  it('throws PolarSignatureError when the signature is invalid', () => {
    expect(() => verifyPolarSignatureOrThrow(TEST_BODY, 'invalidsignature')).toThrow(
      PolarSignatureError
    );
  });

  it('throws PolarSignatureError with statusCode 401', () => {
    try {
      verifyPolarSignatureOrThrow(TEST_BODY, 'wrong');
    } catch (e) {
      expect(e).toBeInstanceOf(PolarSignatureError);
      expect((e as PolarSignatureError).statusCode).toBe(401);
    }
  });

  it('throws PolarSignatureError with code POLAR_SIGNATURE_INVALID', () => {
    try {
      verifyPolarSignatureOrThrow(TEST_BODY, 'wrong');
    } catch (e) {
      expect(e).toBeInstanceOf(PolarSignatureError);
      expect((e as PolarSignatureError).code).toBe('POLAR_SIGNATURE_INVALID');
    }
  });

  it('throws when POLAR_WEBHOOK_SECRET is missing', () => {
    vi.stubEnv('POLAR_WEBHOOK_SECRET', '');
    const sig = makeValidSignature(TEST_BODY);
    expect(() => verifyPolarSignatureOrThrow(TEST_BODY, sig)).toThrow(PolarSignatureError);
  });
});

// ============================================================================
// PolarSignatureError shape
// ============================================================================

describe('PolarSignatureError', () => {
  it('is an instance of Error', () => {
    const err = new PolarSignatureError();
    expect(err).toBeInstanceOf(Error);
  });

  it('has name PolarSignatureError', () => {
    expect(new PolarSignatureError().name).toBe('PolarSignatureError');
  });

  it('has statusCode 401', () => {
    expect(new PolarSignatureError().statusCode).toBe(401);
  });

  it('has code POLAR_SIGNATURE_INVALID', () => {
    expect(new PolarSignatureError().code).toBe('POLAR_SIGNATURE_INVALID');
  });
});
