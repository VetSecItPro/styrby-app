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
  POLAR_PRO_MONTHLY_PRODUCT_ID: 'prod_pro_mo_aaa',
  POLAR_PRO_ANNUAL_PRODUCT_ID: 'prod_pro_yr_bbb',
  POLAR_GROWTH_MONTHLY_PRODUCT_ID: 'prod_grw_mo_ccc',
  POLAR_GROWTH_ANNUAL_PRODUCT_ID: 'prod_grw_yr_ddd',
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
// NEXT_PHASE build-time gate contract
// ============================================================================
//
// route.ts wraps the module-scope validatePolarEnv() call with:
//
//   if (process.env.NEXT_PHASE !== 'phase-production-build') {
//     try { validatePolarEnv(); } catch (err) {
//       console.error('[polar-env] Startup validation failed:', ...);
//       if (process.env.NODE_ENV !== 'test') { throw err; }
//     }
//   }
//
// The tests below verify the two observable behaviours of that gate in
// isolation — without importing route.ts (which would trigger the actual
// module-scope block). We simulate the gate logic inline so the test is
// not coupled to the route module's import side effects.
//
// WHY inline simulation (not import route.ts): importing route.ts runs the
// module-scope block immediately, which in NODE_ENV='test' swallows any throw.
// We cannot meaningfully test that the NEXT_PHASE gate *suppresses* the call
// via the route import — the NODE_ENV guard masks it. Simulating the gate logic
// directly tests the contract that `next build` relies on.

describe('NEXT_PHASE build-time gate (simulates route.ts module-scope wrapper)', () => {
  /**
   * Simulates the full gate + rethrow wrapper from route.ts.
   * Returns 'skipped' when NEXT_PHASE === 'phase-production-build' (gate active),
   * 'passed' when validatePolarEnv() succeeds, or rethrows when it fails and
   * nodeEnvIsTest is false.
   *
   * @param nodeEnvIsTest - true = test branch (swallow), false = prod/dev branch (rethrow)
   */
  function runGatedValidation(nodeEnvIsTest: boolean): 'skipped' | 'passed' {
    if (process.env.NEXT_PHASE === 'phase-production-build') {
      return 'skipped';
    }
    try {
      validatePolarEnv();
      return 'passed';
    } catch (err) {
      if (!nodeEnvIsTest) {
        throw err;
      }
      return 'passed'; // swallowed — test mode
    }
  }

  it('does NOT call validatePolarEnv when NEXT_PHASE === phase-production-build', () => {
    // WHY: This is the core CI fix. During `next build`, NEXT_PHASE is set to
    // 'phase-production-build'. The gate must skip validation entirely so the
    // build succeeds without Polar env vars present.
    vi.stubEnv('NEXT_PHASE', 'phase-production-build');
    // All env vars absent — if validatePolarEnv() were called, it would throw.
    // The gate must prevent that call.
    expect(() => runGatedValidation(false)).not.toThrow();
    expect(runGatedValidation(false)).toBe('skipped');
  });

  it('calls validatePolarEnv and rethrows when NEXT_PHASE is undefined and NODE_ENV is not test', () => {
    // WHY: In production (no NEXT_PHASE, no NODE_ENV=test), a missing env var
    // must cause the cold-start to fail loudly. The gate is inactive (NEXT_PHASE
    // not set), and the rethrow path is active (nodeEnvIsTest = false).
    vi.stubEnv('NEXT_PHASE', ''); // unset — gate inactive
    // All env vars absent — validatePolarEnv() will throw.
    expect(() => runGatedValidation(false)).toThrow(/missing or blank/);
  });

  it('swallows the error when NEXT_PHASE is undefined but NODE_ENV is test', () => {
    // WHY: During tests, the NEXT_PHASE gate is inactive but the NODE_ENV guard
    // prevents the rethrow. This matches the existing test-suite behaviour for
    // imports that do not set the 6 Polar vars.
    vi.stubEnv('NEXT_PHASE', '');
    expect(() => runGatedValidation(true)).not.toThrow();
  });

  it('calls validatePolarEnv normally when NEXT_PHASE is a non-build value', () => {
    // WHY: NEXT_PHASE can be set to other values (e.g. 'phase-development-server').
    // The gate must only suppress validation for the exact 'phase-production-build'
    // value, not for any other NEXT_PHASE string.
    vi.stubEnv('NEXT_PHASE', 'phase-development-server');
    stubFullEnv(); // all vars present — validatePolarEnv() passes
    expect(runGatedValidation(false)).toBe('passed');
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

  // ---------------- canonical (post-cutover) tier resolution ----------------
  // These pin the fix for the e2e finding where Growth subscription events
  // returned 422 "unknown product_id" because the resolver only knew the
  // legacy team/business schema. See route.ts team-path resolver call at
  // src/app/api/webhooks/polar/route.ts line ~569.

  it('resolves prod_pro_mo_aaa to { tier: pro, cycle: monthly }', () => {
    const result = resolvePolarProductId('prod_pro_mo_aaa');
    expect(result).toEqual({ tier: 'pro', cycle: 'monthly' });
  });

  it('resolves prod_pro_yr_bbb to { tier: pro, cycle: annual }', () => {
    const result = resolvePolarProductId('prod_pro_yr_bbb');
    expect(result).toEqual({ tier: 'pro', cycle: 'annual' });
  });

  it('resolves prod_grw_mo_ccc to { tier: growth, cycle: monthly }', () => {
    const result = resolvePolarProductId('prod_grw_mo_ccc');
    expect(result).toEqual({ tier: 'growth', cycle: 'monthly' });
  });

  it('resolves prod_grw_yr_ddd to { tier: growth, cycle: annual }', () => {
    const result = resolvePolarProductId('prod_grw_yr_ddd');
    expect(result).toEqual({ tier: 'growth', cycle: 'annual' });
  });
});
