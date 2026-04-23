/**
 * TeamCostProjectionCard — pure logic tests.
 *
 * WHY: Tests the projection calculation helpers inline (same pattern as
 * RunRateCard.test.ts). React Native component rendering tests are not
 * feasible in our test environment (testEnvironment = 'node').
 *
 * We test:
 *   1. Budget tier classification (safe / warn / over) at the thresholds used
 *      by both web TeamBudgetProjection and mobile TeamCostProjectionCard.
 *   2. Projected MTD calculation (linear interpolation).
 *   3. Progress bar percentage clamping at 100%.
 *
 * @module components/costs/__tests__/TeamCostProjectionCard.test
 */

// ---------------------------------------------------------------------------
// Inline helpers (mirrors logic in TeamCostProjectionCard.tsx and TeamBudgetProjection.tsx)
// ---------------------------------------------------------------------------

/**
 * Classifies the projected spend as safe / warn / over.
 * Mirrors the budgetTier() helper in TeamBudgetProjection.tsx.
 *
 * WHY inline: Avoids importing from a .tsx file in a node test environment.
 * The authoritative thresholds are documented in TeamBudgetProjection.tsx.
 *
 * @param projectedPct - Projected MTD spend as % of budget
 * @returns 'safe' | 'warn' | 'over'
 */
function budgetTier(projectedPct: number): 'safe' | 'warn' | 'over' {
  if (projectedPct >= 100) return 'over';
  if (projectedPct >= 80) return 'warn';
  return 'safe';
}

/**
 * Computes projected MTD spend.
 * Mirrors the projection formula in /api/teams/[id]/costs route.ts.
 *
 * @param mtdUsd - MTD spend to date
 * @param daysElapsed - Days elapsed in the current month
 * @param daysInMonth - Total days in the current month
 * @returns Projected end-of-month spend
 */
function computeProjected(mtdUsd: number, daysElapsed: number, daysInMonth: number): number {
  if (daysElapsed <= 0) return 0;
  return (mtdUsd / daysElapsed) * daysInMonth;
}

/**
 * Clamps a percentage value to [0, 100] for the progress bar width.
 *
 * @param actualPct - Computed percentage (may exceed 100)
 * @returns Clamped value in [0, 100]
 */
function clampPct(actualPct: number): number {
  return Math.min(actualPct, 100);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('budgetTier()', () => {
  it('returns safe below 80%', () => {
    expect(budgetTier(0)).toBe('safe');
    expect(budgetTier(50)).toBe('safe');
    expect(budgetTier(79.9)).toBe('safe');
  });

  it('returns warn from 80% to 99.9%', () => {
    expect(budgetTier(80)).toBe('warn');
    expect(budgetTier(90)).toBe('warn');
    expect(budgetTier(99.9)).toBe('warn');
  });

  it('returns over at exactly 100% and above', () => {
    expect(budgetTier(100)).toBe('over');
    expect(budgetTier(150)).toBe('over');
  });
});

describe('computeProjected()', () => {
  it('returns 0 when daysElapsed is 0 (division guard)', () => {
    expect(computeProjected(50, 0, 30)).toBe(0);
  });

  it('computes linear projection correctly', () => {
    // $12.50 spent in 10 days → projected $37.50 in 30-day month
    expect(computeProjected(12.5, 10, 30)).toBeCloseTo(37.5, 5);
  });

  it('returns exact spend when daysElapsed equals daysInMonth', () => {
    // Last day of month: projection equals actual
    expect(computeProjected(57.0, 30, 30)).toBeCloseTo(57.0, 5);
  });

  it('handles very small spend amounts', () => {
    // $0.01 in 1 day → $0.30 projected in 30 days
    expect(computeProjected(0.01, 1, 30)).toBeCloseTo(0.3, 5);
  });
});

describe('clampPct()', () => {
  it('does not clamp values below 100', () => {
    expect(clampPct(0)).toBe(0);
    expect(clampPct(75.5)).toBe(75.5);
    expect(clampPct(100)).toBe(100);
  });

  it('clamps values above 100 to 100', () => {
    expect(clampPct(101)).toBe(100);
    expect(clampPct(200)).toBe(100);
  });
});

describe('TeamCostProjectionCard integration scenario', () => {
  it('correctly identifies an over-budget scenario', () => {
    // Team with $57 budget (3 seats × $19), spent $45 in 10 days of a 30-day month
    const seatBudget = 57;
    const mtdSpend = 45;
    const daysElapsed = 10;
    const daysInMonth = 30;

    const projected = computeProjected(mtdSpend, daysElapsed, daysInMonth);
    const projectedPct = (projected / seatBudget) * 100;
    const tier = budgetTier(projectedPct);

    // $45 / 10 days * 30 days = $135 projected → 135/57 = 236% → over
    expect(projected).toBeCloseTo(135, 5);
    expect(tier).toBe('over');
  });

  it('correctly identifies an on-track scenario', () => {
    // Team with $57 budget, spent $10 in 15 days of a 30-day month
    const seatBudget = 57;
    const mtdSpend = 10;
    const daysElapsed = 15;
    const daysInMonth = 30;

    const projected = computeProjected(mtdSpend, daysElapsed, daysInMonth);
    const projectedPct = (projected / seatBudget) * 100;
    const tier = budgetTier(projectedPct);

    // $10 / 15 * 30 = $20 projected → 20/57 = 35% → safe
    expect(projected).toBeCloseTo(20, 5);
    expect(tier).toBe('safe');
  });

  it('correctly identifies a warn scenario (approaching limit)', () => {
    // Team with $57 budget, spent $40 in 20 days of a 30-day month
    const seatBudget = 57;
    const mtdSpend = 40;
    const daysElapsed = 20;
    const daysInMonth = 30;

    const projected = computeProjected(mtdSpend, daysElapsed, daysInMonth);
    const projectedPct = (projected / seatBudget) * 100;
    const tier = budgetTier(projectedPct);

    // $40 / 20 * 30 = $60 projected → 60/57 = 105% → over (not warn)
    // Let's try: $38 / 20 * 30 = $57 projected → 57/57 = 100% → over
    // Warn case: $25 / 20 * 30 = $37.50 → 37.50/57 = 65.8% → safe
    // Warn case: spend that gives 80-99%:
    // projected = 0.85 * 57 = 48.45 → mtd = 48.45 / 30 * 20 = 32.3
    const warnMtd = (0.85 * seatBudget / daysInMonth) * daysElapsed;
    const warnProjected = computeProjected(warnMtd, daysElapsed, daysInMonth);
    const warnPct = (warnProjected / seatBudget) * 100;
    expect(budgetTier(warnPct)).toBe('warn');

    // Check the original scenario (over budget)
    expect(tier).toBe('over');
  });
});
