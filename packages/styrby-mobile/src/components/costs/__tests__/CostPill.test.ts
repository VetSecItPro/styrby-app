/**
 * CostPill — formatPillCost pure function tests
 *
 * Tests the formatPillCost helper for all four billing model branches.
 * We test the pure function (not the React Native component) to avoid the
 * complexity of React Native test renderer setup for what is fundamentally
 * a formatting logic test.
 *
 * WHY: formatPillCost is the single branching function for mobile cost display.
 * A regression here would silently show wrong values in session detail and the
 * billing model summary strip.
 *
 * @module components/costs/__tests__/CostPill.test
 */

import { formatPillCost } from '../CostPill';

// ---------------------------------------------------------------------------
// api-key
// ---------------------------------------------------------------------------

describe('formatPillCost — api-key', () => {
  it('formats a USD cost with 2 decimal places', () => {
    expect(formatPillCost({ billingModel: 'api-key', costUsd: 4.3 })).toBe('$4.30');
  });

  it('formats with custom decimals', () => {
    expect(formatPillCost({ billingModel: 'api-key', costUsd: 0.0042, decimals: 4 })).toBe('$0.0042');
  });

  it('formats zero cost', () => {
    expect(formatPillCost({ billingModel: 'api-key', costUsd: 0 })).toBe('$0.00');
  });
});

// ---------------------------------------------------------------------------
// subscription
// ---------------------------------------------------------------------------

describe('formatPillCost — subscription', () => {
  it('shows percentage when fractionUsed is provided', () => {
    expect(
      formatPillCost({ billingModel: 'subscription', costUsd: 0, subscriptionFractionUsed: 0.47 })
    ).toBe('47% quota');
  });

  it('rounds fraction to nearest integer', () => {
    expect(
      formatPillCost({ billingModel: 'subscription', costUsd: 0, subscriptionFractionUsed: 0.666 })
    ).toBe('67% quota');
  });

  it('returns "SUB" fallback when fractionUsed is null', () => {
    expect(
      formatPillCost({ billingModel: 'subscription', costUsd: 0, subscriptionFractionUsed: null })
    ).toBe('SUB');
  });

  it('returns "SUB" fallback when fractionUsed is undefined', () => {
    expect(formatPillCost({ billingModel: 'subscription', costUsd: 0 })).toBe('SUB');
  });

  it('shows 0% quota for zero fraction', () => {
    expect(
      formatPillCost({ billingModel: 'subscription', costUsd: 0, subscriptionFractionUsed: 0 })
    ).toBe('0% quota');
  });

  it('shows 100% quota for full consumption', () => {
    expect(
      formatPillCost({ billingModel: 'subscription', costUsd: 0, subscriptionFractionUsed: 1 })
    ).toBe('100% quota');
  });
});

// ---------------------------------------------------------------------------
// credit
// ---------------------------------------------------------------------------

describe('formatPillCost — credit', () => {
  it('shows credits + dollar amount when rate is provided', () => {
    expect(
      formatPillCost({
        billingModel: 'credit',
        costUsd: 4.3,
        creditsConsumed: 430,
        creditRateUsd: 0.01,
      })
    ).toBe('430 cr ($4.30)');
  });

  it('falls back to costUsd when creditRateUsd is absent', () => {
    expect(
      formatPillCost({ billingModel: 'credit', costUsd: 2.0, creditsConsumed: 200 })
    ).toBe('200 cr ($2.00)');
  });

  it('shows only credits when cost is zero and rate is zero', () => {
    expect(
      formatPillCost({
        billingModel: 'credit',
        costUsd: 0,
        creditsConsumed: 100,
        creditRateUsd: 0,
      })
    ).toBe('100 cr');
  });

  it('shows "0 cr" when creditsConsumed is null and cost is zero', () => {
    expect(
      formatPillCost({ billingModel: 'credit', costUsd: 0, creditsConsumed: null })
    ).toBe('0 cr');
  });
});

// ---------------------------------------------------------------------------
// free
// ---------------------------------------------------------------------------

describe('formatPillCost — free', () => {
  it('always shows $0.00', () => {
    expect(formatPillCost({ billingModel: 'free', costUsd: 0 })).toBe('$0.00');
  });

  it('respects custom decimal places', () => {
    expect(formatPillCost({ billingModel: 'free', costUsd: 0, decimals: 4 })).toBe('$0.0000');
  });
});
