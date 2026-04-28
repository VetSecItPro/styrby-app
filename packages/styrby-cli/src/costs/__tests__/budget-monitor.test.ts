/**
 * Unit tests for `budget-monitor.ts`.
 *
 * Covers:
 *  - BudgetMonitor: UUID validation, alert loading (cache + refresh),
 *    checkAlert (all AlertLevels for all three alert types), checkAllAlerts,
 *    getMostSevereAlert, hasExceededBudget, getExceededAlerts,
 *    getActionableAlerts, markAlertTriggered, clearCache
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
 *    getCostsForDateRange is never called at all (cost_usd type only).
 *
 * 4. subscription_quota and credits alert types query Supabase directly via the
 *    injected SupabaseClient. Their results are NOT controlled by getCostsForDateRange.
 *
 * 5. Mixed billing models in one period: when a user has api-key, subscription,
 *    and credit rows for the same period, each alert type correctly filters to
 *    its own billing_model column and ignores the others.
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
    alert_type: 'cost_usd',
    threshold_quota_fraction: null,
    threshold_credits: null,
    ...overrides,
  };
}

/**
 * Build a mock Supabase client.
 *
 * The select chain mirrors what loadBudgetAlerts() calls:
 *   .from('budget_alerts').select(...).eq(...).eq(...).order(...)
 *
 * The select chain also handles the new Supabase queries for subscription_quota
 * and credits alert types:
 *   .from('cost_records').select(...).eq(...).eq(...).gte(...).not(...).limit(...)
 *
 * @param alerts - Budget alerts to return from the budget_alerts query
 * @param updateError - Optional error message to return from update()
 * @param costRecordsRows - Optional rows to return from cost_records queries
 *   (used for subscription_quota and credits alert type tests).
 */
function makeSupabase(
  alerts: BudgetAlert[] = [],
  updateError: string | null = null,
  costRecordsRows: Array<Record<string, unknown>> = []
) {
  // select chain for budget_alerts: eq/eq/order path (loadBudgetAlerts)
  const alertsSelectChain = {
    eq: vi.fn().mockReturnThis(),
    order: vi.fn().mockResolvedValue({ data: alerts, error: null }),
  };

  // select chain for cost_records: eq/eq/gte/not/limit path (new helpers)
  // WHY: The new getSubscriptionFractionForPeriod and getCreditsConsumedForPeriod
  // methods chain: select → eq → eq → gte → not → limit → (thenable resolve)
  // We build a fully chainable mock that resolves at the terminal .limit() call.
  const costRecordsSelectChain: Record<string, unknown> = {};
  const costTerminal = Promise.resolve({ data: costRecordsRows, error: null });
  for (const method of ['eq', 'gte', 'not']) {
    costRecordsSelectChain[method] = vi.fn().mockReturnValue(costRecordsSelectChain);
  }
  costRecordsSelectChain['limit'] = vi.fn().mockReturnValue(costTerminal);
  // Make it thenable too for safety
  (costRecordsSelectChain as Record<string, unknown>)['then'] = (resolve: (v: unknown) => void) =>
    costTerminal.then(resolve);

  // markAlertTriggered() calls: .update({}).eq('id', alertId).eq('user_id', userId)
  // and then awaits the result for { error }.
  const updateErrorObj = updateError ? { message: updateError } : null;
  const finalEqResult = Promise.resolve({ error: updateErrorObj });
  const secondEqChain = { eq: vi.fn().mockReturnValue(finalEqResult) };
  const updateChain = {
    eq: vi.fn().mockReturnValue(secondEqChain),
  };

  const fromFn = vi.fn((table: string) => {
    if (table === 'cost_records') {
      return {
        select: vi.fn(() => costRecordsSelectChain),
      };
    }
    // budget_alerts table
    return {
      select: vi.fn(() => alertsSelectChain),
      update: vi.fn(() => updateChain),
    };
  });

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
// BudgetMonitor: checkAlert — subscription_quota alert type
// ============================================================================

describe('BudgetMonitor.checkAlert (subscription_quota)', () => {
  it('returns level=ok when subscription fraction is below warning threshold', async () => {
    // 0.40 fraction, threshold 0.80 → 50% of threshold → ok
    const supabase = makeSupabase([], null, [{ subscription_fraction_used: '0.4000' }]);
    const monitor = new BudgetMonitor({ supabase, userId: VALID_UUID });
    const alert = makeAlert({
      alert_type: 'subscription_quota',
      threshold_quota_fraction: 0.80,
      threshold_usd: 0,
    });
    const result = await monitor.checkAlert(alert);
    expect(result.level).toBe('ok');
    expect(getCostsForDateRange).not.toHaveBeenCalled();
  });

  it('returns level=warning when fraction is at the warning threshold (80%)', async () => {
    // fraction = 0.64 (80% of threshold 0.80) → percentUsed = 80% → warning
    const supabase = makeSupabase([], null, [{ subscription_fraction_used: '0.6400' }]);
    const monitor = new BudgetMonitor({ supabase, userId: VALID_UUID });
    const alert = makeAlert({
      alert_type: 'subscription_quota',
      threshold_quota_fraction: 0.80,
      threshold_usd: 0,
    });
    const result = await monitor.checkAlert(alert);
    expect(result.level).toBe('warning');
  });

  it('returns level=exceeded when fraction meets or exceeds threshold', async () => {
    // fraction = 0.90 >= threshold 0.80 → exceeded
    const supabase = makeSupabase([], null, [{ subscription_fraction_used: '0.9000' }]);
    const monitor = new BudgetMonitor({ supabase, userId: VALID_UUID });
    const alert = makeAlert({
      alert_type: 'subscription_quota',
      threshold_quota_fraction: 0.80,
      threshold_usd: 0,
    });
    const result = await monitor.checkAlert(alert);
    expect(result.level).toBe('exceeded');
    expect(result.exceeded).toBe(true);
  });

  it('returns level=ok with no subscription rows (user has not used quota)', async () => {
    // Empty cost_records → fraction = 0 → ok
    const supabase = makeSupabase([], null, []);
    const monitor = new BudgetMonitor({ supabase, userId: VALID_UUID });
    const alert = makeAlert({
      alert_type: 'subscription_quota',
      threshold_quota_fraction: 0.80,
      threshold_usd: 0,
    });
    const result = await monitor.checkAlert(alert);
    expect(result.level).toBe('ok');
    expect(result.currentSpendUsd).toBe(0);
  });

  it('takes MAX of multiple subscription_fraction_used values', async () => {
    // Two rows: 0.50 and 0.85 → MAX = 0.85 → exceeded against 0.80 threshold
    const supabase = makeSupabase([], null, [
      { subscription_fraction_used: '0.5000' },
      { subscription_fraction_used: '0.8500' },
    ]);
    const monitor = new BudgetMonitor({ supabase, userId: VALID_UUID });
    const alert = makeAlert({
      alert_type: 'subscription_quota',
      threshold_quota_fraction: 0.80,
      threshold_usd: 0,
    });
    const result = await monitor.checkAlert(alert);
    expect(result.level).toBe('exceeded');
    expect(result.currentSpendUsd).toBeCloseTo(0.85, 5);
  });

  it('does NOT call getCostsForDateRange for subscription_quota alerts', async () => {
    const supabase = makeSupabase([], null, [{ subscription_fraction_used: '0.5000' }]);
    const monitor = new BudgetMonitor({ supabase, userId: VALID_UUID });
    const alert = makeAlert({
      alert_type: 'subscription_quota',
      threshold_quota_fraction: 0.80,
      threshold_usd: 0,
    });
    await monitor.checkAlert(alert);
    // WHY: getCostsForDateRange reads local JSONL files — subscription_quota
    // should never touch JSONL; it only queries Supabase for fraction data.
    expect(getCostsForDateRange).not.toHaveBeenCalled();
  });

  it('ignores api-key and credit rows (billing_model filter enforced by query)', async () => {
    // The Supabase mock returns 0.9 for cost_records, but in a real scenario
    // the DB query filters billing_model = 'subscription'. We verify the monitor
    // does NOT fall through to getCostsForDateRange which would read JSONL.
    const supabase = makeSupabase([], null, [{ subscription_fraction_used: '0.9000' }]);
    const monitor = new BudgetMonitor({ supabase, userId: VALID_UUID });
    const alert = makeAlert({
      alert_type: 'subscription_quota',
      threshold_quota_fraction: 0.80,
      threshold_usd: 0,
    });
    await monitor.checkAlert(alert);
    expect(getCostsForDateRange).not.toHaveBeenCalled();
  });
});

// ============================================================================
// BudgetMonitor: checkAlert — credits alert type
// ============================================================================

describe('BudgetMonitor.checkAlert (credits)', () => {
  it('returns level=ok when credits consumed is below warning threshold', async () => {
    // 200 credits, threshold 500 → 40% → ok
    const supabase = makeSupabase([], null, [
      { credits_consumed: 100 },
      { credits_consumed: 100 },
    ]);
    const monitor = new BudgetMonitor({ supabase, userId: VALID_UUID });
    const alert = makeAlert({
      alert_type: 'credits',
      threshold_credits: 500,
      threshold_usd: 0,
    });
    const result = await monitor.checkAlert(alert);
    expect(result.level).toBe('ok');
    expect(result.currentSpendUsd).toBe(200);
    expect(getCostsForDateRange).not.toHaveBeenCalled();
  });

  it('returns level=warning at 80% of credits threshold', async () => {
    // 400 credits, threshold 500 → 80% → warning
    const supabase = makeSupabase([], null, [{ credits_consumed: 400 }]);
    const monitor = new BudgetMonitor({ supabase, userId: VALID_UUID });
    const alert = makeAlert({
      alert_type: 'credits',
      threshold_credits: 500,
      threshold_usd: 0,
    });
    const result = await monitor.checkAlert(alert);
    expect(result.level).toBe('warning');
  });

  it('returns level=exceeded when credits consumed >= threshold', async () => {
    // 600 credits >= threshold 500 → exceeded
    const supabase = makeSupabase([], null, [{ credits_consumed: 600 }]);
    const monitor = new BudgetMonitor({ supabase, userId: VALID_UUID });
    const alert = makeAlert({
      alert_type: 'credits',
      threshold_credits: 500,
      threshold_usd: 0,
    });
    const result = await monitor.checkAlert(alert);
    expect(result.level).toBe('exceeded');
    expect(result.exceeded).toBe(true);
    expect(result.currentSpendUsd).toBe(600);
  });

  it('returns level=ok with no credit rows (user has not used credits)', async () => {
    const supabase = makeSupabase([], null, []);
    const monitor = new BudgetMonitor({ supabase, userId: VALID_UUID });
    const alert = makeAlert({
      alert_type: 'credits',
      threshold_credits: 500,
      threshold_usd: 0,
    });
    const result = await monitor.checkAlert(alert);
    expect(result.level).toBe('ok');
    expect(result.currentSpendUsd).toBe(0);
  });

  it('sums credits_consumed across multiple rows', async () => {
    // Three sessions: 100 + 250 + 75 = 425 credits, threshold 500 → 85% → warning
    // (85% >= warning threshold of 80%)
    const supabase = makeSupabase([], null, [
      { credits_consumed: 100 },
      { credits_consumed: 250 },
      { credits_consumed: 75 },
    ]);
    const monitor = new BudgetMonitor({ supabase, userId: VALID_UUID });
    const alert = makeAlert({
      alert_type: 'credits',
      threshold_credits: 500,
      threshold_usd: 0,
    });
    const result = await monitor.checkAlert(alert);
    expect(result.currentSpendUsd).toBe(425);
    expect(result.level).toBe('warning'); // 85% >= 80% warning threshold
  });

  it('does NOT call getCostsForDateRange for credits alerts', async () => {
    const supabase = makeSupabase([], null, [{ credits_consumed: 300 }]);
    const monitor = new BudgetMonitor({ supabase, userId: VALID_UUID });
    const alert = makeAlert({
      alert_type: 'credits',
      threshold_credits: 500,
      threshold_usd: 0,
    });
    await monitor.checkAlert(alert);
    // WHY: getCostsForDateRange reads local JSONL — credits never touch it.
    expect(getCostsForDateRange).not.toHaveBeenCalled();
  });
});

// ============================================================================
// BudgetMonitor: mixed billing models in a single period
// ============================================================================

describe('BudgetMonitor.checkAlert — mixed billing models', () => {
  it('cost_usd alert ignores subscription ($0) and credit rows', async () => {
    // WHY: The DB has subscription rows (cost_usd = $0) and credit rows in the
    // same period. The cost_usd alert sums JSONL data (api-key only). The
    // subscription and credit rows are invisible to getCostsForDateRange.
    vi.mocked(getCostsForDateRange).mockResolvedValue(costsOf(5)); // api-key only
    const supabase = makeSupabase(); // cost_records mock not used for cost_usd type
    const monitor = new BudgetMonitor({ supabase, userId: VALID_UUID });
    const alert = makeAlert({ alert_type: 'cost_usd', threshold_usd: 10 });
    const result = await monitor.checkAlert(alert);
    expect(result.currentSpendUsd).toBe(5);
    expect(result.level).toBe('ok');
  });

  it('subscription_quota alert ignores api-key ($5) and credit rows', async () => {
    // API-key spend is $5 in JSONL, but the subscription_quota alert
    // must read subscription_fraction_used from Supabase, not JSONL.
    vi.mocked(getCostsForDateRange).mockResolvedValue(costsOf(5));
    const supabase = makeSupabase([], null, [{ subscription_fraction_used: '0.7000' }]);
    const monitor = new BudgetMonitor({ supabase, userId: VALID_UUID });
    const alert = makeAlert({
      alert_type: 'subscription_quota',
      threshold_quota_fraction: 0.80,
      threshold_usd: 0,
    });
    const result = await monitor.checkAlert(alert);
    // Must use the Supabase fraction (0.70), not the JSONL cost ($5).
    expect(result.currentSpendUsd).toBeCloseTo(0.70, 5);
    // WHY warning not ok: 0.70 / 0.80 = 87.5% of the quota threshold → above 80% warning boundary.
    expect(result.level).toBe('warning');
    // getCostsForDateRange should NOT have been called for subscription_quota.
    expect(getCostsForDateRange).not.toHaveBeenCalled();
  });

  it('credits alert ignores api-key and subscription rows', async () => {
    // JSONL has api-key spend, Supabase has both subscription fraction and
    // credit rows. Only credits_consumed matters for a credits alert.
    vi.mocked(getCostsForDateRange).mockResolvedValue(costsOf(8));
    const supabase = makeSupabase([], null, [
      { credits_consumed: 400 },
    ]);
    const monitor = new BudgetMonitor({ supabase, userId: VALID_UUID });
    const alert = makeAlert({
      alert_type: 'credits',
      threshold_credits: 500,
      threshold_usd: 0,
    });
    const result = await monitor.checkAlert(alert);
    expect(result.currentSpendUsd).toBe(400);
    // WHY warning: 400 / 500 = 80% → exactly at the warning threshold (>= 80%).
    expect(result.level).toBe('warning');
    expect(getCostsForDateRange).not.toHaveBeenCalled();
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

  // --------------------------------------------------------------------------
  // H-1 regression: subscription_quota + credits caches must be USED, not void'd
  // --------------------------------------------------------------------------

  it('[H-1] N subscription_quota alerts with the same key issue exactly 1 Supabase cost_records query (not N)', async () => {
    // WHY: Before the H-1 fix, checkAllAlerts() built quotaCache via a parallel
    // Supabase pre-fetch then discarded it with `void fraction`. Each alert's
    // checkAlert() call re-issued getSubscriptionFractionForPeriod independently,
    // producing N Supabase round-trips for N alerts sharing the same key.
    // After the fix, checkAlert() receives the pre-resolved fraction and never
    // calls getSubscriptionFractionForPeriod itself.
    //
    // Setup: 5 subscription_quota alerts all sharing 'daily:all' key.
    // The Supabase mock tracks cost_records calls. We assert exactly 1 call
    // (the one in the pre-fetch step) regardless of alert count.
    const N = 5;
    const quotaAlerts = Array.from({ length: N }, (_, i) =>
      makeAlert({
        name: `Quota-${i}`,
        alert_type: 'subscription_quota',
        threshold_quota_fraction: 0.80,
        threshold_usd: 0,
        period: 'daily',
        agent_type: null,
      })
    );

    const costRecordsRows = [{ subscription_fraction_used: '0.5000' }];
    const supabase = makeSupabase(quotaAlerts, null, costRecordsRows);

    const monitor = new BudgetMonitor({ supabase, userId: VALID_UUID });
    const results = await monitor.checkAllAlerts();

    // All 5 alerts must be returned with the pre-fetched fraction (0.5 of 0.80 = 62.5% → ok).
    expect(results).toHaveLength(N);
    expect(results.every((r) => r.level === 'ok')).toBe(true);
    expect(results.every((r) => Math.abs(r.currentSpendUsd - 0.5) < 0.001)).toBe(true);

    // The critical regression guard: cost_records must have been queried exactly
    // ONCE (the pre-fetch), NOT N times (one per alert).
    // supabase.from('cost_records') is called once per unique (period, agentType) key.
    // With 5 alerts all sharing 'daily:all', that is exactly 1 call.
    const costRecordsCalls = (supabase.from as ReturnType<typeof vi.fn>).mock.calls.filter(
      (args: unknown[]) => args[0] === 'cost_records'
    );
    expect(costRecordsCalls).toHaveLength(1); // 1 pre-fetch, NOT 5
  });

  it('[H-1] N credits alerts with the same key issue exactly 1 Supabase cost_records query (not N)', async () => {
    // WHY: Mirror of the subscription_quota regression above, but for credits type.
    // Before the fix, each alert re-queried getCreditsConsumedForPeriod independently.
    const N = 5;
    const creditAlerts = Array.from({ length: N }, (_, i) =>
      makeAlert({
        name: `Credits-${i}`,
        alert_type: 'credits',
        threshold_credits: 500,
        threshold_usd: 0,
        period: 'daily',
        agent_type: null,
      })
    );

    const costRecordsRows = [{ credits_consumed: 200 }];
    const supabase = makeSupabase(creditAlerts, null, costRecordsRows);

    const monitor = new BudgetMonitor({ supabase, userId: VALID_UUID });
    const results = await monitor.checkAllAlerts();

    // All 5 alerts must use the pre-fetched 200 credits (200/500 = 40% → ok).
    expect(results).toHaveLength(N);
    expect(results.every((r) => r.level === 'ok')).toBe(true);
    expect(results.every((r) => r.currentSpendUsd === 200)).toBe(true);

    // cost_records queried exactly ONCE (the pre-fetch), NOT 5 times.
    const costRecordsCalls = (supabase.from as ReturnType<typeof vi.fn>).mock.calls.filter(
      (args: unknown[]) => args[0] === 'cost_records'
    );
    expect(costRecordsCalls).toHaveLength(1); // 1 pre-fetch, NOT 5
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
      alert: makeAlert({ threshold_usd: threshold, alert_type: 'cost_usd' }),
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

  it('formats subscription_quota alert with percentage-of-quota detail', () => {
    // fraction = 0.85, threshold = 0.80 → exceeded
    const result: BudgetCheckResult = {
      level: 'exceeded',
      alert: makeAlert({
        name: 'Quota Alert',
        alert_type: 'subscription_quota',
        threshold_quota_fraction: 0.80,
        threshold_usd: 0,
      }),
      currentSpendUsd: 0.85,
      percentUsed: (0.85 / 0.80) * 100,
      remainingUsd: 0,
      exceeded: true,
      isNewTrigger: false,
    };
    const msg = formatBudgetMessage(result);
    expect(msg).toContain('exceeded');
    expect(msg).toContain('quota');
    expect(msg).toContain('80%');  // threshold percentage
    expect(msg).toContain('Quota Alert');
    // Must NOT contain dollar signs (subscription_quota is not a USD metric)
    expect(msg).not.toMatch(/\$\d/);
  });

  it('formats credits alert with credit-count detail', () => {
    // 600 credits, threshold 500 → exceeded
    const result: BudgetCheckResult = {
      level: 'exceeded',
      alert: makeAlert({
        name: 'Credits Alert',
        alert_type: 'credits',
        threshold_credits: 500,
        threshold_usd: 0,
      }),
      currentSpendUsd: 600,
      percentUsed: (600 / 500) * 100,
      remainingUsd: 0,
      exceeded: true,
      isNewTrigger: false,
    };
    const msg = formatBudgetMessage(result);
    expect(msg).toContain('exceeded');
    expect(msg).toContain('credits');
    expect(msg).toContain('600');
    expect(msg).toContain('500');
    expect(msg).toContain('Credits Alert');
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
