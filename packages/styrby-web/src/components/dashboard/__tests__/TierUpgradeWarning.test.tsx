/**
 * Component tests for TierUpgradeWarning (web).
 *
 * WHY: The component's null-return logic determines whether users see the
 * upgrade CTA. A bug here could suppress the CTA at 90% (missing revenue)
 * or show it at 30% (annoying users).
 *
 * @module components/dashboard/__tests__/TierUpgradeWarning
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TierUpgradeWarning } from '../TierUpgradeWarning';
import type { RunRateProjection } from '@styrby/shared';

function makeProjection(overrides: Partial<RunRateProjection> = {}): RunRateProjection {
  return {
    todayActualUsd: 1.0,
    mtdActualUsd: 10.0,
    projectedMonthUsd: null,
    rollingDailyAvgUsd: 0.5,
    daysRemainingInMonth: 20,
    tierCapFractionUsed: null,
    tierCapUsd: null,
    daysUntilCapHit: null,
    ...overrides,
  };
}

describe('TierUpgradeWarning', () => {
  it('returns null when tier has no cap', () => {
    const { container } = render(
      <TierUpgradeWarning projection={makeProjection()} tierLabel="Power" />
    );
    expect(container.firstChild).toBeNull();
  });

  it('returns null when tier cap fraction < 0.6 (green band)', () => {
    const { container } = render(
      <TierUpgradeWarning
        projection={makeProjection({ tierCapFractionUsed: 0.5, tierCapUsd: 50 })}
        tierLabel="Pro"
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders warning at amber band (fraction 0.75)', () => {
    render(
      <TierUpgradeWarning
        projection={makeProjection({ tierCapFractionUsed: 0.75, tierCapUsd: 50 })}
        tierLabel="Pro"
      />
    );
    expect(screen.getByText(/Approaching Pro cap/)).toBeTruthy();
    // Use getAllByText because "Upgrade" also appears in the description paragraph
    expect(screen.getAllByText(/Upgrade/).length).toBeGreaterThan(0);
  });

  it('renders "cap reached" copy when fraction >= 1', () => {
    render(
      <TierUpgradeWarning
        projection={makeProjection({ tierCapFractionUsed: 1.0, tierCapUsd: 5 })}
        tierLabel="Free"
      />
    );
    expect(screen.getByText(/Free cap reached/)).toBeTruthy();
  });
});
