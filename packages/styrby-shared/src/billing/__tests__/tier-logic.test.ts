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
  it('returns the numeric maxAgents for each tier', () => {
    expect(getFeatureLimitFor('free', 'maxAgents')).toBe(1);
    expect(getFeatureLimitFor('pro', 'maxAgents')).toBe(3);
    expect(getFeatureLimitFor('power', 'maxAgents')).toBe(9);
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
    expect(getFeatureLimitFor('mystery' as never, 'maxAgents')).toBe(1);
  });
});

describe('normalizeTier', () => {
  it('passes through known tier ids', () => {
    expect(normalizeTier('pro')).toBe('pro');
    expect(normalizeTier('power')).toBe('power');
    expect(normalizeTier('team')).toBe('team');
  });

  it('defaults to free for null / undefined / unknown', () => {
    expect(normalizeTier(null)).toBe('free');
    expect(normalizeTier(undefined)).toBe('free');
    expect(normalizeTier('enterprise')).toBe('free');
    expect(normalizeTier('')).toBe('free');
  });
});
