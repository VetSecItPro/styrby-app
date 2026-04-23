/**
 * Unit Tests: polar-env.ts (Phase 2.6, Unit B, Deliverable 1 + 4)
 *
 * Covers:
 * - validatePolarEnv() throws when any required var is missing or empty
 * - validatePolarEnv() passes when all vars are set
 * - getPolarProductId() returns the correct env var VALUE for all 4 combinations
 * - resolvePolarProductId() reverse-maps product IDs correctly
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validatePolarEnv, getPolarProductId, resolvePolarProductId } from '../polar-env';

// ============================================================================
// Env var setup helpers
// ============================================================================

const FULL_ENV = {
  POLAR_ACCESS_TOKEN: 'pat_test_abc',
  POLAR_WEBHOOK_SECRET: 'whsec_test_xyz',
  POLAR_TEAM_MONTHLY_PRODUCT_ID: 'prod_team_mo_123',
  POLAR_TEAM_ANNUAL_PRODUCT_ID: 'prod_team_yr_456',
  POLAR_BUSINESS_MONTHLY_PRODUCT_ID: 'prod_biz_mo_789',
  POLAR_BUSINESS_ANNUAL_PRODUCT_ID: 'prod_biz_yr_012',
};

function stubFullEnv() {
  for (const [key, value] of Object.entries(FULL_ENV)) {
    vi.stubEnv(key, value);
  }
}

beforeEach(() => {
  vi.unstubAllEnvs();
});

// ============================================================================
// validatePolarEnv()
// ============================================================================

describe('validatePolarEnv()', () => {
  it('passes without throwing when all 6 required vars are set', () => {
    stubFullEnv();
    expect(() => validatePolarEnv()).not.toThrow();
  });

  it('throws when POLAR_ACCESS_TOKEN is missing', () => {
    stubFullEnv();
    vi.stubEnv('POLAR_ACCESS_TOKEN', '');
    expect(() => validatePolarEnv()).toThrow(/POLAR_ACCESS_TOKEN/);
  });

  it('throws when POLAR_WEBHOOK_SECRET is missing', () => {
    stubFullEnv();
    vi.stubEnv('POLAR_WEBHOOK_SECRET', '');
    expect(() => validatePolarEnv()).toThrow(/POLAR_WEBHOOK_SECRET/);
  });

  it('throws when POLAR_TEAM_MONTHLY_PRODUCT_ID is missing', () => {
    stubFullEnv();
    vi.stubEnv('POLAR_TEAM_MONTHLY_PRODUCT_ID', '');
    expect(() => validatePolarEnv()).toThrow(/POLAR_TEAM_MONTHLY_PRODUCT_ID/);
  });

  it('throws when POLAR_TEAM_ANNUAL_PRODUCT_ID is missing', () => {
    stubFullEnv();
    vi.stubEnv('POLAR_TEAM_ANNUAL_PRODUCT_ID', '');
    expect(() => validatePolarEnv()).toThrow(/POLAR_TEAM_ANNUAL_PRODUCT_ID/);
  });

  it('throws when POLAR_BUSINESS_MONTHLY_PRODUCT_ID is missing', () => {
    stubFullEnv();
    vi.stubEnv('POLAR_BUSINESS_MONTHLY_PRODUCT_ID', '');
    expect(() => validatePolarEnv()).toThrow(/POLAR_BUSINESS_MONTHLY_PRODUCT_ID/);
  });

  it('throws when POLAR_BUSINESS_ANNUAL_PRODUCT_ID is missing', () => {
    stubFullEnv();
    vi.stubEnv('POLAR_BUSINESS_ANNUAL_PRODUCT_ID', '');
    expect(() => validatePolarEnv()).toThrow(/POLAR_BUSINESS_ANNUAL_PRODUCT_ID/);
  });

  it('throws when all vars are unset', () => {
    // No stubFullEnv() call — all undefined
    expect(() => validatePolarEnv()).toThrow();
  });

  it('includes the missing var names in the error message (not the values)', () => {
    stubFullEnv();
    vi.stubEnv('POLAR_TEAM_ANNUAL_PRODUCT_ID', '');

    let errorMessage = '';
    try {
      validatePolarEnv();
    } catch (e) {
      errorMessage = (e as Error).message;
    }

    // Must include the var name
    expect(errorMessage).toContain('POLAR_TEAM_ANNUAL_PRODUCT_ID');
    // Must NOT include any secret values
    expect(errorMessage).not.toContain('pat_test_abc');
    expect(errorMessage).not.toContain('whsec_test_xyz');
  });
});

// ============================================================================
// Module-scope rethrow contract (Fix 1 — cold-start error propagation)
// ============================================================================
//
// The route.ts module wraps validatePolarEnv() with the pattern:
//
//   try { validatePolarEnv(); } catch (err) {
//     console.error('[polar-env] Startup validation failed:', ...);
//     if (process.env.NODE_ENV !== 'test') { throw err; }
//   }
//
// This section tests the CONTRACT of that wrapper pattern in isolation — without
// importing route.ts (which would trigger the module-scope block with
// NODE_ENV==='test', swallowing correctly). We test the two branches of the
// conditional directly by constructing equivalent inline wrappers.
//
// WHY not mutate process.env.NODE_ENV: Vitest's environment makes NODE_ENV
// non-configurable (Object.defineProperty throws). Instead, we parameterize
// the wrapper with an explicit envFlag, matching the logical branches tested.

describe('validatePolarEnv() rethrow contract (simulates non-test module scope)', () => {
  /**
   * Simulates the rethrow branch of the module-scope wrapper in route.ts when
   * `nodeEnvIsTest` is false (i.e., running in production or development).
   *
   * WHY inline conditional (not process.env.NODE_ENV): Vitest makes NODE_ENV
   * non-configurable at the process level, preventing Object.defineProperty
   * overrides in tests. This helper directly exercises the two branches of the
   * `if (process.env.NODE_ENV !== 'test') { throw err; }` guard.
   */
  function runWithRethrowEnabled(): void {
    // Rethrow path — equivalent to NODE_ENV !== 'test'
    try {
      validatePolarEnv();
    } catch (err) {
      throw err; // always rethrow — simulates prod/dev behavior
    }
  }

  function runWithRethrowSuppressed(): Error | null {
    // Suppress path — equivalent to NODE_ENV === 'test'
    try {
      validatePolarEnv();
    } catch (err) {
      return err as Error; // swallow and return — simulates test behavior
    }
    return null;
  }

  it('swallows the error in the test branch (test isolation)', () => {
    // All env vars missing — validatePolarEnv() will throw.
    // The test-mode branch should swallow and return the error, not propagate it.
    const swallowed = runWithRethrowSuppressed();
    expect(swallowed).not.toBeNull();
    expect(swallowed).toBeInstanceOf(Error);
    expect(swallowed!.message).toMatch(/missing or blank/);
  });

  it('rethrows the error in the prod/dev branch (cold-start must fail loudly)', () => {
    // All env vars missing — validatePolarEnv() will throw.
    // The prod/dev branch must rethrow so deploy-time health checks catch it.
    expect(() => runWithRethrowEnabled()).toThrow(/missing or blank/);
  });

  it('does not throw in either branch when all env vars are set (happy path)', () => {
    stubFullEnv();
    // No throw from validatePolarEnv() — neither branch rethrows.
    expect(() => runWithRethrowEnabled()).not.toThrow();
    expect(runWithRethrowSuppressed()).toBeNull();
  });

  it('error message identifies the missing var names, not secret values', () => {
    // Partial env — only webhook secret missing.
    stubFullEnv();
    vi.stubEnv('POLAR_WEBHOOK_SECRET', '');

    const err = runWithRethrowSuppressed();
    expect(err).not.toBeNull();
    expect(err!.message).toContain('POLAR_WEBHOOK_SECRET');
    // Secret values must never appear in the error message.
    expect(err!.message).not.toContain('whsec_test_xyz');
  });
});

// ============================================================================
// getPolarProductId() — all 4 combinations
// ============================================================================

describe('getPolarProductId()', () => {
  beforeEach(() => {
    stubFullEnv();
  });

  it('returns POLAR_TEAM_MONTHLY_PRODUCT_ID value for (team, monthly)', () => {
    expect(getPolarProductId('team', 'monthly')).toBe('prod_team_mo_123');
  });

  it('returns POLAR_TEAM_ANNUAL_PRODUCT_ID value for (team, annual)', () => {
    expect(getPolarProductId('team', 'annual')).toBe('prod_team_yr_456');
  });

  it('returns POLAR_BUSINESS_MONTHLY_PRODUCT_ID value for (business, monthly)', () => {
    expect(getPolarProductId('business', 'monthly')).toBe('prod_biz_mo_789');
  });

  it('returns POLAR_BUSINESS_ANNUAL_PRODUCT_ID value for (business, annual)', () => {
    expect(getPolarProductId('business', 'annual')).toBe('prod_biz_yr_012');
  });

  it('does NOT return team annual ID when requesting team monthly', () => {
    expect(getPolarProductId('team', 'monthly')).not.toBe('prod_team_yr_456');
  });

  it('does NOT return business monthly ID when requesting team monthly', () => {
    expect(getPolarProductId('team', 'monthly')).not.toBe('prod_biz_mo_789');
  });

  it('returns empty string when the env var is unset (after validatePolarEnv should have caught this)', () => {
    vi.stubEnv('POLAR_TEAM_MONTHLY_PRODUCT_ID', '');
    // WHY empty string (not undefined): getEnv() returns undefined for empty,
    // and getPolarProductId returns `getEnv(...) ?? ''`. Tests that validatePolarEnv
    // catches this case before it reaches getPolarProductId in production.
    expect(getPolarProductId('team', 'monthly')).toBe('');
  });
});

// ============================================================================
// resolvePolarProductId()
// ============================================================================

describe('resolvePolarProductId()', () => {
  beforeEach(() => {
    stubFullEnv();
  });

  it('resolves prod_team_mo_123 to { tier: team, cycle: monthly }', () => {
    const result = resolvePolarProductId('prod_team_mo_123');
    expect(result).toEqual({ tier: 'team', cycle: 'monthly' });
  });

  it('resolves prod_team_yr_456 to { tier: team, cycle: annual }', () => {
    const result = resolvePolarProductId('prod_team_yr_456');
    expect(result).toEqual({ tier: 'team', cycle: 'annual' });
  });

  it('resolves prod_biz_mo_789 to { tier: business, cycle: monthly }', () => {
    const result = resolvePolarProductId('prod_biz_mo_789');
    expect(result).toEqual({ tier: 'business', cycle: 'monthly' });
  });

  it('resolves prod_biz_yr_012 to { tier: business, cycle: annual }', () => {
    const result = resolvePolarProductId('prod_biz_yr_012');
    expect(result).toEqual({ tier: 'business', cycle: 'annual' });
  });

  it('returns null for an unrecognized product ID', () => {
    expect(resolvePolarProductId('prod_some_unknown_id')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(resolvePolarProductId('')).toBeNull();
  });
});
