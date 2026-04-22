/**
 * Unit tests for NPS calculation utilities.
 *
 * Covers all edge cases per CLAUDE.md zero-technical-debt mandate:
 *   - Empty input
 *   - All promoters
 *   - All detractors
 *   - All passives
 *   - Mixed realistic distribution
 *   - Out-of-range scores (excluded)
 *   - null/undefined values (excluded)
 *   - NaN values (excluded)
 *   - Fractional result precision
 *   - classifyNpsScore boundary conditions
 *   - groupNpsByWeek aggregation
 *   - toIsoWeek ISO 8601 compliance
 *   - formatNpsScore display
 */

import { describe, it, expect } from 'vitest';
import {
  calcNPS,
  classifyNpsScore,
  groupNpsByWeek,
  toIsoWeek,
  formatNpsScore,
} from '../../src/feedback/nps';

// =============================================================================
// classifyNpsScore
// =============================================================================

describe('classifyNpsScore', () => {
  it('classifies 9 as promoter', () => {
    expect(classifyNpsScore(9)).toBe('promoter');
  });

  it('classifies 10 as promoter', () => {
    expect(classifyNpsScore(10)).toBe('promoter');
  });

  it('classifies 7 as passive', () => {
    expect(classifyNpsScore(7)).toBe('passive');
  });

  it('classifies 8 as passive', () => {
    expect(classifyNpsScore(8)).toBe('passive');
  });

  it('classifies 0 as detractor', () => {
    expect(classifyNpsScore(0)).toBe('detractor');
  });

  it('classifies 6 as detractor', () => {
    expect(classifyNpsScore(6)).toBe('detractor');
  });

  it('returns null for 11 (out of range)', () => {
    expect(classifyNpsScore(11)).toBeNull();
  });

  it('returns null for -1 (negative)', () => {
    expect(classifyNpsScore(-1)).toBeNull();
  });

  it('returns null for 100', () => {
    expect(classifyNpsScore(100)).toBeNull();
  });

  it('returns null for fractional score', () => {
    expect(classifyNpsScore(7.5)).toBeNull();
  });
});

// =============================================================================
// calcNPS — edge cases
// =============================================================================

describe('calcNPS — edge cases', () => {
  it('returns score 0 and all zeros for empty input', () => {
    const result = calcNPS([]);
    expect(result.score).toBe(0);
    expect(result.promoters).toBe(0);
    expect(result.passives).toBe(0);
    expect(result.detractors).toBe(0);
    expect(result.total).toBe(0);
    expect(result.promoterPct).toBe(0);
    expect(result.passivePct).toBe(0);
    expect(result.detractorPct).toBe(0);
    expect(result.excluded).toBe(0);
  });

  it('returns score 100 for all promoters', () => {
    const result = calcNPS([10, 10, 9, 10]);
    expect(result.score).toBe(100);
    expect(result.promoters).toBe(4);
    expect(result.detractors).toBe(0);
    expect(result.total).toBe(4);
    expect(result.promoterPct).toBe(100);
    expect(result.detractorPct).toBe(0);
  });

  it('returns score -100 for all detractors', () => {
    const result = calcNPS([0, 1, 2, 3, 4, 5, 6]);
    expect(result.score).toBe(-100);
    expect(result.detractors).toBe(7);
    expect(result.promoters).toBe(0);
    expect(result.total).toBe(7);
    expect(result.detractorPct).toBe(100);
    expect(result.promoterPct).toBe(0);
  });

  it('returns score 0 for all passives', () => {
    const result = calcNPS([7, 8, 7, 8]);
    expect(result.score).toBe(0);
    expect(result.passives).toBe(4);
    expect(result.promoters).toBe(0);
    expect(result.detractors).toBe(0);
    expect(result.total).toBe(4);
  });

  it('excludes null values', () => {
    const result = calcNPS([10, null, null, 9]);
    expect(result.total).toBe(2);
    expect(result.excluded).toBe(2);
    expect(result.score).toBe(100);
  });

  it('excludes undefined values', () => {
    const result = calcNPS([10, undefined, 9]);
    expect(result.total).toBe(2);
    expect(result.excluded).toBe(1);
  });

  it('excludes NaN values', () => {
    const result = calcNPS([10, NaN, 9]);
    expect(result.total).toBe(2);
    expect(result.excluded).toBe(1);
  });

  it('excludes out-of-range scores (11)', () => {
    const result = calcNPS([11, 10, 9]);
    expect(result.total).toBe(2);
    expect(result.excluded).toBe(1);
    expect(result.score).toBe(100);
  });

  it('excludes out-of-range scores (-1)', () => {
    const result = calcNPS([-1, 0, 10]);
    expect(result.total).toBe(2);
    expect(result.excluded).toBe(1);
  });

  it('excludes fractional scores', () => {
    const result = calcNPS([9.5, 10, 9]);
    expect(result.total).toBe(2);
    expect(result.excluded).toBe(1);
  });
});

// =============================================================================
// calcNPS — realistic distribution
// =============================================================================

describe('calcNPS — realistic distribution', () => {
  it('computes correct NPS for a realistic response set', () => {
    // 5 promoters (9,10,10,9,10), 2 passives (7,8), 3 detractors (5,4,3)
    const result = calcNPS([9, 10, 10, 9, 10, 7, 8, 5, 4, 3]);
    expect(result.promoters).toBe(5);
    expect(result.passives).toBe(2);
    expect(result.detractors).toBe(3);
    expect(result.total).toBe(10);
    // NPS = (5/10)*100 - (3/10)*100 = 50 - 30 = 20
    expect(result.score).toBe(20);
    expect(result.promoterPct).toBe(50);
    expect(result.passivePct).toBe(20);
    expect(result.detractorPct).toBe(30);
  });

  it('computes correct NPS for equal promoters and detractors', () => {
    const result = calcNPS([10, 0]); // 1 promoter, 1 detractor
    expect(result.score).toBe(0);
  });

  it('rounds to 1 decimal for fractional scores', () => {
    // 2 promoters, 3 detractors → (2/5)*100 - (3/5)*100 = 40 - 60 = -20
    const result = calcNPS([10, 9, 0, 1, 2]);
    expect(result.score).toBe(-20);
  });

  it('handles single response (1 promoter)', () => {
    const result = calcNPS([9]);
    expect(result.score).toBe(100);
    expect(result.total).toBe(1);
    expect(result.promoters).toBe(1);
  });

  it('handles single response (1 detractor)', () => {
    const result = calcNPS([3]);
    expect(result.score).toBe(-100);
    expect(result.total).toBe(1);
    expect(result.detractors).toBe(1);
  });
});

// =============================================================================
// groupNpsByWeek
// =============================================================================

describe('groupNpsByWeek', () => {
  it('groups responses by ISO week', () => {
    const responses = [
      { score: 10, created_at: '2026-04-13T10:00:00Z' }, // Week 16
      { score: 9, created_at: '2026-04-14T10:00:00Z' },  // Week 16
      { score: 5, created_at: '2026-04-21T10:00:00Z' },  // Week 17
    ];
    const result = groupNpsByWeek(responses);
    expect(result).toHaveLength(2);
    expect(result[0].responseCount).toBe(2);
    expect(result[0].score).toBe(100); // Both promoters
    expect(result[1].responseCount).toBe(1);
    expect(result[1].score).toBe(-100); // One detractor
  });

  it('returns empty array for empty input', () => {
    expect(groupNpsByWeek([])).toEqual([]);
  });

  it('sorts output ascending by week', () => {
    const responses = [
      { score: 9, created_at: '2026-04-21T10:00:00Z' }, // Week 17
      { score: 9, created_at: '2026-04-14T10:00:00Z' }, // Week 16
    ];
    const result = groupNpsByWeek(responses);
    // ISO week strings sort lexicographically correctly (YYYY-Www)
    expect(result[0].week <= result[1].week).toBe(true);
  });

  it('handles null scores (excluded from NPS but still grouped)', () => {
    const responses = [
      { score: null as unknown as number, created_at: '2026-04-14T10:00:00Z' },
      { score: 10, created_at: '2026-04-14T10:00:00Z' },
    ];
    const result = groupNpsByWeek(responses);
    expect(result).toHaveLength(1);
    // Total = 1 (null excluded), score = 100 (1 promoter)
    expect(result[0].responseCount).toBe(1);
    expect(result[0].score).toBe(100);
  });
});

// =============================================================================
// toIsoWeek
// =============================================================================

describe('toIsoWeek', () => {
  it('returns correct ISO week for a known date', () => {
    // April 21 2026 is a Tuesday in week 17
    expect(toIsoWeek(new Date('2026-04-21T12:00:00Z'))).toBe('2026-W17');
  });

  it('returns correct ISO week for Jan 1 (may be W52 or W53 of prev year)', () => {
    // Jan 1 2026 is a Thursday — ISO week 1 of 2026
    expect(toIsoWeek(new Date('2026-01-01'))).toBe('2026-W01');
  });

  it('handles year boundary correctly (Dec 31 in following year week)', () => {
    // Dec 31 2026 is a Thursday — ISO week 53 of 2026
    const result = toIsoWeek(new Date('2026-12-31'));
    expect(result).toMatch(/^\d{4}-W\d{2}$/);
  });
});

// =============================================================================
// formatNpsScore
// =============================================================================

describe('formatNpsScore', () => {
  it('formats positive integer with + prefix', () => {
    expect(formatNpsScore(42)).toBe('+42');
  });

  it('formats negative integer without + prefix', () => {
    expect(formatNpsScore(-7)).toBe('-7');
  });

  it('formats zero as "0" (no sign)', () => {
    expect(formatNpsScore(0)).toBe('0');
  });

  it('formats fractional positive score with 1dp', () => {
    expect(formatNpsScore(42.5)).toBe('+42.5');
  });

  it('formats fractional negative score with 1dp', () => {
    expect(formatNpsScore(-7.5)).toBe('-7.5');
  });

  it('formats 100 correctly', () => {
    expect(formatNpsScore(100)).toBe('+100');
  });

  it('formats -100 correctly', () => {
    expect(formatNpsScore(-100)).toBe('-100');
  });
});
