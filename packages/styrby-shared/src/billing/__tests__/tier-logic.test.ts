/**
 * Tests for tier-logic helpers (Phase 0.10).
 *
 * @module billing/__tests__/tier-logic
 */

import { describe, it, expect } from 'vitest';
import {
  isTierFeatureEnabled,
  getFeatureLimitFor,
  normalizeTier,
  isPremiumTier,
} from '../tier-logic.js';

describe('isTierFeatureEnabled', () => {
  it('returns false for free tier on budgetAlerts', () => {
    expect(isTierFeatureEnabled('free', 'budgetAlerts')).toBe(false);
  });

  it('returns true for pro tier on budgetAlerts', () => {
    expect(isTierFeatureEnabled('pro', 'budgetAlerts')).toBe(true);
  });

  it('returns true for power tier on apiAccess', () => {
    expect(isTierFeatureEnabled('power', 'apiAccess')).toBe(true);
  });

  it('returns false for free tier on apiAccess (key absent)', () => {
    expect(isTierFeatureEnabled('free', 'apiAccess')).toBe(false);
  });

  it('returns true for pro on costDashboard (full)', () => {
    expect(isTierFeatureEnabled('pro', 'costDashboard')).toBe(true);
  });

  it('returns false for free on costDashboard (basic)', () => {
    expect(isTierFeatureEnabled('free', 'costDashboard')).toBe(false);
  });

  it('treats numeric > 0 as enabled (maxAgents)', () => {
    expect(isTierFeatureEnabled('free', 'maxAgents')).toBe(true);
    expect(isTierFeatureEnabled('power', 'maxAgents')).toBe(true);
  });

  it('falls back to free tier on unknown tier id (fail-closed)', () => {
    expect(isTierFeatureEnabled('mystery' as never, 'budgetAlerts')).toBe(false);
  });
});

describe('getFeatureLimitFor', () => {
  it('returns the numeric maxAgents for each tier (Phase 5: free=3, pro=11, power-alias=11)', () => {
    expect(getFeatureLimitFor('free', 'maxAgents')).toBe(3);
    expect(getFeatureLimitFor('pro', 'maxAgents')).toBe(11);
    // 'power' is a legacy DB enum value preserved as a defensive alias.
    expect(getFeatureLimitFor('power', 'maxAgents')).toBe(11);
  });

  it('returns Infinity for unlimited maxSessionsPerDay (pro/power)', () => {
    expect(getFeatureLimitFor('pro', 'maxSessionsPerDay')).toBe(Infinity);
    expect(getFeatureLimitFor('power', 'maxSessionsPerDay')).toBe(Infinity);
  });

  it('returns 0 for non-numeric features', () => {
    expect(getFeatureLimitFor('pro', 'budgetAlerts')).toBe(0);
    expect(getFeatureLimitFor('pro', 'costDashboard')).toBe(0);
  });

  it('falls back to free tier on unknown tier id', () => {
    // Phase 5: free maxAgents is 3 (entry-level CLI agents).
    expect(getFeatureLimitFor('mystery' as never, 'maxAgents')).toBe(3);
  });
});

describe('normalizeTier', () => {
  it('passes through known tier ids', () => {
    expect(normalizeTier('pro')).toBe('pro');
    expect(normalizeTier('power')).toBe('power');
    expect(normalizeTier('team')).toBe('team');
  });

  it('passes through growth (regression: was silently coerced to free)', () => {
    // WHY: 'growth' is the current premium tier (4 live subscriptions). Before
    // this fix normalizeTier lacked a 'growth' case, so a Growth customer's
    // tier read from the DB was coerced to 'free', locking them out of paid
    // features. Canonical model: docs/planning/styrby-tiers-canonical.md.
    expect(normalizeTier('growth')).toBe('growth');
  });

  it('defaults to free for null / undefined / unknown', () => {
    expect(normalizeTier(null)).toBe('free');
    expect(normalizeTier(undefined)).toBe('free');
    expect(normalizeTier('enterprise')).toBe('free');
    expect(normalizeTier('')).toBe('free');
  });
});

describe('isPremiumTier', () => {
  it('is true for the premium tiers (growth + legacy power)', () => {
    expect(isPremiumTier('growth')).toBe(true);
    expect(isPremiumTier('power')).toBe(true);
  });

  it('is false for free and paid-individual pro', () => {
    // 'pro' is paid but NOT premium — premium features (Cloud Tasks, smart
    // filter, OTEL export) require growth/power.
    expect(isPremiumTier('pro')).toBe(false);
    expect(isPremiumTier('free')).toBe(false);
  });

  it('is false (fail-closed) for never-shipped / unknown / nullish tiers', () => {
    expect(isPremiumTier('team')).toBe(false);
    expect(isPremiumTier('business')).toBe(false);
    expect(isPremiumTier('enterprise')).toBe(false);
    expect(isPremiumTier(null)).toBe(false);
    expect(isPremiumTier(undefined)).toBe(false);
    expect(isPremiumTier('mystery')).toBe(false);
  });
});

describe('growth tier feature gating (TIER_LIMITS coverage)', () => {
  it('grants growth the full premium feature set including teamFeatures', () => {
    expect(isTierFeatureEnabled('growth', 'teamFeatures')).toBe(true);
    expect(isTierFeatureEnabled('growth', 'apiAccess')).toBe(true);
    expect(isTierFeatureEnabled('growth', 'budgetAlerts')).toBe(true);
    expect(isTierFeatureEnabled('growth', 'costDashboard')).toBe(true);
  });

  it('keeps pro NON-team (teamFeatures false) — premium ≠ pro', () => {
    expect(isTierFeatureEnabled('pro', 'teamFeatures')).toBe(false);
  });
});
