/**
 * Component tests for RunRateCard (web).
 *
 * WHY: The progress bar width and color are derived from tierCapFractionUsed.
 * Regressions here would show wrong colors to users approaching their budget.
 * We also verify the "Cap in ~Xd" label only renders for amber/red bands.
 *
 * @module components/dashboard/__tests__/RunRateCard
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RunRateCard } from '../RunRateCard';
import type { RunRateProjection } from '@styrby/shared';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeProjection(overrides: Partial<RunRateProjection> = {}): RunRateProjection {
  return {
    todayActualUsd: 1.50,
    mtdActualUsd: 15.0,
    projectedMonthUsd: 30.0,
    rollingDailyAvgUsd: 1.0,
    daysRemainingInMonth: 15,
    tierCapFractionUsed: null,
    tierCapUsd: null,
    daysUntilCapHit: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RunRateCard', () => {
  it('renders today / MTD / projected values', () => {
    render(<RunRateCard projection={makeProjection()} />);
    expect(screen.getByText('$1.50')).toBeTruthy();
    expect(screen.getByText('$15.00')).toBeTruthy();
    expect(screen.getByText('$30.00')).toBeTruthy();
  });

  it('renders dash for projected when null', () => {
    render(<RunRateCard projection={makeProjection({ projectedMonthUsd: null })} />);
    expect(screen.getByText('-')).toBeTruthy();
  });

  it('does not render progress bar when tier has no cap', () => {
    const { container } = render(<RunRateCard projection={makeProjection()} />);
    const progressBar = container.querySelector('[role="progressbar"]');
    expect(progressBar).toBeNull();
  });

  it('renders progress bar when tier has a cap', () => {
    const { container } = render(
      <RunRateCard
        projection={makeProjection({
          tierCapFractionUsed: 0.5,
          tierCapUsd: 50,
        })}
      />
    );
    const progressBar = container.querySelector('[role="progressbar"]');
    expect(progressBar).toBeTruthy();
    expect(progressBar?.getAttribute('aria-valuenow')).toBe('50');
  });

  it('renders cap-hit warning only for amber/red bands', () => {
    const ambientProjection = makeProjection({
      tierCapFractionUsed: 0.85,
      tierCapUsd: 50,
      daysUntilCapHit: 3,
    });
    render(<RunRateCard projection={ambientProjection} />);
    expect(screen.getByText(/Cap in ~3d/)).toBeTruthy();
  });

  it('does not render cap-hit warning for green band (fraction < 0.6)', () => {
    const safeProjection = makeProjection({
      tierCapFractionUsed: 0.4,
      tierCapUsd: 50,
      daysUntilCapHit: 20,
    });
    render(<RunRateCard projection={safeProjection} />);
    expect(screen.queryByText(/Cap in/)).toBeNull();
  });

  it('renders cap percentage label', () => {
    render(
      <RunRateCard
        projection={makeProjection({ tierCapFractionUsed: 0.75, tierCapUsd: 50 })}
      />
    );
    expect(screen.getByText('75% of $50 cap')).toBeTruthy();
  });
});
