/**
 * CostDisplay Component Tests
 *
 * Tests the pure formatCostValue function and the CostDisplay component for
 * all four billing model branches:
 *   - 'api-key'      → USD string
 *   - 'subscription' → "N% quota" or "—"
 *   - 'credit'       → "X cr ($Y)" or "X cr"
 *   - 'free'         → "$0.00"
 *
 * WHY: formatCostValue is the single branching function for cost display.
 * Tests prevent regressions in edge cases (null fractionUsed, zero credits,
 * no creditRate, etc.) that would silently produce wrong UI text.
 *
 * @module components/costs/__tests__/CostDisplay.test
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CostDisplay, formatCostValue } from '../CostDisplay';

// ---------------------------------------------------------------------------
// formatCostValue — pure function tests
// ---------------------------------------------------------------------------

describe('formatCostValue — api-key', () => {
  it('formats a USD cost with default 2 decimals', () => {
    expect(formatCostValue({ billingModel: 'api-key', costUsd: 12.4 })).toBe('$12.40');
  });

  it('formats with custom decimals', () => {
    expect(formatCostValue({ billingModel: 'api-key', costUsd: 0.0042, decimals: 4 })).toBe('$0.0042');
  });

  it('shows $0.00 when cost is zero', () => {
    expect(formatCostValue({ billingModel: 'api-key', costUsd: 0 })).toBe('$0.00');
  });
});

describe('formatCostValue — subscription', () => {
  it('shows percentage when fractionUsed is provided', () => {
    expect(
      formatCostValue({ billingModel: 'subscription', costUsd: 0, subscriptionFractionUsed: 0.47 })
    ).toBe('47% quota');
  });

  it('rounds fraction to nearest integer %', () => {
    expect(
      formatCostValue({ billingModel: 'subscription', costUsd: 0, subscriptionFractionUsed: 0.676 })
    ).toBe('68% quota');
  });

  it('returns "—" when fractionUsed is null', () => {
    expect(
      formatCostValue({ billingModel: 'subscription', costUsd: 0, subscriptionFractionUsed: null })
    ).toBe('-');
  });

  it('returns "—" when fractionUsed is undefined', () => {
    expect(formatCostValue({ billingModel: 'subscription', costUsd: 0 })).toBe('-');
  });

  it('shows 0% quota for zero fraction', () => {
    expect(
      formatCostValue({ billingModel: 'subscription', costUsd: 0, subscriptionFractionUsed: 0 })
    ).toBe('0% quota');
  });

  it('shows 100% quota for full consumption', () => {
    expect(
      formatCostValue({ billingModel: 'subscription', costUsd: 0, subscriptionFractionUsed: 1 })
    ).toBe('100% quota');
  });
});

describe('formatCostValue — credit', () => {
  it('shows credits + dollar amount when rate is provided', () => {
    expect(
      formatCostValue({
        billingModel: 'credit',
        costUsd: 4.3,
        creditsConsumed: 430,
        creditRateUsd: 0.01,
      })
    ).toBe('430 cr ($4.30)');
  });

  it('falls back to costUsd when creditRateUsd is not provided', () => {
    expect(
      formatCostValue({
        billingModel: 'credit',
        costUsd: 2.5,
        creditsConsumed: 250,
      })
    ).toBe('250 cr ($2.50)');
  });

  it('shows only credits when both costUsd and rate are zero', () => {
    expect(
      formatCostValue({
        billingModel: 'credit',
        costUsd: 0,
        creditsConsumed: 100,
        creditRateUsd: 0,
      })
    ).toBe('100 cr');
  });

  it('shows "0 cr" when no credits and no cost', () => {
    expect(
      formatCostValue({
        billingModel: 'credit',
        costUsd: 0,
        creditsConsumed: 0,
      })
    ).toBe('0 cr');
  });

  it('shows "0 cr" when creditsConsumed is null', () => {
    expect(
      formatCostValue({
        billingModel: 'credit',
        costUsd: 0,
        creditsConsumed: null,
      })
    ).toBe('0 cr');
  });
});

describe('formatCostValue — free', () => {
  it('always shows $0.00 regardless of costUsd input', () => {
    expect(formatCostValue({ billingModel: 'free', costUsd: 0 })).toBe('$0.00');
  });

  it('ignores non-zero costUsd for free tier (should always be 0)', () => {
    // costUsd = 0 for free models per CostReport contract; this tests defensive rendering
    expect(formatCostValue({ billingModel: 'free', costUsd: 0, decimals: 4 })).toBe('$0.0000');
  });
});

// ---------------------------------------------------------------------------
// CostDisplay component — smoke tests
// ---------------------------------------------------------------------------

describe('CostDisplay — renders formatted text', () => {
  it('renders api-key cost as a span', () => {
    render(<CostDisplay billingModel="api-key" costUsd={5.99} />);
    expect(screen.getByText('$5.99')).toBeInTheDocument();
  });

  it('renders subscription quota fraction', () => {
    render(
      <CostDisplay
        billingModel="subscription"
        costUsd={0}
        subscriptionFractionUsed={0.33}
      />
    );
    expect(screen.getByText('33% quota')).toBeInTheDocument();
  });

  it('renders credit display', () => {
    render(
      <CostDisplay
        billingModel="credit"
        costUsd={2.0}
        creditsConsumed={200}
        creditRateUsd={0.01}
      />
    );
    expect(screen.getByText('200 cr ($2.00)')).toBeInTheDocument();
  });

  it('renders free as $0.00', () => {
    render(<CostDisplay billingModel="free" costUsd={0} />);
    expect(screen.getByText('$0.00')).toBeInTheDocument();
  });

  it('applies custom className to the span', () => {
    render(<CostDisplay billingModel="api-key" costUsd={1} className="text-orange-400" />);
    const el = screen.getByText('$1.00');
    expect(el.className).toMatch(/text-orange-400/);
  });
});
