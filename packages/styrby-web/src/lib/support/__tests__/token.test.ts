/**
 * Unit tests for lib/support/token.ts
 *
 * Phase 4.2 T3 — Support token generation and verification
 *
 * WHY these tests matter:
 * `generateSupportToken` and `verifySupportToken` are the security foundation
 * for consent-gated session access. A bug here — wrong entropy, broken hash,
 * or timing-oracle leak — directly undermines the threat model in Phase 4.2
 * §2. Every property the spec guarantees must be machine-verified.
 *
 * Covers:
 * - Round-trip: generate → verify returns true
 * - Wrong token: verify(otherRaw, hash) returns false
 * - Length mismatch: short input defended against (no throw)
 * - Entropy: 10 generated tokens are all distinct
 * - Hash format: exactly 64 lowercase hex characters
 * - Raw format: exactly 43 URL-safe base64url characters (no padding)
 * - Empty inputs: verify('', '') returns false without throwing
 * - Empty raw only: verify('', validHash) returns false
 * - Empty hash only: verify(validRaw, '') returns false
 * - Malformed hash (non-hex): returns false, no throw
 * - Truncated hash: returns false, no throw (length mismatch guard)
 * - Verify is case-insensitive on hash? (SHA-256 hex is always lowercase — no case variance expected; test confirms)
 * - Determinism: same raw input always produces the same hash
 */

import { describe, it, expect } from 'vitest';
import { generateSupportToken, verifySupportToken } from '../token';

// ---------------------------------------------------------------------------
// generateSupportToken
// ---------------------------------------------------------------------------

describe('generateSupportToken', () => {
  it('returns an object with raw and hash properties', () => {
    const result = generateSupportToken();
    expect(result).toHaveProperty('raw');
    expect(result).toHaveProperty('hash');
  });

  it('raw is exactly 43 URL-safe base64url characters (32 bytes, no padding)', () => {
    // 32 bytes → Math.ceil(32 * 4 / 3) = 43 base64url chars (no `=` padding)
    const { raw } = generateSupportToken();
    expect(raw).toHaveLength(43);
    // base64url charset: A-Z a-z 0-9 - _  (NO + / =)
    expect(raw).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('hash is exactly 64 lowercase hex characters (SHA-256)', () => {
    const { hash } = generateSupportToken();
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('generates distinct tokens on each call (entropy check across 10 tokens)', () => {
    const tokens = Array.from({ length: 10 }, () => generateSupportToken());
    const raws = tokens.map((t) => t.raw);
    const hashes = tokens.map((t) => t.hash);

    // All raws distinct
    expect(new Set(raws).size).toBe(10);
    // All hashes distinct
    expect(new Set(hashes).size).toBe(10);
  });

  it('raw and hash are not equal to each other (hash ≠ plaintext)', () => {
    const { raw, hash } = generateSupportToken();
    // raw is base64url; hash is hex — they should never be equal
    expect(raw).not.toBe(hash);
  });
});

// ---------------------------------------------------------------------------
// verifySupportToken
// ---------------------------------------------------------------------------

describe('verifySupportToken', () => {
  // ---- Happy path ----------------------------------------------------------

  it('returns true for a valid round-trip (generate → verify)', () => {
    const { raw, hash } = generateSupportToken();
    expect(verifySupportToken(raw, hash)).toBe(true);
  });

  it('returns true consistently for the same valid pair (no state mutation)', () => {
    const { raw, hash } = generateSupportToken();
    // Call twice to confirm no internal state change
    expect(verifySupportToken(raw, hash)).toBe(true);
    expect(verifySupportToken(raw, hash)).toBe(true);
  });

  it('hash is deterministic — same raw always produces the same hash', () => {
    // generateSupportToken itself uses random bytes, but verifySupportToken
    // re-hashes the raw input. Confirm the hash is stable across calls.
    const { raw, hash } = generateSupportToken();
    // Verify twice — both must agree with the stored hash
    expect(verifySupportToken(raw, hash)).toBe(true);
    expect(verifySupportToken(raw, hash)).toBe(true);
  });

  // ---- Wrong token ---------------------------------------------------------

  it('returns false when raw is a different token than the one that produced the hash', () => {
    const { hash } = generateSupportToken();
    const { raw: otherRaw } = generateSupportToken();
    expect(verifySupportToken(otherRaw, hash)).toBe(false);
  });

  it('returns false when raw is a single character mutation of the correct raw', () => {
    const { raw, hash } = generateSupportToken();
    // Flip the last character
    const mutated = raw.slice(0, -1) + (raw[raw.length - 1] === 'A' ? 'B' : 'A');
    expect(verifySupportToken(mutated, hash)).toBe(false);
  });

  // ---- Empty / invalid inputs ---------------------------------------------

  it('returns false for empty string inputs without throwing', () => {
    expect(() => verifySupportToken('', '')).not.toThrow();
    expect(verifySupportToken('', '')).toBe(false);
  });

  it('returns false when raw is empty and hash is a valid hex hash', () => {
    const { hash } = generateSupportToken();
    expect(verifySupportToken('', hash)).toBe(false);
  });

  it('returns false when raw is valid and hash is empty', () => {
    const { raw } = generateSupportToken();
    expect(verifySupportToken(raw, '')).toBe(false);
  });

  // ---- Length mismatch (timingSafeEqual guard) -----------------------------

  it('returns false for a short raw token without throwing (length mismatch handled)', () => {
    const { hash } = generateSupportToken();
    // 'short' hashes to a 64-char SHA-256 hex — lengths will actually match
    // in the buffer comparison (both are 32 bytes). The verify call should
    // return false because the hashes don't match, not because of a throw.
    expect(() => verifySupportToken('short', hash)).not.toThrow();
    expect(verifySupportToken('short', hash)).toBe(false);
  });

  it('returns false for a single-character raw input without throwing', () => {
    const { hash } = generateSupportToken();
    expect(() => verifySupportToken('a', hash)).not.toThrow();
    expect(verifySupportToken('a', hash)).toBe(false);
  });

  it('returns false for a truncated expectedHash (length mismatch guard)', () => {
    const { raw, hash } = generateSupportToken();
    const truncatedHash = hash.slice(0, 32); // 32 hex chars → 16 bytes, not 32
    expect(() => verifySupportToken(raw, truncatedHash)).not.toThrow();
    expect(verifySupportToken(raw, truncatedHash)).toBe(false);
  });

  it('returns false for a malformed (non-hex) expectedHash without throwing', () => {
    const { raw } = generateSupportToken();
    // Buffer.from('not-hex', 'hex') silently stops at first non-hex char → short buffer
    expect(() => verifySupportToken(raw, 'not-a-valid-hex-hash')).not.toThrow();
    expect(verifySupportToken(raw, 'not-a-valid-hex-hash')).toBe(false);
  });

  it('returns false for a 64-char string of non-hex chars in expectedHash', () => {
    const { raw } = generateSupportToken();
    // 64 chars but entirely non-hex → Buffer.from('zzzz...', 'hex') → empty buffer
    const nonHexHash = 'z'.repeat(64);
    expect(() => verifySupportToken(raw, nonHexHash)).not.toThrow();
    expect(verifySupportToken(raw, nonHexHash)).toBe(false);
  });

  // ---- Cross-pair isolation ------------------------------------------------

  it('does not cross-verify: token A does not verify against hash B', () => {
    const pairA = generateSupportToken();
    const pairB = generateSupportToken();
    expect(verifySupportToken(pairA.raw, pairB.hash)).toBe(false);
    expect(verifySupportToken(pairB.raw, pairA.hash)).toBe(false);
  });

  // ---- Hash format from generateSupportToken verified via verifySupportToken

  it('hash produced by generateSupportToken is in canonical lowercase hex (matches what verifySupportToken produces internally)', () => {
    const { raw, hash } = generateSupportToken();
    // If hash were uppercase, verifySupportToken's internal hex would differ and return false
    expect(verifySupportToken(raw, hash)).toBe(true);
    // Confirm hash is indeed lowercase
    expect(hash).toBe(hash.toLowerCase());
  });
});
