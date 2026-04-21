/**
 * Tests for the urlBase64ToUint8Array pure helper.
 *
 * WHY: This helper decodes VAPID public keys for the Web Push API. A bug
 * here silently breaks push subscription for every browser, and the symptom
 * is subtle (server-side push fails with InvalidSignature). Unit coverage
 * keeps the padding + url-safe character handling pinned.
 */

import { describe, it, expect } from 'vitest';
import { urlBase64ToUint8Array } from '../utils';

describe('urlBase64ToUint8Array', () => {
  it('decodes a standard base64url string with no padding', () => {
    // "Hello" => base64 "SGVsbG8=" => base64url "SGVsbG8"
    const out = urlBase64ToUint8Array('SGVsbG8');
    expect(Array.from(out)).toEqual([72, 101, 108, 108, 111]);
  });

  it('handles url-safe characters ( - and _ ) by substituting to + and /', () => {
    // "-_-_" => base64 "+/+/" => bytes [0xfb, 0xff, 0xbf]
    const out = urlBase64ToUint8Array('-_-_');
    expect(Array.from(out)).toEqual([0xfb, 0xff, 0xbf]);
  });

  it('pads inputs whose length is not a multiple of 4', () => {
    // "Hi" => base64 "SGk=" => base64url "SGk" (no padding)
    const out = urlBase64ToUint8Array('SGk');
    expect(Array.from(out)).toEqual([72, 105]);
  });

  it('returns an empty Uint8Array for an empty input', () => {
    const out = urlBase64ToUint8Array('');
    expect(out.length).toBe(0);
  });
});
