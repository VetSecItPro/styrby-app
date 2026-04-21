/**
 * Tests for tier-check utilities (Phase 0.9.2).
 *
 * Coverage strategy:
 * - Every exported function gets its own describe block.
 * - Every branch in the implementation gets at least one case.
 * - Edge cases: unknown tier strings, Infinity limits, boundary tiers.
 *
 * @module tiers/__tests__/utils
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeTierFull,
  getTierLimit,
  isPaidTier,
  isTeamTier,
  canAccessFeature,
  compareTiers,
  type FullTierId,
} from '../utils.js';

// ---------------------------------------------------------------------------
// normalizeTierFull
// ---------------------------------------------------------------------------

describe('normalizeTierFull', () => {
  it('returns free for null', () => {
    expect(normalizeTierFull(null)).toBe('free');
  });

  it('returns free for undefined', () => {
    expect(normalizeTierFull(undefined)).toBe('free');
  });

  it('returns free for empty string', () => {
    expect(normalizeTierFull('')).toBe('free');
  });

  it('returns free for unknown tier string', () => {
    expect(normalizeTierFull('mystery')).toBe('free');
    expect(normalizeTierFull('basic')).toBe('free');
    expect(normalizeTierFull('starter')).toBe('free');
  });

  it('returns power for "power"', () => {
    expect(normalizeTierFull('power')).toBe('power');
  });

  it('maps legacy "pro" alias to power', () => {
    expect(normalizeTierFull('pro')).toBe('power');
  });

  it('returns team for "team"', () => {
    expect(normalizeTierFull('team')).toBe('team');
  });

  it('returns business for "business"', () => {
    expect(normalizeTierFull('business')).toBe('business');
  });

  it('returns enterprise for "enterprise"', () => {
    expect(normalizeTierFull('enterprise')).toBe('enterprise');
  });
});

// ---------------------------------------------------------------------------
// getTierLimit
// ---------------------------------------------------------------------------

describe('getTierLimit — agents', () => {
  it('free has 3 agents', () => {
    expect(getTierLimit('free', 'agents')).toBe(3);
  });

  it('power has 11 agents', () => {
    expect(getTierLimit('power', 'agents')).toBe(11);
  });

  it('team has 11 agents', () => {
    expect(getTierLimit('team', 'agents')).toBe(11);
  });

  it('business has 11 agents', () => {
    expect(getTierLimit('business', 'agents')).toBe(11);
  });

  it('enterprise has 11 agents', () => {
    expect(getTierLimit('enterprise', 'agents')).toBe(11);
  });
});

describe('getTierLimit — sessionsPerDay', () => {
  it('free is capped (non-Infinity)', () => {
    const limit = getTierLimit('free', 'sessionsPerDay');
    expect(Number.isFinite(limit)).toBe(true);
    expect(limit).toBeGreaterThan(0);
  });

  it('power is Infinity', () => {
    expect(getTierLimit('power', 'sessionsPerDay')).toBe(Infinity);
  });

  it('team is Infinity', () => {
    expect(getTierLimit('team', 'sessionsPerDay')).toBe(Infinity);
  });

  it('business is Infinity', () => {
    expect(getTierLimit('business', 'sessionsPerDay')).toBe(Infinity);
  });

  it('enterprise is Infinity', () => {
    expect(getTierLimit('enterprise', 'sessionsPerDay')).toBe(Infinity);
  });
});

describe('getTierLimit — seats', () => {
  it('free has 0 seats (N/A concept)', () => {
    expect(getTierLimit('free', 'seats')).toBe(0);
  });

  it('power has 0 seats (solo tier)', () => {
    expect(getTierLimit('power', 'seats')).toBe(0);
  });

  it('team has non-zero seats', () => {
    expect(getTierLimit('team', 'seats')).toBeGreaterThan(0);
  });

  it('business has non-zero seats', () => {
    expect(getTierLimit('business', 'seats')).toBeGreaterThan(0);
  });

  it('enterprise has non-zero seats', () => {
    expect(getTierLimit('enterprise', 'seats')).toBeGreaterThan(0);
  });
});

describe('getTierLimit — retentionDays', () => {
  it('free retains for 7 days', () => {
    expect(getTierLimit('free', 'retentionDays')).toBe(7);
  });

  it('power retains forever (Infinity)', () => {
    expect(getTierLimit('power', 'retentionDays')).toBe(Infinity);
  });

  it('team retains forever', () => {
    expect(getTierLimit('team', 'retentionDays')).toBe(Infinity);
  });

  it('business retains forever', () => {
    expect(getTierLimit('business', 'retentionDays')).toBe(Infinity);
  });

  it('enterprise retains forever', () => {
    expect(getTierLimit('enterprise', 'retentionDays')).toBe(Infinity);
  });
});

// ---------------------------------------------------------------------------
// isPaidTier
// ---------------------------------------------------------------------------

describe('isPaidTier', () => {
  it('free is not paid', () => {
    expect(isPaidTier('free')).toBe(false);
  });

  it('power is paid', () => {
    expect(isPaidTier('power')).toBe(true);
  });

  it('team is paid', () => {
    expect(isPaidTier('team')).toBe(true);
  });

  it('business is paid', () => {
    expect(isPaidTier('business')).toBe(true);
  });

  it('enterprise is paid', () => {
    expect(isPaidTier('enterprise')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isTeamTier
// ---------------------------------------------------------------------------

describe('isTeamTier', () => {
  it('free is not team tier', () => {
    expect(isTeamTier('free')).toBe(false);
  });

  it('power is not team tier', () => {
    expect(isTeamTier('power')).toBe(false);
  });

  it('team is team tier', () => {
    expect(isTeamTier('team')).toBe(true);
  });

  it('business is team tier', () => {
    expect(isTeamTier('business')).toBe(true);
  });

  it('enterprise is team tier', () => {
    expect(isTeamTier('enterprise')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// canAccessFeature
// ---------------------------------------------------------------------------

describe('canAccessFeature — free tier', () => {
  const freeDenied: Parameters<typeof canAccessFeature>[1][] = [
    'multi_agent',
    'unlimited_history',
    'byok',
    'api_access',
    'budget_alerts',
    'cost_dashboard',
    'team_admin',
    'approval_chains',
    'audit_log',
    'sso',
    'custom_retention',
    'priority_support',
  ];

  for (const feature of freeDenied) {
    it(`denies ${feature} on free`, () => {
      expect(canAccessFeature('free', feature)).toBe(false);
    });
  }
});

describe('canAccessFeature — power tier', () => {
  const powerGranted: Parameters<typeof canAccessFeature>[1][] = [
    'multi_agent',
    'unlimited_history',
    'byok',
    'api_access',
    'budget_alerts',
    'cost_dashboard',
  ];

  const powerDenied: Parameters<typeof canAccessFeature>[1][] = [
    'team_admin',
    'approval_chains',
    'audit_log',
    'sso',
    'custom_retention',
    'priority_support',
  ];

  for (const feature of powerGranted) {
    it(`grants ${feature} on power`, () => {
      expect(canAccessFeature('power', feature)).toBe(true);
    });
  }

  for (const feature of powerDenied) {
    it(`denies ${feature} on power`, () => {
      expect(canAccessFeature('power', feature)).toBe(false);
    });
  }
});

describe('canAccessFeature — team tier', () => {
  const teamGranted: Parameters<typeof canAccessFeature>[1][] = [
    'multi_agent',
    'unlimited_history',
    'byok',
    'api_access',
    'budget_alerts',
    'cost_dashboard',
    'team_admin',
    'approval_chains',
    'audit_log',
  ];

  const teamDenied: Parameters<typeof canAccessFeature>[1][] = [
    'sso',
  ];

  for (const feature of teamGranted) {
    it(`grants ${feature} on team`, () => {
      expect(canAccessFeature('team', feature)).toBe(true);
    });
  }

  for (const feature of teamDenied) {
    it(`denies ${feature} on team`, () => {
      expect(canAccessFeature('team', feature)).toBe(false);
    });
  }
});

describe('canAccessFeature — enterprise tier', () => {
  const allFeatures: Parameters<typeof canAccessFeature>[1][] = [
    'multi_agent',
    'unlimited_history',
    'byok',
    'api_access',
    'budget_alerts',
    'cost_dashboard',
    'team_admin',
    'approval_chains',
    'audit_log',
    'sso',
    'custom_retention',
    'priority_support',
  ];

  for (const feature of allFeatures) {
    it(`grants ${feature} on enterprise`, () => {
      expect(canAccessFeature('enterprise', feature)).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// compareTiers
// ---------------------------------------------------------------------------

describe('compareTiers', () => {
  it('same tier returns 0', () => {
    const tiers: FullTierId[] = ['free', 'power', 'team', 'business', 'enterprise'];
    for (const t of tiers) {
      expect(compareTiers(t, t)).toBe(0);
    }
  });

  it('free < power', () => {
    expect(compareTiers('free', 'power')).toBe(-1);
  });

  it('power > free', () => {
    expect(compareTiers('power', 'free')).toBe(1);
  });

  it('free < team', () => {
    expect(compareTiers('free', 'team')).toBe(-1);
  });

  it('team > free', () => {
    expect(compareTiers('team', 'free')).toBe(1);
  });

  it('power < team', () => {
    expect(compareTiers('power', 'team')).toBe(-1);
  });

  it('team < business', () => {
    expect(compareTiers('team', 'business')).toBe(-1);
  });

  it('business < enterprise', () => {
    expect(compareTiers('business', 'enterprise')).toBe(-1);
  });

  it('enterprise > team', () => {
    expect(compareTiers('enterprise', 'team')).toBe(1);
  });

  it('enterprise > free', () => {
    expect(compareTiers('enterprise', 'free')).toBe(1);
  });

  it('can determine if a transition is an upgrade', () => {
    const isUpgrade = (next: FullTierId, current: FullTierId) =>
      compareTiers(next, current) > 0;

    expect(isUpgrade('power', 'free')).toBe(true);
    expect(isUpgrade('free', 'power')).toBe(false);
    expect(isUpgrade('enterprise', 'team')).toBe(true);
    expect(isUpgrade('team', 'enterprise')).toBe(false);
    expect(isUpgrade('team', 'team')).toBe(false);
  });
});
