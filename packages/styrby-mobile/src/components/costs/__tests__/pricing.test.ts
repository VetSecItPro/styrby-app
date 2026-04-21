/**
 * Tests for the costs/pricing pure helpers.
 *
 * WHY: These helpers gate how cost values render across the screen.
 * A regression that turned $0.0042 into "$0.00" would be invisible to a
 * snapshot test, so we lock the contract here with explicit boundary cases.
 *
 * @module components/costs/__tests__/pricing
 */

import { formatPricePer1M, formatBudgetCost } from '../pricing';

describe('formatPricePer1M', () => {
  it('renders 3 decimals for sub-cent prices', () => {
    expect(formatPricePer1M(0.005)).toBe('$0.005');
    expect(formatPricePer1M(0.001)).toBe('$0.001');
  });

  it('renders 3 decimals for sub-dollar prices', () => {
    expect(formatPricePer1M(0.075)).toBe('$0.075');
    expect(formatPricePer1M(0.5)).toBe('$0.500');
  });

  it('renders 2 decimals for prices >= $1', () => {
    expect(formatPricePer1M(1)).toBe('$1.00');
    expect(formatPricePer1M(3)).toBe('$3.00');
    expect(formatPricePer1M(15)).toBe('$15.00');
  });

  it('handles zero', () => {
    expect(formatPricePer1M(0)).toBe('$0.000');
  });
});

describe('formatBudgetCost', () => {
  it('returns "$0.00" exactly for zero', () => {
    expect(formatBudgetCost(0)).toBe('$0.00');
  });

  it('uses 4 decimals for sub-cent values', () => {
    expect(formatBudgetCost(0.0042)).toBe('$0.0042');
    expect(formatBudgetCost(0.001)).toBe('$0.0010');
  });

  it('uses 3 decimals for sub-dollar values', () => {
    expect(formatBudgetCost(0.123)).toBe('$0.123');
    expect(formatBudgetCost(0.5)).toBe('$0.500');
  });

  it('uses 2 decimals for >= $1', () => {
    expect(formatBudgetCost(1)).toBe('$1.00');
    expect(formatBudgetCost(12.345)).toBe('$12.35');
    expect(formatBudgetCost(1000)).toBe('$1000.00');
  });
});
