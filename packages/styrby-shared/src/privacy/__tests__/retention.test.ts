/**
 * Unit tests for privacy/retention utilities.
 *
 * WHY: These helpers are used in three places — the Postgres cron (PL/pgSQL),
 * the server-side API, and the mobile/web UI. Any drift in the TypeScript
 * version from the SQL version is a compliance defect (GDPR Art. 5(1)(e)).
 * These tests lock the TypeScript behaviour so refactors cannot silently
 * diverge from the SQL reference implementation in migration 025.
 *
 * Audit: GDPR Art. 5(1)(e) — storage limitation; SOC2 CC7.2
 */

import { describe, it, expect } from 'vitest';
import {
  resolveSessionRetentionDays,
  computeSessionExpiryDate,
  retentionDaysLabel,
  ALLOWED_RETENTION_DAYS,
  RETENTION_OVERRIDE_PATTERN,
} from '../retention.js';

// ============================================================================
// resolveSessionRetentionDays
// ============================================================================

describe('resolveSessionRetentionDays', () => {
  describe('pin_forever override', () => {
    it('returns null regardless of profile retention', () => {
      expect(resolveSessionRetentionDays('pin_forever', 30)).toBeNull();
      expect(resolveSessionRetentionDays('pin_forever', 365)).toBeNull();
      expect(resolveSessionRetentionDays('pin_forever', null)).toBeNull();
      expect(resolveSessionRetentionDays('pin_forever', 7)).toBeNull();
    });
  });

  describe('pin_days overrides', () => {
    it('returns 7 for pin_days:7 regardless of profile', () => {
      expect(resolveSessionRetentionDays('pin_days:7', 30)).toBe(7);
      expect(resolveSessionRetentionDays('pin_days:7', null)).toBe(7);
      expect(resolveSessionRetentionDays('pin_days:7', 365)).toBe(7);
    });

    it('returns 30 for pin_days:30 regardless of profile', () => {
      expect(resolveSessionRetentionDays('pin_days:30', 7)).toBe(30);
      expect(resolveSessionRetentionDays('pin_days:30', null)).toBe(30);
    });

    it('returns 90 for pin_days:90', () => {
      expect(resolveSessionRetentionDays('pin_days:90', 7)).toBe(90);
    });

    it('returns 365 for pin_days:365', () => {
      expect(resolveSessionRetentionDays('pin_days:365', 7)).toBe(365);
    });
  });

  describe('inherit (falls back to profile)', () => {
    it('returns profile retention_days when override is inherit', () => {
      expect(resolveSessionRetentionDays('inherit', 30)).toBe(30);
      expect(resolveSessionRetentionDays('inherit', 7)).toBe(7);
      expect(resolveSessionRetentionDays('inherit', 365)).toBe(365);
    });

    it('returns null when inherit and profile is null (never delete)', () => {
      expect(resolveSessionRetentionDays('inherit', null)).toBeNull();
    });
  });

  describe('null / undefined override (treat as inherit)', () => {
    it('returns profile retention when override is null', () => {
      expect(resolveSessionRetentionDays(null, 30)).toBe(30);
    });

    it('returns profile retention when override is undefined', () => {
      expect(resolveSessionRetentionDays(undefined, 90)).toBe(90);
    });

    it('returns null when override is null and profile is null', () => {
      expect(resolveSessionRetentionDays(null, null)).toBeNull();
    });
  });

  describe('mirrors PL/pgSQL examples from migration 025 docstring', () => {
    // These exact examples are in the SQL function comment — keeping them
    // here makes it obvious when TypeScript and SQL diverge.
    it("resolveSessionRetentionDays('inherit', 30) === 30", () => {
      expect(resolveSessionRetentionDays('inherit', 30)).toBe(30);
    });

    it("resolveSessionRetentionDays('pin_forever', 30) === null", () => {
      expect(resolveSessionRetentionDays('pin_forever', 30)).toBeNull();
    });

    it("resolveSessionRetentionDays('pin_days:7', 90) === 7", () => {
      expect(resolveSessionRetentionDays('pin_days:7', 90)).toBe(7);
    });

    it("resolveSessionRetentionDays('inherit', null) === null", () => {
      expect(resolveSessionRetentionDays('inherit', null)).toBeNull();
    });
  });
});

// ============================================================================
// computeSessionExpiryDate
// ============================================================================

describe('computeSessionExpiryDate', () => {
  it('returns null when retentionDays is null', () => {
    expect(computeSessionExpiryDate('2026-01-01T00:00:00Z', null)).toBeNull();
  });

  it('adds correct number of days to session start', () => {
    const result = computeSessionExpiryDate('2026-01-01T00:00:00Z', 30);
    expect(result).toBeInstanceOf(Date);
    expect(result!.toISOString().startsWith('2026-01-31')).toBe(true);
  });

  it('handles 7-day window', () => {
    const result = computeSessionExpiryDate('2026-04-01T00:00:00Z', 7);
    expect(result!.toISOString().startsWith('2026-04-08')).toBe(true);
  });

  it('handles 365-day window (1 year)', () => {
    const result = computeSessionExpiryDate('2026-01-01T00:00:00Z', 365);
    expect(result!.toISOString().startsWith('2027-01-01')).toBe(true);
  });

  it('handles month-end rollover (Jan 31 + 30 days = Mar 2 UTC)', () => {
    const result = computeSessionExpiryDate('2026-01-31T00:00:00Z', 30);
    // Jan 31 + 30 days = March 2 UTC (non-leap year 2026; Feb has 28 days)
    // WHY use getUTCMonth/getUTCDate: the input is midnight UTC so expiry is
    // also midnight UTC. Using local-time getters would produce wrong results
    // in timezones west of UTC (e.g. CT is UTC-5, shifts date back by a day).
    expect(result!.getUTCMonth()).toBe(2); // 0-indexed: 2 = March
    expect(result!.getUTCDate()).toBe(2);
  });

  it('throws on invalid ISO 8601 timestamp', () => {
    expect(() => computeSessionExpiryDate('not-a-date', 30)).toThrow(
      'Invalid session started_at',
    );
  });

  it('matches the JSDoc example exactly', () => {
    // @example computeSessionExpiryDate('2026-01-01T00:00:00Z', 30) => Date('2026-01-31T00:00:00Z')
    const result = computeSessionExpiryDate('2026-01-01T00:00:00Z', 30);
    expect(result!.toISOString()).toBe('2026-01-31T00:00:00.000Z');
  });
});

// ============================================================================
// retentionDaysLabel
// ============================================================================

describe('retentionDaysLabel', () => {
  it('returns "Never" for null', () => {
    expect(retentionDaysLabel(null)).toBe('Never');
  });

  it('returns "7 days" for 7', () => {
    expect(retentionDaysLabel(7)).toBe('7 days');
  });

  it('returns "30 days" for 30', () => {
    expect(retentionDaysLabel(30)).toBe('30 days');
  });

  it('returns "90 days" for 90', () => {
    expect(retentionDaysLabel(90)).toBe('90 days');
  });

  it('returns "1 year" for 365 (not "365 days")', () => {
    expect(retentionDaysLabel(365)).toBe('1 year');
  });
});

// ============================================================================
// ALLOWED_RETENTION_DAYS constant
// ============================================================================

describe('ALLOWED_RETENTION_DAYS', () => {
  it('contains exactly [7, 30, 90, 365]', () => {
    expect([...ALLOWED_RETENTION_DAYS]).toEqual([7, 30, 90, 365]);
  });

  it('does not include arbitrary values like 45 or 180', () => {
    expect(ALLOWED_RETENTION_DAYS).not.toContain(45);
    expect(ALLOWED_RETENTION_DAYS).not.toContain(180);
  });
});

// ============================================================================
// RETENTION_OVERRIDE_PATTERN
// ============================================================================

describe('RETENTION_OVERRIDE_PATTERN', () => {
  it('matches "inherit"', () => {
    expect(RETENTION_OVERRIDE_PATTERN.test('inherit')).toBe(true);
  });

  it('matches "pin_forever"', () => {
    expect(RETENTION_OVERRIDE_PATTERN.test('pin_forever')).toBe(true);
  });

  it('matches all pin_days variants', () => {
    expect(RETENTION_OVERRIDE_PATTERN.test('pin_days:7')).toBe(true);
    expect(RETENTION_OVERRIDE_PATTERN.test('pin_days:30')).toBe(true);
    expect(RETENTION_OVERRIDE_PATTERN.test('pin_days:90')).toBe(true);
    expect(RETENTION_OVERRIDE_PATTERN.test('pin_days:365')).toBe(true);
  });

  it('rejects arbitrary day counts', () => {
    expect(RETENTION_OVERRIDE_PATTERN.test('pin_days:45')).toBe(false);
    expect(RETENTION_OVERRIDE_PATTERN.test('pin_days:180')).toBe(false);
    expect(RETENTION_OVERRIDE_PATTERN.test('pin_days:0')).toBe(false);
  });

  it('rejects empty string and garbage values', () => {
    expect(RETENTION_OVERRIDE_PATTERN.test('')).toBe(false);
    expect(RETENTION_OVERRIDE_PATTERN.test('DELETE')).toBe(false);
    expect(RETENTION_OVERRIDE_PATTERN.test('forever')).toBe(false);
  });

  it('rejects partial matches (must be exact)', () => {
    // WHY: If the DB receives 'pin_days:7_extra', that would bypass the
    // Postgres CHECK constraint on new rows but could appear from a
    // compromised client. The regex must reject it.
    expect(RETENTION_OVERRIDE_PATTERN.test('pin_days:7_extra')).toBe(false);
    expect(RETENTION_OVERRIDE_PATTERN.test(' inherit')).toBe(false);
  });
});
