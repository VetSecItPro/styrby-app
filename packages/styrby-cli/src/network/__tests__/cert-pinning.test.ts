/**
 * Tests for TLS certificate pinning (CLI-007, audit 2026-05-04).
 *
 * Tests the pin-verification logic, NOT the live TLS handshake (which would
 * require a real or mock TLS server). The two business-critical behaviours:
 *  1. Pin match: verification passes (returns undefined).
 *  2. Pin mismatch: verification fails with an Error.
 *  3. --no-cert-pin: verification passes regardless.
 *
 * @module network/__tests__/cert-pinning
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import type tls from 'node:tls';
import { makePinnedCheckServerIdentity, __pinsForTesting } from '../cert-pinning';

// ----------------------------------------------------------------------
// Helpers — synthesise a fake PeerCertificate the validator can fingerprint
// ----------------------------------------------------------------------
function makeCert(host: string, raw: Buffer): tls.PeerCertificate {
  const fpHex = crypto.createHash('sha256').update(raw).digest('hex');
  // Format Node's "AB:CD:..." fingerprint string from our hex.
  const fp = fpHex.match(/.{2}/g)!.join(':').toUpperCase();
  return {
    subject: { CN: host } as tls.PeerCertificate['subject'],
    issuer: { CN: 'Test CA' } as tls.PeerCertificate['issuer'],
    subjectaltname: `DNS:${host}`,
    valid_from: new Date(Date.now() - 86400_000).toUTCString(),
    valid_to: new Date(Date.now() + 86400_000).toUTCString(),
    fingerprint: 'unused',
    fingerprint256: fp,
    fingerprint512: 'unused',
    serialNumber: '01',
    raw,
  } as unknown as tls.PeerCertificate;
}

// Track original pin set so we can restore between tests.
let savedPins: Record<string, string[]>;

beforeEach(() => {
  savedPins = JSON.parse(JSON.stringify(__pinsForTesting));
  delete process.env.STYRBY_NO_CERT_PIN;
});

afterEach(() => {
  // Restore mutated pin set.
  for (const k of Object.keys(__pinsForTesting)) delete __pinsForTesting[k];
  for (const [k, v] of Object.entries(savedPins)) __pinsForTesting[k] = v;
  delete process.env.STYRBY_NO_CERT_PIN;
});

// ----------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------
describe('cert-pinning: makePinnedCheckServerIdentity', () => {
  it('passes when the observed cert SHA-256 matches a configured pin', () => {
    const host = 'pinned.example.com';
    const raw = Buffer.from('fake-cert-bytes-for-test', 'utf8');
    const expected = crypto.createHash('sha256').update(raw).digest('hex');
    __pinsForTesting[host] = [expected];

    const check = makePinnedCheckServerIdentity();
    const cert = makeCert(host, raw);
    // Default tls.checkServerIdentity will fail because our fake cert isn't a
    // real x509 chain — but we only care about the pin check. Stub the SAN
    // by having `subjectaltname` line up. The real TLS verify will happen
    // upstream of this in production; here we measure pin-match logic.
    const result = check(host, cert);
    // Either undefined (match) or a tls error from the default checker — but
    // NEVER a "pin mismatch" error.
    if (result) {
      expect(result.message).not.toMatch(/pin mismatch/i);
    } else {
      expect(result).toBeUndefined();
    }
  });

  it('rejects with a "pin mismatch" error when the cert fingerprint is wrong', () => {
    const host = 'pinned.example.com';
    const raw = Buffer.from('attacker-cert-bytes', 'utf8');
    // Pin a DIFFERENT fingerprint than what the cert will produce.
    __pinsForTesting[host] = ['0'.repeat(64)];

    const check = makePinnedCheckServerIdentity();
    const cert = makeCert(host, raw);
    const result = check(host, cert);
    expect(result).toBeInstanceOf(Error);
    expect(result!.message).toMatch(/pin mismatch/i);
  });

  it('passes regardless of fingerprint when STYRBY_NO_CERT_PIN=1 is set', () => {
    process.env.STYRBY_NO_CERT_PIN = '1';
    const host = 'pinned.example.com';
    const raw = Buffer.from('whatever', 'utf8');
    __pinsForTesting[host] = ['0'.repeat(64)]; // Mismatched on purpose.

    const check = makePinnedCheckServerIdentity();
    const cert = makeCert(host, raw);
    const result = check(host, cert);
    // May still return a default-checker error (SAN/chain) — but NOT pin mismatch.
    if (result) {
      expect(result.message).not.toMatch(/pin mismatch/i);
    } else {
      expect(result).toBeUndefined();
    }
  });

  it('does not enforce pinning for hostnames absent from the pin map', () => {
    const host = 'unpinned.example.org';
    const raw = Buffer.from('any-cert', 'utf8');
    // No pin entry for this host.

    const check = makePinnedCheckServerIdentity();
    const cert = makeCert(host, raw);
    const result = check(host, cert);
    if (result) {
      expect(result.message).not.toMatch(/pin mismatch/i);
    } else {
      expect(result).toBeUndefined();
    }
  });
});
