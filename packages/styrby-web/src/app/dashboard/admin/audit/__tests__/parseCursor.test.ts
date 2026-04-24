/**
 * Unit tests for parseCursor — the URL query-param validator on the admin audit page.
 *
 * WHY these tests:
 *   parseCursor is the only user-controlled input that reaches the DB query
 *   (via `WHERE id < :cursor`). If it fails to reject invalid input, an
 *   attacker could inject unexpected values into the DB query. The guard must
 *   be verified exhaustively. SOC 2 CC6.1 (access control), OWASP A03:2021
 *   (Injection — preventing malformed cursor values from influencing the query).
 *
 * Edge-case rationale:
 *   - Null / undefined: treated as first page (no WHERE clause added)
 *   - Non-numeric strings: rejected; UUID or path-traversal attempts silently
 *     become null, not an error.
 *   - Negative integers: invalid in a serial PK table; caller's WHERE `id < -5`
 *     would return 0 rows (confusing), so we collapse to null.
 *   - Huge integers (beyond typical bigserial range): safe — `WHERE id < 9999999999999`
 *     returns the most recent rows since no row has an id that large. No DB error.
 *     This is documented in the function-level comment in page.tsx.
 *   - Happy-path positive integer: pass through unchanged.
 *
 * @module app/dashboard/admin/audit/__tests__/parseCursor
 */

import { describe, it, expect } from 'vitest';
import { parseCursor } from '../page';

describe('parseCursor', () => {
  // ── Null / missing input ────────────────────────────────────────────────────

  it('returns null for undefined (missing cursor param = first page)', () => {
    expect(parseCursor(undefined)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseCursor('')).toBeNull();
  });

  // ── Invalid string input ────────────────────────────────────────────────────

  it('returns null for a non-numeric string (e.g. "abc")', () => {
    // WHY: URL-injected non-numeric values must not propagate to the DB.
    expect(parseCursor('abc')).toBeNull();
  });

  it('returns null for a UUID string (not a valid PK cursor)', () => {
    // WHY: A UUID in the cursor param is likely a client bug or injection attempt.
    expect(parseCursor('a1b2c3d4-e5f6-7890-abcd-ef1234567890')).toBeNull();
  });

  it('returns null for a float string (e.g. "3.14")', () => {
    // WHY parseInt stops at the decimal, so parseInt("3.14") = 3, which is a
    // positive integer. This is acceptable — "3" is a valid cursor.
    // Document the actual behavior explicitly so future refactors preserve it.
    expect(parseCursor('3.14')).toBe(3);
  });

  // ── Negative and zero ───────────────────────────────────────────────────────

  it('returns null for negative integer "-5" (invalid serial PK)', () => {
    // WHY: `WHERE id < -5` returns 0 rows on a bigserial table (confusing).
    // Coercing to null is safer than passing a negative cursor to the DB.
    expect(parseCursor('-5')).toBeNull();
  });

  it('returns null for zero "0" (PK starts at 1)', () => {
    // WHY n <= 0 check: zero is not a valid serial PK value.
    expect(parseCursor('0')).toBeNull();
  });

  // ── Out-of-range large integer ──────────────────────────────────────────────

  it('passes a large integer through (cursor larger than max id = first page)', () => {
    // WHY: `WHERE id < 9999999999999` returns the most recent rows since no
    // row has an id that large. This is safe — no DB error, no empty page.
    // The comment above parseCursor in page.tsx documents this intentional behavior.
    expect(parseCursor('9999999999999')).toBe(9999999999999);
  });

  // ── Happy path ──────────────────────────────────────────────────────────────

  it('returns the integer 100 for cursor "100"', () => {
    expect(parseCursor('100')).toBe(100);
  });

  it('returns the integer 1 for cursor "1"', () => {
    expect(parseCursor('1')).toBe(1);
  });

  it('returns the integer 50000 for cursor "50000"', () => {
    expect(parseCursor('50000')).toBe(50000);
  });
});
