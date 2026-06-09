/**
 * Tests for Device ID Utilities
 *
 * Verifies UUID generation uniqueness, format correctness, and
 * the isValidDeviceId guard function.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { generateDeviceId, isValidDeviceId } from '../../src/session-handoff/device-id';

// UUID canonical format regex (any version)
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('generateDeviceId', () => {
  it('returns a string in canonical UUID hyphenated format', () => {
    const id = generateDeviceId();
    expect(id).toMatch(UUID_REGEX);
  });

  it('returns a unique value on each call', () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateDeviceId()));
    // All 50 should be unique (collision probability ~0 with 122 random bits)
    expect(ids.size).toBe(50);
  });

  it('returns a 36-character string', () => {
    expect(generateDeviceId()).toHaveLength(36);
  });

  it('sorts chronologically by timestamp (UUID v7 time-ordering)', () => {
    // Regression: a prior impl placed the timestamp bytes incorrectly and
    // truncated via 32-bit shift, so IDs did NOT sort by creation time.
    // Increasing timestamps must produce lexicographically increasing IDs,
    // including across the 32-bit boundary in the 48-bit ms field.
    const nowSpy = vi.spyOn(Date, 'now');
    const timestamps = [
      0x0000_0000_0001, // tiny
      0x0000_ffff_ffff, // just below 2^32
      0x0001_0000_0000, // just above 2^32 (would break under a 32-bit shift)
      0x0001_0000_0001,
      0x018f_1234_5678, // a realistic 2026-era ms timestamp
      0x018f_1234_5679,
    ];

    const ids = timestamps.map((ts) => {
      nowSpy.mockReturnValue(ts);
      return generateDeviceId();
    });

    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);

    // First group (top 32 timestamp bits) must be strictly non-decreasing.
    const prefixes = ids.map((id) => id.slice(0, 13)); // time_high + '-' + time_low
    expect([...prefixes].sort()).toEqual(prefixes);

    nowSpy.mockRestore();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isValidDeviceId', () => {
  it('returns true for a valid UUID from generateDeviceId', () => {
    expect(isValidDeviceId(generateDeviceId())).toBe(true);
  });

  it('returns true for a canonical UUID v4', () => {
    expect(isValidDeviceId('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
  });

  it('returns false for an empty string', () => {
    expect(isValidDeviceId('')).toBe(false);
  });

  it('returns false for a string with path-traversal characters', () => {
    expect(isValidDeviceId('../../etc/passwd')).toBe(false);
  });

  it('returns false for a UUID with wrong segment lengths', () => {
    // Missing one hex char in last segment
    expect(isValidDeviceId('550e8400-e29b-41d4-a716-44665544000')).toBe(false);
  });

  it('returns false for a non-UUID alphanumeric string', () => {
    expect(isValidDeviceId('notauuid')).toBe(false);
  });
});
