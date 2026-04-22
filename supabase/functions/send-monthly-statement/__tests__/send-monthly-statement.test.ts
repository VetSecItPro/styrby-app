/**
 * Tests for send-monthly-statement edge function helpers.
 *
 * Tests cover:
 *   - getPriorMonthBounds: boundary cases (Jan 1st, Dec 1st, mid-month)
 *   - parseMonthOverride: valid + invalid input
 *   - aggregateUserStats: grouping, top-agent selection, billing counts
 *   - buildEmailPayload: subject line, billing line, plain-text body shape
 *
 * WHY test helpers not the Deno.serve handler: the handler depends on
 * Supabase + Resend HTTP calls which are integration concerns. Pure
 * helpers are deterministic and testable without mocks.
 */

import { describe, it, expect } from 'vitest';
import {
  getPriorMonthBounds,
  parseMonthOverride,
  aggregateUserStats,
  buildEmailPayload,
  type UserMonthlyStats,
} from '../helpers';

// ============================================================================
// getPriorMonthBounds
// ============================================================================

describe('getPriorMonthBounds', () => {
  it('returns March 2026 when reference is April 21', () => {
    const result = getPriorMonthBounds(new Date('2026-04-21T00:00:00Z'));
    expect(result.start).toBe('2026-03-01');
    expect(result.end).toBe('2026-03-31');
    expect(result.label).toBe('March 2026');
  });

  it('wraps to December of prior year when reference is January', () => {
    const result = getPriorMonthBounds(new Date('2026-01-05T00:00:00Z'));
    expect(result.start).toBe('2025-12-01');
    expect(result.end).toBe('2025-12-31');
    expect(result.label).toBe('December 2025');
  });

  it('returns November when reference is December', () => {
    const result = getPriorMonthBounds(new Date('2026-12-01T00:00:00Z'));
    expect(result.start).toBe('2026-11-01');
    expect(result.end).toBe('2026-11-30');
    expect(result.label).toBe('November 2026');
  });

  it('handles February correctly (non-leap year)', () => {
    const result = getPriorMonthBounds(new Date('2026-03-01T00:00:00Z'));
    expect(result.start).toBe('2026-02-01');
    expect(result.end).toBe('2026-02-28');
  });

  it('handles February correctly (leap year)', () => {
    const result = getPriorMonthBounds(new Date('2024-03-15T00:00:00Z'));
    expect(result.start).toBe('2024-02-01');
    expect(result.end).toBe('2024-02-29');
  });

  it('returns label with month name and year', () => {
    const result = getPriorMonthBounds(new Date('2026-07-01T00:00:00Z'));
    expect(result.label).toBe('June 2026');
  });
});

// ============================================================================
// parseMonthOverride
// ============================================================================

describe('parseMonthOverride', () => {
  it('parses a valid YYYY-MM string', () => {
    const result = parseMonthOverride('2026-03');
    expect(result.start).toBe('2026-03-01');
    expect(result.end).toBe('2026-03-31');
    expect(result.label).toBe('March 2026');
  });

  it('parses February of a leap year', () => {
    const result = parseMonthOverride('2024-02');
    expect(result.start).toBe('2024-02-01');
    expect(result.end).toBe('2024-02-29');
  });

  it('parses December correctly', () => {
    const result = parseMonthOverride('2025-12');
    expect(result.start).toBe('2025-12-01');
    expect(result.end).toBe('2025-12-31');
    expect(result.label).toBe('December 2025');
  });

  it('throws on invalid format', () => {
    expect(() => parseMonthOverride('2026-4')).toThrow('YYYY-MM');
    expect(() => parseMonthOverride('26-04')).toThrow();
    expect(() => parseMonthOverride('2026/04')).toThrow();
    expect(() => parseMonthOverride('')).toThrow();
  });

  it('throws on out-of-range month', () => {
    expect(() => parseMonthOverride('2026-00')).toThrow();
    expect(() => parseMonthOverride('2026-13')).toThrow();
  });
});

// ============================================================================
// aggregateUserStats
// ============================================================================

describe('aggregateUserStats', () => {
  const userMap = new Map([
    ['user-1', { email: 'alice@example.com', displayName: 'Alice' }],
    ['user-2', { email: 'bob@example.com' }],
  ]);

  const rows = [
    { user_id: 'user-1', agent_type: 'claude', billing_model: 'api-key',      total_cost_usd: 10.00, total_input_tokens: 1000, total_output_tokens: 200, record_count: 5 },
    { user_id: 'user-1', agent_type: 'codex',  billing_model: 'api-key',      total_cost_usd: 3.00,  total_input_tokens:  500, total_output_tokens: 100, record_count: 2 },
    { user_id: 'user-1', agent_type: 'claude', billing_model: 'subscription', total_cost_usd: 0.00,  total_input_tokens:  200, total_output_tokens:  50, record_count: 3 },
    { user_id: 'user-2', agent_type: 'gemini', billing_model: 'free',         total_cost_usd: 0.00,  total_input_tokens:  800, total_output_tokens: 150, record_count: 4 },
  ];

  it('returns one stat per user present in userMap', () => {
    const stats = aggregateUserStats(rows, userMap);
    expect(stats).toHaveLength(2);
  });

  it('aggregates total cost correctly', () => {
    const stats = aggregateUserStats(rows, userMap);
    const alice = stats.find((s) => s.userId === 'user-1');
    expect(alice?.totalCostUsd).toBeCloseTo(13.00);
  });

  it('aggregates token counts correctly', () => {
    const stats = aggregateUserStats(rows, userMap);
    const alice = stats.find((s) => s.userId === 'user-1');
    expect(alice?.totalInputTokens).toBe(1700);
    expect(alice?.totalOutputTokens).toBe(350);
  });

  it('identifies top agent by record count', () => {
    const stats = aggregateUserStats(rows, userMap);
    const alice = stats.find((s) => s.userId === 'user-1');
    // claude has 5 + 3 = 8 records; codex has 2 → claude wins
    expect(alice?.topAgent).toBe('claude');
  });

  it('counts billing model rows correctly', () => {
    const stats = aggregateUserStats(rows, userMap);
    const alice = stats.find((s) => s.userId === 'user-1');
    expect(alice?.billingCounts.apiKey).toBe(7); // 5 + 2
    expect(alice?.billingCounts.subscription).toBe(3);
    expect(alice?.billingCounts.credit).toBe(0);
  });

  it('skips users not in userMap', () => {
    const extraRows = [...rows, { user_id: 'unknown-user', agent_type: 'kiro', billing_model: 'credit', total_cost_usd: 5, total_input_tokens: 0, total_output_tokens: 0, record_count: 1 }];
    const stats = aggregateUserStats(extraRows, userMap);
    expect(stats.find((s) => s.userId === 'unknown-user')).toBeUndefined();
  });

  it('returns empty array for empty rows', () => {
    expect(aggregateUserStats([], userMap)).toEqual([]);
  });
});

// ============================================================================
// buildEmailPayload
// ============================================================================

describe('buildEmailPayload', () => {
  const stats: UserMonthlyStats = {
    userId: 'user-1',
    email: 'alice@example.com',
    displayName: 'Alice',
    totalCostUsd: 42.70,
    sessionCount: 31,
    topAgent: 'claude',
    totalInputTokens: 8_200_000,
    totalOutputTokens: 1_400_000,
    billingCounts: { apiKey: 78, subscription: 18, credit: 4, free: 0 },
  };

  const appUrl = 'https://app.styrbyapp.com';

  it('generates subject with month and cost', () => {
    const { subject } = buildEmailPayload(stats, 'April 2026', appUrl);
    expect(subject).toContain('April 2026');
    expect(subject).toContain('$42.70');
  });

  it('includes display name in plain text', () => {
    const { text } = buildEmailPayload(stats, 'April 2026', appUrl);
    expect(text).toContain('Alice');
  });

  it('falls back to email prefix when no display name', () => {
    const statsNoName = { ...stats, displayName: undefined };
    const { text } = buildEmailPayload(statsNoName, 'April 2026', appUrl);
    expect(text).toContain('alice');
  });

  it('includes billing mix percentages in plain text', () => {
    const { text } = buildEmailPayload(stats, 'April 2026', appUrl);
    // 78/100 = 78% API, 18% subscription, 4% credit
    expect(text).toContain('78% API');
    expect(text).toContain('18% subscription quota');
    expect(text).toContain('4% credits');
  });

  it('includes dashboard link', () => {
    const { html, text } = buildEmailPayload(stats, 'April 2026', appUrl);
    expect(html).toContain('https://app.styrbyapp.com/dashboard/costs');
    expect(text).toContain('https://app.styrbyapp.com/dashboard/costs');
  });

  it('formats large token counts with M suffix', () => {
    const { text } = buildEmailPayload(stats, 'April 2026', appUrl);
    expect(text).toContain('8.2M');
    expect(text).toContain('1.4M');
  });

  it('omits zero-value billing types from mix', () => {
    const statsApiOnly = {
      ...stats,
      billingCounts: { apiKey: 100, subscription: 0, credit: 0, free: 0 },
    };
    const { text } = buildEmailPayload(statsApiOnly, 'April 2026', appUrl);
    expect(text).not.toContain('subscription');
    expect(text).not.toContain('credits');
    expect(text).toContain('100% API');
  });

  it('shows "No billed usage" when all billing counts are zero', () => {
    const statsNoBilling = {
      ...stats,
      billingCounts: { apiKey: 0, subscription: 0, credit: 0, free: 0 },
    };
    const { text } = buildEmailPayload(statsNoBilling, 'April 2026', appUrl);
    expect(text).toContain('No billed usage');
  });

  it('generates valid HTML structure', () => {
    const { html } = buildEmailPayload(stats, 'April 2026', appUrl);
    expect(html).toMatch(/<!DOCTYPE html>/i);
    expect(html).toContain('</html>');
  });

  it('includes session count in plain text', () => {
    const { text } = buildEmailPayload(stats, 'April 2026', appUrl);
    expect(text).toContain('31');
  });
});
