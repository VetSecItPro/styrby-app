/**
 * RunRateProjection Component Tests
 *
 * Covers:
 * - Returns null when historyDays < 3
 * - Returns null when no monthlyCap
 * - Returns null when avgDailySpend === 0
 * - Returns null when daysUntilCap > 45
 * - Shows correct cap date when conditions are met
 * - Shows "exceeded cap" state when remaining <= 0
 * - Subscription variant: shows quota projection
 * - Subscription variant: returns null when projectedPct < 50
 *
 * @module components/costs/__tests__/RunRateProjection.test
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RunRateProjection } from '../RunRateProjection';

describe('RunRateProjection — gate conditions', () => {
  it('returns null when historyDays < 3', () => {
    const { container } = render(
      <RunRateProjection
        last7dSpendUsd={14}
        historyDays={2}
        monthToDateSpendUsd={20}
        monthlyCap={49}
        billingModel="api-key"
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it('returns null when last7dSpendUsd is null', () => {
    const { container } = render(
      <RunRateProjection
        last7dSpendUsd={null}
        historyDays={5}
        monthToDateSpendUsd={20}
        monthlyCap={49}
        billingModel="api-key"
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it('returns null when no monthlyCap', () => {
    const { container } = render(
      <RunRateProjection
        last7dSpendUsd={14}
        historyDays={7}
        monthToDateSpendUsd={20}
        monthlyCap={null}
        billingModel="api-key"
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it('returns null when avgDailySpend is 0', () => {
    const { container } = render(
      <RunRateProjection
        last7dSpendUsd={0}
        historyDays={7}
        monthToDateSpendUsd={0}
        monthlyCap={49}
        billingModel="api-key"
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it('returns null when daysUntilCap > 45', () => {
    // monthlyCap=100, mtd=1, avgDaily=14/7=2 → remaining=99 / 2 = 49.5 days
    const { container } = render(
      <RunRateProjection
        last7dSpendUsd={14}
        historyDays={7}
        monthToDateSpendUsd={1}
        monthlyCap={100}
        billingModel="api-key"
      />
    );
    expect(container.firstChild).toBeNull();
  });
});

describe('RunRateProjection — active states', () => {
  it('shows "exceeded cap" when remaining <= 0', () => {
    render(
      <RunRateProjection
        last7dSpendUsd={14}
        historyDays={7}
        monthToDateSpendUsd={55}
        monthlyCap={49}
        billingModel="api-key"
      />
    );
    // "exceeded" text variant
    expect(screen.getByText(/exceeded/i)).toBeInTheDocument();
  });

  it('shows cap date projection when conditions are met', () => {
    // avgDaily = 14/7 = $2/day, remaining = 49 - 40 = $9 → ~4.5 days
    render(
      <RunRateProjection
        last7dSpendUsd={14}
        historyDays={7}
        monthToDateSpendUsd={40}
        monthlyCap={49}
        billingModel="api-key"
      />
    );
    expect(screen.getByText(/burn rate/i)).toBeInTheDocument();
    // Text may be split across elements — use a container-level check
    expect(screen.getByRole('status').textContent).toContain('$2.00');
  });

  it('has role=alert when over cap', () => {
    const { container } = render(
      <RunRateProjection
        last7dSpendUsd={14}
        historyDays={7}
        monthToDateSpendUsd={55}
        monthlyCap={49}
        billingModel="api-key"
      />
    );
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('has role=status when projecting cap date', () => {
    const { container } = render(
      <RunRateProjection
        last7dSpendUsd={14}
        historyDays={7}
        monthToDateSpendUsd={40}
        monthlyCap={49}
        billingModel="api-key"
      />
    );
    expect(container.querySelector('[role="status"]')).not.toBeNull();
  });
});

describe('RunRateProjection — subscription variant', () => {
  it('returns null when projectedPct < 50', () => {
    const { container } = render(
      <RunRateProjection
        last7dSpendUsd={0}
        historyDays={7}
        monthToDateSpendUsd={0}
        monthlyCap={null}
        billingModel="subscription"
        avgDailySubscriptionFraction={0.001}
        subscriptionQuota={1.0}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it('returns null when avgDailySubscriptionFraction is null', () => {
    const { container } = render(
      <RunRateProjection
        last7dSpendUsd={0}
        historyDays={7}
        monthToDateSpendUsd={0}
        monthlyCap={null}
        billingModel="subscription"
        avgDailySubscriptionFraction={null}
        subscriptionQuota={1.0}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it('shows quota projection text when projectedPct >= 50', () => {
    // avgDailyFraction = 0.05, remaining days ~ 15, projected = 0.05 * 15 = 0.75 = 75%
    render(
      <RunRateProjection
        last7dSpendUsd={0}
        historyDays={7}
        monthToDateSpendUsd={0}
        monthlyCap={null}
        billingModel="subscription"
        avgDailySubscriptionFraction={0.05}
        subscriptionQuota={1.0}
      />
    );
    expect(screen.getByText(/quota/i)).toBeInTheDocument();
  });
});
