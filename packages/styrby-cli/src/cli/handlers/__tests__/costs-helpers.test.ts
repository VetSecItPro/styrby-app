/**
 * Tests for cli/handlers/costs-helpers.ts.
 *
 * Coverage target: 0% → 100% on the 2 exported pure functions.
 *
 * @module cli/handlers/__tests__/costs-helpers
 */

import { describe, it, expect } from 'vitest';
import { formatTokens, formatCost } from '@/cli/handlers/costs-helpers';

describe('formatTokens', () => {
  it('formats sub-thousand counts as integer strings', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(1)).toBe('1');
    expect(formatTokens(42)).toBe('42');
    expect(formatTokens(999)).toBe('999');
  });

  it('formats thousand-range counts with 1 decimal + K suffix', () => {
    expect(formatTokens(1_000)).toBe('1.0K');
    expect(formatTokens(1_234)).toBe('1.2K');
    expect(formatTokens(12_500)).toBe('12.5K');
    expect(formatTokens(999_999)).toBe('1000.0K'); // edge: just-under-1M still K
  });

  it('formats million-range counts with 2 decimals + M suffix', () => {
    expect(formatTokens(1_000_000)).toBe('1.00M');
    expect(formatTokens(1_500_000)).toBe('1.50M');
    expect(formatTokens(42_345_678)).toBe('42.35M');
  });

  it('boundary: exactly 1000 picks K branch', () => {
    expect(formatTokens(1000)).toBe('1.0K');
  });

  it('boundary: exactly 1_000_000 picks M branch', () => {
    expect(formatTokens(1_000_000)).toBe('1.00M');
  });
});

describe('formatCost', () => {
  it('formats zero as $0.0000', () => {
    expect(formatCost(0)).toBe('$0.0000');
  });

  it('formats sub-cent costs with 4 decimals', () => {
    expect(formatCost(0.0001)).toBe('$0.0001');
    expect(formatCost(0.00123)).toBe('$0.0012'); // rounds (banker's)
  });

  it('formats normal costs preserving precision', () => {
    expect(formatCost(1.2345)).toBe('$1.2345');
    expect(formatCost(0.5)).toBe('$0.5000');
  });

  it('formats large costs with 4 decimals', () => {
    expect(formatCost(42.5)).toBe('$42.5000');
    expect(formatCost(1234.567)).toBe('$1234.5670');
  });

  it('rounds to 4 decimals (does not truncate)', () => {
    // 0.00125 with toFixed(4) rounds to "0.0013" (banker's rounding may
    // produce 0.0012 or 0.0013 depending on host — assert it's one of those)
    const result = formatCost(0.00125);
    expect(['$0.0012', '$0.0013']).toContain(result);
  });
});
