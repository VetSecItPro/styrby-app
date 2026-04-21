/**
 * Tests for `decodeEmailFromIdToken`.
 *
 * Covers happy path + every documented failure mode, since the helper
 * MUST never throw (used in best-effort enrichment).
 */
import { describe, it, expect } from 'vitest';
import { decodeEmailFromIdToken } from '@/gemini/utils/idTokenEmail';

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  // Signature segment is meaningless for decode-only.
  return `${header}.${body}.signaturepart`;
}

describe('decodeEmailFromIdToken', () => {
  it('returns email when payload contains a string email', () => {
    const token = makeJwt({ email: 'user@example.com', sub: '123' });
    expect(decodeEmailFromIdToken(token)).toBe('user@example.com');
  });

  it('returns undefined for undefined input', () => {
    expect(decodeEmailFromIdToken(undefined)).toBeUndefined();
  });

  it('returns undefined for null input', () => {
    expect(decodeEmailFromIdToken(null)).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(decodeEmailFromIdToken('')).toBeUndefined();
  });

  it('returns undefined when payload omits email claim', () => {
    const token = makeJwt({ sub: '123' });
    expect(decodeEmailFromIdToken(token)).toBeUndefined();
  });

  it('returns undefined when email claim is non-string', () => {
    const token = makeJwt({ email: 42 });
    expect(decodeEmailFromIdToken(token)).toBeUndefined();
  });

  it('returns undefined for a token with wrong segment count', () => {
    expect(decodeEmailFromIdToken('only.two')).toBeUndefined();
    expect(decodeEmailFromIdToken('a.b.c.d')).toBeUndefined();
  });

  it('returns undefined for malformed base64', () => {
    expect(decodeEmailFromIdToken('header.!!!notbase64!!!.sig')).toBeUndefined();
  });

  it('returns undefined when payload is not JSON', () => {
    const bogus = Buffer.from('not json {{{').toString('base64url');
    expect(decodeEmailFromIdToken(`h.${bogus}.s`)).toBeUndefined();
  });

  it('returns undefined when payload decodes to a non-object', () => {
    const arr = Buffer.from(JSON.stringify(['email', 'x'])).toString('base64url');
    expect(decodeEmailFromIdToken(`h.${arr}.s`)).toBeUndefined();
  });

  it('does not throw for non-string types passed at runtime', () => {
    // @ts-expect-error - exercising runtime guard
    expect(decodeEmailFromIdToken(42)).toBeUndefined();
    // @ts-expect-error
    expect(decodeEmailFromIdToken({})).toBeUndefined();
  });
});
