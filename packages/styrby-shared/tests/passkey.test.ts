/**
 * Tests for the passkey (WebAuthn L3) shared helpers.
 *
 * Covers: RP ID derivation, option builders, and the counter-rollback
 * detection gate (which is load-bearing — missing it = cloned-authenticator
 * bypass per WebAuthn L3 §7.2 step 19).
 */

import { describe, it, expect } from 'vitest';
import {
  extractRpId,
  buildPublicKeyCredentialCreationOptions,
  buildPublicKeyCredentialRequestOptions,
  isCounterValid,
  DEFAULT_PASSKEY_TIMEOUT_MS,
} from '../src/auth/passkey';

describe('extractRpId', () => {
  it('returns the hostname for an https URL', () => {
    expect(extractRpId('https://styrby.com/login')).toBe('styrby.com');
  });

  it('strips the port', () => {
    expect(extractRpId('http://localhost:3000/foo')).toBe('localhost');
  });

  it('lower-cases the host (canonical form for §5.1.2 comparison)', () => {
    expect(extractRpId('https://Styrby.COM')).toBe('styrby.com');
  });

  it('handles vercel preview domains', () => {
    expect(extractRpId('https://styrby-git-feat-xyz.vercel.app/login')).toBe(
      'styrby-git-feat-xyz.vercel.app',
    );
  });

  it('throws TypeError on a relative path', () => {
    expect(() => extractRpId('/login')).toThrow(TypeError);
  });
});

describe('buildPublicKeyCredentialCreationOptions', () => {
  const baseInput = {
    rpId: 'styrby.com',
    rpName: 'Styrby',
    userId: 'dXNlci0xMjM', // base64url("user-123")
    userName: 'alice@example.com',
    userDisplayName: 'Alice',
    challenge: 'Y2hhbGxlbmdl', // base64url("challenge")
  };

  it('sets residentKey=required (discoverable credential, no email prompt)', () => {
    const opts = buildPublicKeyCredentialCreationOptions(baseInput);
    expect(opts.authenticatorSelection.residentKey).toBe('required');
  });

  it('sets userVerification=required (NIST AAL3 gate)', () => {
    const opts = buildPublicKeyCredentialCreationOptions(baseInput);
    expect(opts.authenticatorSelection.userVerification).toBe('required');
  });

  it('uses attestation=none for privacy preservation', () => {
    const opts = buildPublicKeyCredentialCreationOptions(baseInput);
    expect(opts.attestation).toBe('none');
  });

  it('offers ES256, EdDSA, RS256 in preference order', () => {
    const opts = buildPublicKeyCredentialCreationOptions(baseInput);
    expect(opts.pubKeyCredParams.map((p) => p.alg)).toEqual([-7, -8, -257]);
  });

  it('defaults timeout to 60s', () => {
    const opts = buildPublicKeyCredentialCreationOptions(baseInput);
    expect(opts.timeout).toBe(DEFAULT_PASSKEY_TIMEOUT_MS);
  });

  it('respects a caller-supplied timeout', () => {
    const opts = buildPublicKeyCredentialCreationOptions({
      ...baseInput,
      timeoutMs: 15_000,
    });
    expect(opts.timeout).toBe(15_000);
  });

  it('serializes excludeCredentials ids', () => {
    const opts = buildPublicKeyCredentialCreationOptions({
      ...baseInput,
      excludeCredentials: ['aaa', 'bbb'],
    });
    expect(opts.excludeCredentials).toEqual([
      { type: 'public-key', id: 'aaa' },
      { type: 'public-key', id: 'bbb' },
    ]);
  });

  it('requests the credProps extension', () => {
    const opts = buildPublicKeyCredentialCreationOptions(baseInput);
    expect(opts.extensions.credProps).toBe(true);
  });
});

describe('buildPublicKeyCredentialRequestOptions', () => {
  it('forces userVerification=required (no silent AAL3 -> AAL2 downgrade)', () => {
    const opts = buildPublicKeyCredentialRequestOptions({
      rpId: 'styrby.com',
      challenge: 'Y2hhbGxlbmdl',
    });
    expect(opts.userVerification).toBe('required');
  });

  it('empty allowCredentials enables discoverable-credential flow', () => {
    const opts = buildPublicKeyCredentialRequestOptions({
      rpId: 'styrby.com',
      challenge: 'Y2hhbGxlbmdl',
    });
    expect(opts.allowCredentials).toEqual([]);
  });

  it('maps supplied credential ids to type+id descriptors', () => {
    const opts = buildPublicKeyCredentialRequestOptions({
      rpId: 'styrby.com',
      challenge: 'Y2hhbGxlbmdl',
      allowCredentials: ['cred-1'],
    });
    expect(opts.allowCredentials).toEqual([
      { type: 'public-key', id: 'cred-1' },
    ]);
  });
});

describe('isCounterValid (WebAuthn L3 §7.2 step 19 — clone detection)', () => {
  it('accepts a normal monotonic increment', () => {
    expect(isCounterValid(5, 6)).toBe(true);
  });

  it('accepts a large jump (authenticator used on another RP between sessions)', () => {
    expect(isCounterValid(5, 500)).toBe(true);
  });

  it('rejects equality (replay)', () => {
    expect(isCounterValid(5, 5)).toBe(false);
  });

  it('rejects a rollback (possible clone)', () => {
    expect(isCounterValid(10, 3)).toBe(false);
  });

  it('accepts both-zero (Apple platform-key behavior — spec-permitted)', () => {
    expect(isCounterValid(0, 0)).toBe(true);
  });

  it('rejects zero when stored is nonzero (malformed / clone)', () => {
    expect(isCounterValid(5, 0)).toBe(false);
  });

  it('accepts first nonzero after zero (transition from Apple-style to counted)', () => {
    expect(isCounterValid(0, 1)).toBe(true);
  });
});
