/**
 * Tests for the OTEL auth-headers parser (Cluster A2 split).
 *
 * WHY: parseHeaders feeds both the env-var preview and the save-time validation
 * gate. The "empty vs malformed" distinction (both return {}) is relied on by
 * the save handler, so it must be pinned. Also guards the array-rejection fix.
 *
 * @module components/dashboard/otel-settings/__tests__/parse-headers
 */

import { describe, it, expect } from 'vitest';
import { parseHeaders } from '../parse-headers';

describe('parseHeaders', () => {
  it('returns {} for empty / whitespace input', () => {
    expect(parseHeaders('')).toEqual({});
    expect(parseHeaders('   \n ')).toEqual({});
  });

  it('parses a valid JSON object of headers', () => {
    expect(parseHeaders('{"Authorization": "Bearer abc"}')).toEqual({
      Authorization: 'Bearer abc',
    });
  });

  it('returns {} for malformed JSON (validation surfaces the error)', () => {
    expect(parseHeaders('{not json}')).toEqual({});
    expect(parseHeaders('{"a":')).toEqual({});
  });

  it('rejects a JSON array (an array is not a valid headers object)', () => {
    // WHY: the pre-split inline parser accepted arrays (typeof [] === "object"),
    // which would pass the save-gate's Object.keys().length check with bogus
    // data. The Array.isArray guard closes that.
    expect(parseHeaders('["a", "b"]')).toEqual({});
  });

  it('returns {} for a JSON primitive (not an object)', () => {
    expect(parseHeaders('42')).toEqual({});
    expect(parseHeaders('"just a string"')).toEqual({});
    expect(parseHeaders('null')).toEqual({});
  });
});
