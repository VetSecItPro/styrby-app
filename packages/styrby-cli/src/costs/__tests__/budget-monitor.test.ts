/**
 * Unit tests for `budget-monitor.ts`.
 *
 * Covers:
 *  - BudgetMonitor: UUID validation, alert loading (cache + refresh),
 *    checkAlert (all AlertLevels), checkAllAlerts, getMostSevereAlert,
 *    hasExceededBudget, getExceededAlerts, getActionableAlerts,
 *    markAlertTriggered, clearCache
 *  - Utility functions: formatBudgetMessage, getAlertLevelEmoji
 *  - createBudgetMonitor factory
 *
 * WHY: Budget monitoring drives hard stops and slowdowns in the cost pipeline.
 * A regression here could either silently over-charge users or falsely halt
 * sessions. Every code path must be verified in isolation.
 *
 * IMPORTANT CONTRACT NOTES (discovered from reading source):
 *
 * 1. checkAllAlerts() builds a *cost cache* keyed by `${period}:${agentType|'all'}`.
 *    When multiple alerts share the same (period, agentType) pair, getCostsForDateRange
 *    is called ONCE for that key — not once per alert. All alert checks then
 *    receive the same cached CostSummary.
 *
 * 2. Sort order is: exceeded (0) > critical (1) > warning (2) > ok (3).
 *
 * 3. currentCosts bypass: when a CostSummary is passed directly to checkAlert(),
 *    getCostsForDateRange is never called at all.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================================
// Mock: jsonl-parser.js
// WHY: getCostsForDateRange reads JSONL files from disk; we don't want FS I/O
// in unit tests. All cost values are controlled via vi.mocked().mockResolvedValue.
// ============================================================================

vi.mock('../jsonl-parser.js', () => ({
  getCostsForDateRange: vi.fn(async () => ({
    totalCostUsd: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    byModel: {},
    sessionCount: 0,
  })),
}));

import {
  BudgetMonitor,
  createBudgetMonitor,
  formatBudgetMessage,
  getAlertLevelEmoji,
  type BudgetAlert,
  type BudgetCheckResult,
  type AlertLevel,
} from '../budget-monitor.js';
import { getCostsForDateRange } from '../jsonl-parser.js';

// ============================================================================
// Helpers
// ============================================================================

const VALID_UUID = '12345678-1234-4234-8234-123456789abc';

/** Build a minimal BudgetAlert fixture, overridable per-test. */
function makeAlert(overrides: Partial<BudgetAlert> = {}): BudgetAlert {
  return {
    id: VALID_UUID,
    user_id: VALID_UUID,
    name: 'Test Alert',
    threshold_usd: 10,
    period: 'daily',
    agent_type: null,
    action: 'notify',
    notification_channels: ['in_app'],
    is_enabled: true,
    last_triggered_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Build a mock Supabase client.
 *
 * The select chain mirrors what loadBudgetAlerts() calls:
 *   .from('budget_alerts').select('*').eq(...).eq(...).order(...)
 *
 * The update chain mirrors markAlertTriggered():
 *   .from('budget_alerts').update({...}).eq('id', alertId).eq('user_id', userId)
 * The source awaits the second .eq() result to get { error }. Since there are
 * two chained .eq() calls we must return `this` on the first and resolve on the
 * second — but the simplest correct approach is to make .eq() always return an
 * object that is BOTH thenable (resolves to { error }) AND has its own .eq().
 * We achieve this by returning a proxy that has .eq() returning itself and
 * is itself a Promise resolving to { error }.
 */
function makeSupabase(
  alerts: BudgetAlert[] = [],
  updateError: string | null = null
) {
  const selectChain = {
    eq: vi.fn().mockReturnThis(),
    order: vi.fn().mockResolvedValue({ data: alerts, error: null }),
  };

  // markAlertTriggered() calls: .update({}).eq('id', alertId).eq('user_id', userId)
  // and then awaits the result for { error }.
  // We need: update() → obj with .eq() → obj with .eq() → Promise({ error })
  const updateErrorObj = updateError ? { message: updateError } : null;
  // The final awaitable (second .eq() result)
  const finalEqResult = Promise.resolve({ error: updateErrorObj });
  // First .eq() returns an object with another .eq()
  const secondEqChain = { eq: vi.fn().mockReturnValue(finalEqResult) };
  const updateChain = {
    eq: vi.fn().mockReturnValue(secondEqChain),
  };

  const fromFn = vi.fn((_table: string) => ({
    select: vi.fn(() => selectChain),
    update: vi.fn(() => updateChain),
  }));

  return { from: fromFn } as unknown as import('@supabase/supabase-js').SupabaseClient;
}

/** Return a fully-typed zero-cost CostSummary stub. */
function zeroCosts() {
  return {
    totalCostUsd: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    byModel: {},
    sessionCount: 0,
  } as unknown as Awaited<ReturnType<typeof getCostsForDateRange>>;
}

function costsOf(usd: number) {
  return { ...zeroCosts(), totalCostUsd: usd } as Awaited<
    ReturnType<typeof getCostsForDateRange>
  >;
}

// ============================================================================
// Reset mock between tests
// WHY: vi.mock() creates a module-level mock whose call count accumulates
// across tests unless explicitly cleared. clearAllMocks() resets call counts
// so per-test assertions like "not.toHaveBeenCalled" are reliable.
// ============================================================================

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCostsForDateRange).mockResolvedValue(zeroCosts());
});

// ============================================================================
// BudgetMonitor: construction
// ============================================================================

describe('BudgetMonitor construction', () => {
  it('throws for an invalid UUID userId', () => {
    expect(
      () => new BudgetMonitor({ supabase: makeSupabase(), userId: 'not-a-uuid' })
    ).toThrow('Invalid userId format');
  });

  it('accepts a valid UUID v4 without throwing', () => {
    expect(
      () => new BudgetMonitor({ supabase: makeSupabase(), userId: VALID_UUID })
    ).not.toThrow();
  });

  it('createBudgetMonitor factory returns a BudgetMonitor instance', () => {
    const monitor = createBudgetMonitor({ supabase: makeSupabase(), userId: VALID_UUID });
    expect(monitor).toBeInstanceOf(BudgetMonitor);
  });

  it('uses default warning=80 and critical=95 thresholds when not specified', async () => {
    vi.mocked(getCostsForDateRange).mockResolvedValue(costsOf(8)); // 80% of $10
    const monitor = new BudgetMonitor({ supabase: makeSupabase(), userId: VALID_UUID });
    const result = await monitor.checkAlert(makeAlert({ threshold_usd: 10 }));
    expect(result.level).toBe('warning');
  });
});

// ============================================================================
// BudgetMonitor: loadBudgetAlerts
// ============================================================================

describe('BudgetMonitor.loadBudgetAlerts', () => {
  it('returns alerts fetched from Supabase', async () => {
    const alert = makeAlert();
    const monitor = new BudgetMonitor({ supabase: makeSupabase([alert]), userId: VALID_UUID });
    const alerts = await monitor.loadBudgetAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].name).toBe('Test Alert');
  });

  it('uses cached result on second call within TTL (from is called only once)', async () => {
    const alert = makeAlert();
    const supabase = makeSupabase([alert]);
    const monitor = new BudgetMonitor({ supabase, userId: VALID_UUID });

    await monitor.loadBudgetAlerts();
    await monitor.loadBudgetAlerts();

    expect(supabase.from).toHaveBeenCalledTimes(1);
  });

  it('force-refreshes when forceRefresh=true (from is called twice)', async () => {
    const alert = makeAlert();
    const supabase = makeSupabase([alert]);
    const monitor = new BudgetMonitor({ supabase, userId: VALID_UUID });

    await monitor.loadBudgetAlerts();
    await monitor.loadBudgetAlerts(true);

    expect(supabase.from).toHaveBeenCalledTimes(2);
  });

  it('refreshes after clearCache() invalidates the cache', async () => {
    const alert = makeAlert();
    const supabase = makeSupabase([alert]);
    const monitor = new BudgetMonitor({ supabase, userId: VALID_UUID });

    await monitor.loadBudgetAlerts();
    monitor.clearCache();
    await monitor.loadBudgetAlerts();

    expect(supabase.from).toHaveBeenCalledTimes(2);
  });

  it('returns empty array when no alerts are configured', async () => {
    const monitor = new BudgetMonitor({ supabase: makeSupabase([]), userId: VALID_UUID });
    const alerts = await monitor.loadBudgetAlerts();
    expect(alerts).toHaveLength(0);
  });
});

// ============================================================================
// BudgetMonitor: checkAlert — level determination
// ============================================================================

describe('BudgetMonitor.checkAlert', () => {
  it('returns level=ok when spend is below warning threshold (50%)', async () => {
    vi.mocked(getCostsForDateRange).mockResolvedValue(costsOf(5)); // 50% of $10
    const monitor = new BudgetMonitor({ supabase: makeSupabase(), userId: VALID_UUID });
    const result = await monitor.checkAlert(makeAlert({ threshold_usd: 10 }));
    expect(result.level).toBe('ok');
  });

  it('returns level=warning at exactly the warning threshold (80%)', async () => {
    vi.mocked(getCostsForDateRange).mockResolvedValue(costsOf(8)); // 80% of $10
    const monitor = new BudgetMonitor({ supabase: makeSupabase(), userId: VALID_UUID });
    const result = await monitor.checkAlert(makeAlert({ threshold_usd: 10 }));
    expect(result.level).toBe('warning');
  });

  it('returns level=critical at exactly the critical threshold (95%)', async () => {
    vi.mocked(getCostsForDateRange).mockResolvedValue(costsOf(9.5)); // 95% of $10
    const monitor = new BudgetMonitor({ supabase: makeSupabase(), userId: VALID_UUID });
    const result = await monitor.checkAlert(makeAlert({ threshold_usd: 10 }));
    expect(result.level).toBe('critical');
  });

  it('returns level=exceeded and exceeded=true when spend >= threshold', async () => {
    vi.mocked(getCostsForDateRange).mockResolvedValue(costsOf(10)); // 100%
    const monitor = new BudgetMonitor({ supabase: makeSupabase(), userId: VALID_UUID });
    const result = await monitor.checkAlert(makeAlert({ threshold_usd: 10 }));
    expect(result.level).toBe('exceeded');
    expect(result.exceeded).toBe(true);
  });

  it('returns level=exceeded when spend is well over threshold', async () => {
    vi.mocked(getCostsForDateRange).mockResolvedValue(costsOf(15));
    const monitor = new BudgetMonitor({ supabase: makeSupabase(), userId: VALID_UUID });
    const result = await monitor.checkAlert(makeAlert({ threshold_usd: 10 }));
    expect(result.level).toBe('exceeded');
  });

  it('computes remainingUsd = threshold - spend when under threshold', async () => {
    vi.mocked(getCostsForDateRange).mockResolvedValue(costsOf(7));
    const monitor = new BudgetMonitor({ supabase: makeSupabase(), userId: VALID_UUID });
    const result = await monitor.checkAlert(makeAlert({ threshold_usd: 10 }));
    expect(result.remainingUsd).toBeCloseTo(3, 5);
  });

  it('clamps remainingUsd to 0 when exceeded', async () => {
    vi.mocked(getCostsForDateRange).mockResolvedValue(costsOf(15));
    const monitor = new BudgetMonitor({ supabase: makeSupabase(), userId: VALID_UUID });
    const result = await monitor.checkAlert(makeAlert({ threshold_usd: 10 }));
    expect(result.remainingUsd).toBe(0);
  });

  it('sets percentUsed proportionally', async () => {
    vi.mocked(getCostsForDateRange).mockResolvedValue(costsOf(5));
    const monitor = new BudgetMonitor({ supabase: makeSupabase(), userId: VALID_UUID });
    const result = await monitor.checkAlert(makeAlert({ threshold_usd: 10 }));
    expect(result.percentUsed).toBeCloseTo(50, 5);
  });

  it('sets isNewTrigger=true when exceeded and not previously triggered', async () => {
    vi.mocked(getCostsForDateRange).mockResolvedValue(costsOf(15));
    const monitor = new BudgetMonitor({ supabase: makeSupabase(), userId: VALID_UUID });
    const result = await monitor.checkAlert(
      makeAlert({ threshold_usd: 10, last_triggered_at: null })
    );
    expect(result.isNewTrigger).toBe(true);
  });

  it('sets isNewTrigger=false when already triggered in current period', async () => {
    vi.mocked(getCostsForDateRange).mockResolvedValue(costsOf(15));
    const monitor = new BudgetMonitor({ supabase: makeSupabase(), userId: VALID_UUID });
    // Triggered just now (well within the current period)
    const result = await monitor.checkAlert(
      makeAlert({ threshold_usd: 10, last_triggered_at: new Date().toISOString() })
    );
    expect(result.isNewTrigger).toBe(false);
  });

  it('sets isNewTrigger=false when level is not exceeded', async () => {
    vi.mocked(getCostsForDateRange).mockResolvedValue(costsOf(5)); // only 50%
    const monitor = new BudgetMonitor({ supabase: makeSupabase(), userId: VALID_UUID });
    const result = await monitor.checkAlert(makeAlert({ threshold_usd: 10 }));
    expect(result.isNewTrigger).toBe(false);
  });

  it('uses pre-fetched costs when currentCosts is provided (no getCostsForDateRange call)', async () => {
    const monitor = new BudgetMonitor({ supabase: makeSupabase(), userId: VALID_UUID });
    const preFetched = costsOf(8);

    const result = await monitor.checkAlert(makeAlert({ threshold_usd: 10 }), preFetched);

    expect(result.currentSpendUsd).toBe(8);
    // getCostsForDateRange must NOT have been called — pre-fetched was used.
    expect(getCostsForDateRange).not.toHaveBeenCalled();
  });

  it('returns the alert object in the result', async () => {
    const alert = makeAlert({ name: 'My Alert', threshold_usd: 5 });
    const monitor = new BudgetMonitor({ supabase: makeSupabase(), userId: VALID_UUID });
    const result = await monitor.checkAlert(alert);
    expect(result.alert).toBe(alert);
  });
});

// ============================================================================
// BudgetMonitor: checkAllAlerts
// ============================================================================

describe('BudgetMonitor.checkAllAlerts', () => {
  it('returns empty array when no alerts are configured', async () => {
    const monitor = new BudgetMonitor({ supabase: makeSupabase([]), userId: VALID_UUID });
    const results = await monitor.checkAllAlerts();
    expect(results).toHaveLength(0);
  });

  it('returns one result per alert', async () => {
    const alerts = [makeAlert({ name: 'A' }), makeAlert({ name: 'B' })];
    // Both share the same period:agentType key so one getCostsForDateRange call covers both.
    const monitor = new BudgetMonitor({ supabase: makeSupabase(alerts), userId: VALID_UUID });
    const results = await monitor.checkAllAlerts();
    expect(results).toHaveLength(2);
  });

  it('sorts results: exceeded appears before ok', async () => {
    // Two alerts sharing daily:all — one cost value covers both via the cache.
    // To get different levels we need separate agent_type keys so separate cost fetches.
    // Use period differentiation: one daily, one monthly (different keys = separate fetches).
    vi.mocked(getCostsForDateRange)
      .mockResolvedValueOnce(costsOf(10))  // first unique key: exceeded ($10 >= $10)
      .mockResolvedValueOnce(costsOf(1));  // second unique key: ok ($1 out of $10)

    const alerts = [
      makeAlert({ name: 'ok-alert',       threshold_usd: 10, period: 'daily' }),
      makeAlert({ name: 'exceeded-alert', threshold_usd: 10, period: 'monthly' }),
    ];

    const monitor = new BudgetMonitor({ supabase: makeSupabase(alerts), userId: VALID_UUID });
    const results = await monitor.checkAllAlerts();

    expect(results[0].level).toBe('exceeded');
  });

  it('sorts results: order is exceeded > critical > warning > ok', async () => {
    // Four alerts, each with a distinct period so each gets its own cost query.
    vi.mocked(getCostsForDateRange)
      .mockResolvedValueOnce(costsOf(2))    // daily:all  → ok   (20%)
      .mockResolvedValueOnce(costsOf(10))   // weekly:all → exceeded (100%)
      .mockResolvedValueOnce(costsOf(9.5))  // monthly:all → critical (95%)
      .mockResolvedValueOnce(costsOf(8));   // fourth → warning but same monthly key, won't reach here

    // Use four distinct periods to force four separate cost cache keys.
    // Only daily/weekly/monthly exist so we use agent_type to differentiate the fourth.
    const alerts = [
      makeAlert({ name: 'ok-alert',       threshold_usd: 10, period: 'daily',   agent_type: null }),
      makeAlert({ name: 'exceeded-alert', threshold_usd: 10, period: 'weekly',  agent_type: null }),
      makeAlert({ name: 'critical-alert', threshold_usd: 10, period: 'monthly', agent_type: null }),
      // Same monthly:all key as critical — will reuse cached value (9.5 → critical), not warning.
      // Instead use a different agent_type to force a separate cache entry.
      makeAlert({ name: 'warning-alert',  threshold_usd: 10, period: 'monthly', agent_type: 'claude' as const }),
    ];
    // Fourth key is monthly:claude, needs its own mock (8 → 80% warning).
    vi.mocked(getCostsForDateRange).mockResolvedValueOnce(costsOf(8)); // monthly:claude

    const monitor = new BudgetMonitor({ supabase: makeSupabase(alerts), userId: VALID_UUID });
    const results = await monitor.checkAllAlerts();

    const levels = results.map((r) => r.level);
    // Verify sort order invariant: no exceeded comes after non-exceeded.
    const exceededIdx = levels.indexOf('exceeded');
    const warningIdx  = levels.indexOf('warning');
    const okIdx       = levels.indexOf('ok');

    expect(exceededIdx).toBeLessThan(warningIdx);
    expect(warningIdx).toBeLessThan(okIdx);
  });

  it('deduplicates cost fetches for alerts with the same period+agentType', async () => {
    // Three alerts all sharing 'daily:all' → only ONE getCostsForDateRange call.
    vi.mocked(getCostsForDateRange).mockResolvedValue(costsOf(0));
    const alerts = [
      makeAlert({ name: 'A', period: 'daily', agent_type: null }),
      makeAlert({ name: 'B', period: 'daily', agent_type: null }),
      makeAlert({ name: 'C', period: 'daily', agent_type: null }),
    ];
    const monitor = new BudgetMonitor({ supabase: makeSupabase(alerts), userId: VALID_UUID });
    await monitor.checkAllAlerts();

    // Only 1 unique key (daily:all) → only 1 cost fetch.
    expect(vi.mocked(getCostsForDateRange)).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// BudgetMonitor: convenience query methods
// ============================================================================

describe('BudgetMonitor convenience methods', () => {
  it('getMostSevereAlert returns the first (most severe) result', async () => {
    vi.mocked(getCostsForDateRange).mockResolvedValue(costsOf(15)); // exceeded
    const monitor = new BudgetMonitor({
      supabase: makeSupabase([makeAlert({ threshold_usd: 10 })]),
      userId: VALID_UUID,
    });
    const result = await monitor.getMostSevereAlert();
    expect(result).not.toBeNull();
    expect(result!.level).toBe('exceeded');
  });

  it('getMostSevereAlert returns null when no alerts are configured', async () => {
    const monitor = new BudgetMonitor({ supabase: makeSupabase([]), userId: VALID_UUID });
    const result = await monitor.getMostSevereAlert();
    expect(result).toBeNull();
  });

  it('hasExceededBudget returns true when any alert is exceeded', async () => {
    vi.mocked(getCostsForDateRange).mockResolvedValue(costsOf(15)); // exceeded
    const monitor = new BudgetMonitor({
      supabase: makeSupabase([makeAlert({ threshold_usd: 10 })]),
      userId: VALID_UUID,
    });
    expect(await monitor.hasExceededBudget()).toBe(true);
  });

  it('hasExceededBudget returns false when no alert is exceeded', async () => {
    vi.mocked(getCostsForDateRange).mockResolvedValue(costsOf(1)); // well under
    const monitor = new BudgetMonitor({
      supabase: makeSupabase([makeAlert({ threshold_usd: 10 })]),
      userId: VALID_UUID,
    });
    expect(await monitor.hasExceededBudget()).toBe(false);
  });

  it('getExceededAlerts returns only results with exceeded=true', async () => {
    vi.mocked(getCostsForDateRange).mockResolvedValue(costsOf(15));
    const monitor = new BudgetMonitor({
      supabase: makeSupabase([makeAlert({ threshold_usd: 10 })]),
      userId: VALID_UUID,
    });
    const exceeded = await monitor.getExceededAlerts();
    expect(exceeded.length).toBeGreaterThan(0);
    expect(exceeded.every((r) => r.exceeded)).toBe(true);
  });

  it('getExceededAlerts returns empty array when none are exceeded', async () => {
    vi.mocked(getCostsForDateRange).mockResolvedValue(costsOf(1));
    const monitor = new BudgetMonitor({
      supabase: makeSupabase([makeAlert({ threshold_usd: 10 })]),
      userId: VALID_UUID,
    });
    const exceeded = await monitor.getExceededAlerts();
    expect(exceeded).toHaveLength(0);
  });

  it('getActionableAlerts excludes ok-level alerts', async () => {
    vi.mocked(getCostsForDateRange).mockResolvedValue(costsOf(1)); // ok
    const monitor = new BudgetMonitor({
      supabase: makeSupabase([makeAlert({ threshold_usd: 10 })]),
      userId: VALID_UUID,
    });
    const actionable = await monitor.getActionableAlerts();
    expect(actionable.every((r) => r.level !== 'ok')).toBe(true);
  });

  it('getActionableAlerts returns exceeded results', async () => {
    vi.mocked(getCostsForDateRange).mockResolvedValue(costsOf(15));
    const monitor = new BudgetMonitor({
      supabase: makeSupabase([makeAlert({ threshold_usd: 10 })]),
      userId: VALID_UUID,
    });
    const actionable = await monitor.getActionableAlerts();
    expect(actionable.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// BudgetMonitor: markAlertTriggered
// ============================================================================

describe('BudgetMonitor.markAlertTriggered', () => {
  it('calls Supabase update and invalidates the cache', async () => {
    const supabase = makeSupabase([makeAlert()]);
    const monitor = new BudgetMonitor({ supabase, userId: VALID_UUID });

    // Populate cache.
    await monitor.loadBudgetAlerts();
    await monitor.markAlertTriggered(VALID_UUID);

    // Cache was invalidated; next load should hit Supabase again.
    await monitor.loadBudgetAlerts();

    // 1 initial load + 1 markTriggered (update) + 1 reload after invalidation = 3 calls.
    expect(supabase.from).toHaveBeenCalledTimes(3);
  });

  it('throws when Supabase update returns an error', async () => {
    const supabase = makeSupabase([makeAlert()], 'update failed');
    const monitor = new BudgetMonitor({ supabase, userId: VALID_UUID });

    await expect(monitor.markAlertTriggered(VALID_UUID)).rejects.toThrow('Failed to mark alert triggered');
  });
});

// ============================================================================
// Utility: formatBudgetMessage
// ============================================================================

describe('formatBudgetMessage', () => {
  function makeResult(level: AlertLevel, spend: number, threshold: number): BudgetCheckResult {
    return {
      level,
      alert: makeAlert({ threshold_usd: threshold }),
      currentSpendUsd: spend,
      percentUsed: (spend / threshold) * 100,
      remainingUsd: Math.max(0, threshold - spend),
      exceeded: spend >= threshold,
      isNewTrigger: false,
    };
  }

  it('includes "exceeded" for exceeded level', () => {
    expect(formatBudgetMessage(makeResult('exceeded', 11, 10))).toContain('exceeded');
  });

  it('includes "critical" for critical level', () => {
    expect(formatBudgetMessage(makeResult('critical', 9.5, 10))).toContain('critical');
  });

  it('includes "warning" for warning level', () => {
    expect(formatBudgetMessage(makeResult('warning', 8, 10))).toContain('warning');
  });

  it('includes "OK" for ok level', () => {
    expect(formatBudgetMessage(makeResult('ok', 3, 10))).toContain('OK');
  });

  it('includes the alert name in the message', () => {
    const msg = formatBudgetMessage(makeResult('ok', 3, 10));
    expect(msg).toContain('Test Alert');
  });

  it('includes the spend and threshold amounts', () => {
    const msg = formatBudgetMessage(makeResult('exceeded', 11, 10));
    expect(msg).toContain('11.00');
    expect(msg).toContain('10.00');
  });
});

// ============================================================================
// Utility: getAlertLevelEmoji
// ============================================================================

describe('getAlertLevelEmoji', () => {
  it('returns a non-empty string for every alert level', () => {
    const levels: AlertLevel[] = ['ok', 'warning', 'critical', 'exceeded'];
    for (const level of levels) {
      const emoji = getAlertLevelEmoji(level);
      expect(typeof emoji).toBe('string');
      expect(emoji.length).toBeGreaterThan(0);
    }
  });

  it('returns distinct strings for exceeded vs ok', () => {
    expect(getAlertLevelEmoji('exceeded')).not.toBe(getAlertLevelEmoji('ok'));
  });

  it('returns distinct strings for warning vs critical', () => {
    expect(getAlertLevelEmoji('warning')).not.toBe(getAlertLevelEmoji('critical'));
  });
});
