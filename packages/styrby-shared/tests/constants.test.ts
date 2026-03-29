/**
 * Tests for Shared Constants
 *
 * Validates the shape and values of AGENT_CONFIG, ERROR_COLORS,
 * HEARTBEAT_CONFIG, and TIER_LIMITS to ensure they are structurally correct
 * and that critical values haven't been accidentally changed.
 */

import { describe, it, expect } from 'vitest';
import {
  AGENT_CONFIG,
  ERROR_COLORS,
  HEARTBEAT_CONFIG,
  TIER_LIMITS,
} from '../src/constants';

// =============================================================================
// AGENT_CONFIG
// =============================================================================

describe('AGENT_CONFIG', () => {
  const EXPECTED_AGENTS = ['claude', 'codex', 'gemini', 'opencode', 'aider'] as const;

  it('contains all expected agent keys', () => {
    for (const agent of EXPECTED_AGENTS) {
      expect(AGENT_CONFIG).toHaveProperty(agent);
    }
  });

  it('every agent entry has a non-empty name', () => {
    for (const agent of EXPECTED_AGENTS) {
      expect(typeof AGENT_CONFIG[agent].name).toBe('string');
      expect(AGENT_CONFIG[agent].name.length).toBeGreaterThan(0);
    }
  });

  it('every agent entry has an id that matches its key', () => {
    for (const agent of EXPECTED_AGENTS) {
      expect(AGENT_CONFIG[agent].id).toBe(agent);
    }
  });

  it('every agent entry has a non-empty description', () => {
    for (const agent of EXPECTED_AGENTS) {
      expect(typeof AGENT_CONFIG[agent].description).toBe('string');
      expect(AGENT_CONFIG[agent].description.length).toBeGreaterThan(0);
    }
  });

  it('every agent entry has a color in hex format', () => {
    for (const agent of EXPECTED_AGENTS) {
      expect(AGENT_CONFIG[agent].color).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it('every agent entry has a non-empty icon', () => {
    for (const agent of EXPECTED_AGENTS) {
      expect(typeof AGENT_CONFIG[agent].icon).toBe('string');
      expect(AGENT_CONFIG[agent].icon.length).toBeGreaterThan(0);
    }
  });

  it('every agent entry has a non-empty provider', () => {
    for (const agent of EXPECTED_AGENTS) {
      expect(typeof AGENT_CONFIG[agent].provider).toBe('string');
      expect(AGENT_CONFIG[agent].provider.length).toBeGreaterThan(0);
    }
  });

  it('claude provider is Anthropic', () => {
    expect(AGENT_CONFIG.claude.provider).toBe('Anthropic');
  });

  it('codex provider is OpenAI', () => {
    expect(AGENT_CONFIG.codex.provider).toBe('OpenAI');
  });

  it('gemini provider is Google', () => {
    expect(AGENT_CONFIG.gemini.provider).toBe('Google');
  });

  it('agent colors are distinct from one another', () => {
    const colors = EXPECTED_AGENTS.map((a) => AGENT_CONFIG[a].color);
    const unique = new Set(colors);
    expect(unique.size).toBe(colors.length);
  });
});

// =============================================================================
// ERROR_COLORS
// =============================================================================

describe('ERROR_COLORS', () => {
  const EXPECTED_KEYS = ['styrby', 'agent', 'api', 'network', 'build', 'permission'] as const;

  it('contains all expected error source keys', () => {
    for (const key of EXPECTED_KEYS) {
      expect(ERROR_COLORS).toHaveProperty(key);
    }
  });

  it('every error color is a valid hex string', () => {
    for (const key of EXPECTED_KEYS) {
      expect(ERROR_COLORS[key]).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it('styrby error color is the brand orange', () => {
    expect(ERROR_COLORS.styrby).toBe('#F97316');
  });

  it('agent error color is red', () => {
    expect(ERROR_COLORS.agent).toBe('#EF4444');
  });

  it('network error color is yellow', () => {
    expect(ERROR_COLORS.network).toBe('#EAB308');
  });
});

// =============================================================================
// HEARTBEAT_CONFIG
// =============================================================================

describe('HEARTBEAT_CONFIG', () => {
  it('intervalMs is a positive integer', () => {
    expect(HEARTBEAT_CONFIG.intervalMs).toBeGreaterThan(0);
    expect(Number.isInteger(HEARTBEAT_CONFIG.intervalMs)).toBe(true);
  });

  it('timeoutMs is a positive integer', () => {
    expect(HEARTBEAT_CONFIG.timeoutMs).toBeGreaterThan(0);
    expect(Number.isInteger(HEARTBEAT_CONFIG.timeoutMs)).toBe(true);
  });

  it('maxReconnectDelayMs is a positive integer', () => {
    expect(HEARTBEAT_CONFIG.maxReconnectDelayMs).toBeGreaterThan(0);
    expect(Number.isInteger(HEARTBEAT_CONFIG.maxReconnectDelayMs)).toBe(true);
  });

  it('intervalMs is 15 seconds (15000ms)', () => {
    expect(HEARTBEAT_CONFIG.intervalMs).toBe(15_000);
  });

  it('timeoutMs is 45 seconds (45000ms)', () => {
    expect(HEARTBEAT_CONFIG.timeoutMs).toBe(45_000);
  });

  it('maxReconnectDelayMs is 30 seconds (30000ms)', () => {
    expect(HEARTBEAT_CONFIG.maxReconnectDelayMs).toBe(30_000);
  });

  it('timeoutMs is greater than intervalMs (must outlast a missed heartbeat)', () => {
    expect(HEARTBEAT_CONFIG.timeoutMs).toBeGreaterThan(HEARTBEAT_CONFIG.intervalMs);
  });
});

// =============================================================================
// TIER_LIMITS
// =============================================================================

describe('TIER_LIMITS', () => {
  const TIERS = ['free', 'pro', 'power', 'team'] as const;

  it('contains all expected subscription tiers', () => {
    for (const tier of TIERS) {
      expect(TIER_LIMITS).toHaveProperty(tier);
    }
  });

  it('every tier has a positive maxAgents value', () => {
    for (const tier of TIERS) {
      expect(TIER_LIMITS[tier].maxAgents).toBeGreaterThan(0);
    }
  });

  it('every tier has a maxSessionsPerDay that is a positive number or Infinity', () => {
    for (const tier of TIERS) {
      expect(TIER_LIMITS[tier].maxSessionsPerDay).toBeGreaterThan(0);
    }
  });

  it('free tier is capped at 5 sessions per day', () => {
    expect(TIER_LIMITS.free.maxSessionsPerDay).toBe(5);
  });

  it('pro tier has unlimited sessions (Infinity)', () => {
    expect(TIER_LIMITS.pro.maxSessionsPerDay).toBe(Infinity);
  });

  it('power tier has unlimited sessions (Infinity)', () => {
    expect(TIER_LIMITS.power.maxSessionsPerDay).toBe(Infinity);
  });

  it('team tier has unlimited sessions (Infinity)', () => {
    expect(TIER_LIMITS.team.maxSessionsPerDay).toBe(Infinity);
  });

  it('free tier has no budget alerts', () => {
    expect(TIER_LIMITS.free.budgetAlerts).toBe(false);
  });

  it('pro tier has budget alerts enabled', () => {
    expect(TIER_LIMITS.pro.budgetAlerts).toBe(true);
  });

  it('power tier has budget alerts enabled', () => {
    expect(TIER_LIMITS.power.budgetAlerts).toBe(true);
  });

  it('team tier has budget alerts enabled', () => {
    expect(TIER_LIMITS.team.budgetAlerts).toBe(true);
  });

  it('free tier has "basic" cost dashboard', () => {
    expect(TIER_LIMITS.free.costDashboard).toBe('basic');
  });

  it('pro tier has "full" cost dashboard', () => {
    expect(TIER_LIMITS.pro.costDashboard).toBe('full');
  });

  it('power tier has API access enabled', () => {
    // WHY: Power tier is explicitly designed for API access — this guards against
    // accidental removal of the apiAccess feature flag.
    expect((TIER_LIMITS.power as { apiAccess?: boolean }).apiAccess).toBe(true);
  });

  it('team tier has team features enabled', () => {
    expect((TIER_LIMITS.team as { teamFeatures?: boolean }).teamFeatures).toBe(true);
  });

  it('free tier has fewer maxAgents than paid tiers', () => {
    expect(TIER_LIMITS.free.maxAgents).toBeLessThan(TIER_LIMITS.pro.maxAgents);
  });

  it('free tier maxAgents is 1', () => {
    expect(TIER_LIMITS.free.maxAgents).toBe(1);
  });

  it('pro/team tiers have maxAgents of 3', () => {
    expect(TIER_LIMITS.pro.maxAgents).toBe(3);
    expect(TIER_LIMITS.team.maxAgents).toBe(3);
  });

  it('power tier has maxAgents of 9 (aligned with billing definition)', () => {
    // SEC-BIZ-003: Power tier maxAgents was 3 but billing defines 9 machines
    expect(TIER_LIMITS.power.maxAgents).toBe(9);
  });
});
