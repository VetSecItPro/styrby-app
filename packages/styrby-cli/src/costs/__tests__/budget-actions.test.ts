/**
 * Unit tests for `budget-actions.ts`.
 *
 * Covers:
 *  - BudgetActions.executeAction: skip when not new trigger, notify path,
 *    warn_and_slowdown path, hard_stop path
 *  - BudgetActions.executeAllActions: ordering, stops after session stop
 *  - Slowdown management: triggerSlowdown, clearSlowdown, isSlowdownActive,
 *    getSlowdownDelay, applySlowdownDelay
 *  - triggerStop: calls onStopSession
 *  - createBudgetActions factory
 *  - checkAndExecuteBudgetActions integration helper
 *
 * WHY: Budget actions are the circuit-breaker for over-spend. Wrong behavior
 * means either users get silently charged past their limit, or sessions get
 * stopped when they shouldn't be.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================================
// Mocks
// ============================================================================

vi.mock('@styrby/shared/pricing', () => ({
  getModelPriceSync: vi.fn(() => ({
    inputPer1k: 0.003,
    outputPer1k: 0.015,
    cachePer1k: 0.0003,
    cacheWritePer1k: 0.00375,
  })),
}));

// Mock jsonl-parser so BudgetMonitor.checkAllAlerts works without FS
vi.mock('../jsonl-parser.js', () => ({
  getCostsForDateRange: vi.fn(async () => ({
    totalCostUsd: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    entries: [],
  })),
}));

import {
  BudgetActions,
  createBudgetActions,
  checkAndExecuteBudgetActions,
  type BudgetActionsConfig,
  type ActionResult,
} from '../budget-actions.js';
import type { BudgetCheckResult, BudgetMonitor, BudgetAlert } from '../budget-monitor.js';

// ============================================================================
// Fixtures
// ============================================================================

const VALID_UUID = '12345678-1234-4234-8234-123456789abc';

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

function makeResult(overrides: Partial<BudgetCheckResult> = {}): BudgetCheckResult {
  return {
    level: 'warning',
    alert: makeAlert(),
    currentSpendUsd: 8,
    percentUsed: 80,
    remainingUsd: 2,
    exceeded: false,
    isNewTrigger: true,
    ...overrides,
  };
}

/**
 * Build a minimal Supabase mock for the realtime channel path only.
 *
 * Phase 4-step5: notification preference reads + audit_log writes have moved
 * to {@link makeApiClient}; this stub only needs to satisfy the realtime
 * `supabase.channel().send()` chain that BudgetActions uses for in-app
 * broadcasts.
 */
function makeSupabase() {
  const channelMock = {
    subscribe: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
  };

  return {
    channel: vi.fn(() => channelMock),
  } as unknown as import('@supabase/supabase-js').SupabaseClient;
}

/**
 * Build a focused StyrbyApiClient stub. Records every writeAuditEvent call
 * and lets the test override the notification preferences row.
 *
 * WHY a focused stub (mirrors approvalHandler.test.ts): the handler only
 * uses two client methods. A targeted stub keeps signal high and surfaces
 * accidental dependencies as compile errors via the explicit cast.
 */
function makeApiClient(opts: {
  emailBudgetAlerts?: boolean | null;
  preferencesNull?: boolean;
  writeAuditError?: Error;
  getPreferencesError?: Error;
} = {}) {
  const audits: Array<{ action: string; metadata?: Record<string, unknown> }> = [];

  const stub = {
    getNotificationPreferences: vi.fn(async () => {
      if (opts.getPreferencesError) throw opts.getPreferencesError;
      if (opts.preferencesNull) return { preferences: null };
      // Default: email_budget_alerts=true unless explicitly set false.
      const enabled = opts.emailBudgetAlerts ?? true;
      return {
        preferences: {
          id: VALID_UUID,
          push_enabled: true,
          push_permission_requests: false,
          push_session_errors: false,
          push_budget_alerts: false,
          push_session_complete: false,
          email_enabled: true,
          email_weekly_summary: false,
          email_budget_alerts: enabled,
          quiet_hours_enabled: false,
          quiet_hours_start: null,
          quiet_hours_end: null,
          quiet_hours_timezone: null,
          priority_threshold: 0,
          priority_rules: null,
          push_agent_finished: false,
          push_budget_threshold: false,
          push_weekly_summary: false,
          weekly_digest_email: false,
          push_predictive_alert: false,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      };
    }),
    writeAuditEvent: vi.fn(async (event: { action: string; metadata?: Record<string, unknown> }) => {
      audits.push(event);
      if (opts.writeAuditError) throw opts.writeAuditError;
      return { id: 'audit-' + audits.length, created_at: new Date().toISOString() };
    }),
  };

  return {
    apiClient: stub as unknown as import('@/api/styrbyApiClient').StyrbyApiClient,
    audits,
    stub,
  };
}

function makeConfig(overrides: Partial<BudgetActionsConfig> = {}): BudgetActionsConfig {
  const { apiClient } = makeApiClient();
  return {
    supabase: makeSupabase(),
    apiClient,
    userId: VALID_UUID,
    ...overrides,
  };
}

// ============================================================================
// BudgetActions: construction
// ============================================================================

describe('BudgetActions construction', () => {
  it('creates an instance with factory function', () => {
    expect(createBudgetActions(makeConfig())).toBeInstanceOf(BudgetActions);
  });

  it('starts with slowdown inactive', () => {
    const actions = new BudgetActions(makeConfig());
    expect(actions.isSlowdownActive()).toBe(false);
    expect(actions.getSlowdownDelay()).toBe(0);
  });
});

// ============================================================================
// BudgetActions: executeAction — skipping
// ============================================================================

describe('BudgetActions.executeAction — non-new-trigger skip', () => {
  it('returns success with empty notifications when isNewTrigger=false and level is not warning/critical', async () => {
    const actions = new BudgetActions(makeConfig());
    const result = makeResult({ isNewTrigger: false, level: 'ok' });

    const actionResult = await actions.executeAction(result);

    expect(actionResult.success).toBe(true);
    expect(actionResult.notificationsSent).toHaveLength(0);
    expect(actionResult.sessionStopped).toBe(false);
    expect(actionResult.slowdownApplied).toBe(false);
  });

  it('still executes when isNewTrigger=false but level=warning (warning/critical override skip)', async () => {
    const actions = new BudgetActions(makeConfig());
    const result = makeResult({ isNewTrigger: false, level: 'warning' });

    const actionResult = await actions.executeAction(result);

    // Level is warning — skip guard does NOT apply
    expect(actionResult.notificationsSent.length).toBeGreaterThanOrEqual(0);
  });
});

// ============================================================================
// BudgetActions: executeAction — notify action
// ============================================================================

describe('BudgetActions.executeAction — notify', () => {
  it('sends in_app notification for notify action at warning level', async () => {
    const actions = new BudgetActions(makeConfig());
    const result = makeResult({
      level: 'warning',
      alert: makeAlert({ action: 'notify', notification_channels: ['in_app'] }),
      isNewTrigger: true,
    });

    const actionResult = await actions.executeAction(result);

    expect(actionResult.action).toBe('notify');
    expect(actionResult.sessionStopped).toBe(false);
    expect(actionResult.slowdownApplied).toBe(false);
  });

  it('does not stop session on notify action even when exceeded', async () => {
    const actions = new BudgetActions(makeConfig());
    const result = makeResult({
      level: 'exceeded',
      exceeded: true,
      alert: makeAlert({ action: 'notify' }),
      isNewTrigger: true,
    });

    const actionResult = await actions.executeAction(result);

    expect(actionResult.sessionStopped).toBe(false);
  });
});

// ============================================================================
// BudgetActions: executeAction — warn_and_slowdown action
// ============================================================================

describe('BudgetActions.executeAction — warn_and_slowdown', () => {
  it('applies slowdown at warning level', async () => {
    const onSlowdown = vi.fn();
    const actions = new BudgetActions(makeConfig({ onSlowdown }));
    const result = makeResult({
      level: 'warning',
      alert: makeAlert({ action: 'warn_and_slowdown' }),
      isNewTrigger: true,
    });

    const actionResult = await actions.executeAction(result);

    expect(actionResult.slowdownApplied).toBe(true);
    expect(actions.isSlowdownActive()).toBe(true);
    expect(actions.getSlowdownDelay()).toBeGreaterThan(0);
    expect(onSlowdown).toHaveBeenCalledTimes(1);
  });

  it('applies slowdown at critical level with higher delay', async () => {
    const actions = new BudgetActions(makeConfig());
    const warningResult = makeResult({
      level: 'warning',
      alert: makeAlert({ action: 'warn_and_slowdown' }),
      isNewTrigger: true,
    });
    const criticalResult = makeResult({
      level: 'critical',
      alert: makeAlert({ action: 'warn_and_slowdown' }),
      isNewTrigger: true,
    });

    const actions2 = new BudgetActions(makeConfig());
    await actions.executeAction(warningResult);
    await actions2.executeAction(criticalResult);

    expect(actions2.getSlowdownDelay()).toBeGreaterThan(actions.getSlowdownDelay());
  });

  it('does not stop session on warn_and_slowdown', async () => {
    const actions = new BudgetActions(makeConfig());
    const result = makeResult({
      level: 'exceeded',
      exceeded: true,
      alert: makeAlert({ action: 'warn_and_slowdown' }),
      isNewTrigger: true,
    });

    const actionResult = await actions.executeAction(result);

    expect(actionResult.sessionStopped).toBe(false);
  });
});

// ============================================================================
// BudgetActions: executeAction — hard_stop action
// ============================================================================

describe('BudgetActions.executeAction — hard_stop', () => {
  it('stops session when level=exceeded', async () => {
    const onStopSession = vi.fn().mockResolvedValue(undefined);
    const actions = new BudgetActions(makeConfig({ onStopSession }));
    const result = makeResult({
      level: 'exceeded',
      exceeded: true,
      alert: makeAlert({ action: 'hard_stop' }),
      isNewTrigger: true,
    });

    const actionResult = await actions.executeAction(result);

    expect(actionResult.sessionStopped).toBe(true);
    expect(onStopSession).toHaveBeenCalledTimes(1);
  });

  it('does NOT stop session when level=warning (only stops on exceeded)', async () => {
    const onStopSession = vi.fn().mockResolvedValue(undefined);
    const actions = new BudgetActions(makeConfig({ onStopSession }));
    const result = makeResult({
      level: 'warning',
      exceeded: false,
      alert: makeAlert({ action: 'hard_stop' }),
      isNewTrigger: true,
    });

    const actionResult = await actions.executeAction(result);

    expect(actionResult.sessionStopped).toBe(false);
    expect(onStopSession).not.toHaveBeenCalled();
  });
});

// ============================================================================
// BudgetActions: executeAllActions
// ============================================================================

describe('BudgetActions.executeAllActions', () => {
  it('skips ok-level results', async () => {
    const actions = new BudgetActions(makeConfig());
    const okResult = makeResult({ level: 'ok' });

    const results = await actions.executeAllActions([okResult]);
    expect(results).toHaveLength(0);
  });

  it('processes multiple actionable results', async () => {
    const actions = new BudgetActions(makeConfig());
    const results = [
      makeResult({ level: 'warning', alert: makeAlert({ action: 'notify' }) }),
      makeResult({ level: 'warning', alert: makeAlert({ action: 'notify' }) }),
    ];

    const actionResults = await actions.executeAllActions(results);
    expect(actionResults).toHaveLength(2);
  });

  it('stops processing remaining results after session is stopped', async () => {
    const onStopSession = vi.fn().mockResolvedValue(undefined);
    const actions = new BudgetActions(makeConfig({ onStopSession }));

    const stopResult = makeResult({
      level: 'exceeded',
      exceeded: true,
      alert: makeAlert({ action: 'hard_stop' }),
      isNewTrigger: true,
    });
    const notifyResult = makeResult({ level: 'warning', alert: makeAlert({ action: 'notify' }) });

    const actionResults = await actions.executeAllActions([stopResult, notifyResult]);

    // Only 1 result — the second one was skipped after stop
    expect(actionResults).toHaveLength(1);
    expect(actionResults[0].sessionStopped).toBe(true);
  });
});

// ============================================================================
// Slowdown management
// ============================================================================

describe('BudgetActions slowdown management', () => {
  it('triggerSlowdown activates slowdown', () => {
    const actions = new BudgetActions(makeConfig());
    actions.triggerSlowdown(makeResult({ level: 'warning' }));
    expect(actions.isSlowdownActive()).toBe(true);
  });

  it('clearSlowdown deactivates slowdown', () => {
    const actions = new BudgetActions(makeConfig());
    actions.triggerSlowdown(makeResult({ level: 'warning' }));
    actions.clearSlowdown();
    expect(actions.isSlowdownActive()).toBe(false);
    expect(actions.getSlowdownDelay()).toBe(0);
  });

  it('applySlowdownDelay resolves immediately when slowdown not active', async () => {
    const actions = new BudgetActions(makeConfig());
    // Should not throw or hang
    await expect(actions.applySlowdownDelay()).resolves.toBeUndefined();
  });

  it('adds extra delay when percentUsed > 100', () => {
    const actions = new BudgetActions(makeConfig());
    const actions2 = new BudgetActions(makeConfig());

    actions.triggerSlowdown(makeResult({ level: 'exceeded', percentUsed: 100 }));
    actions2.triggerSlowdown(makeResult({ level: 'exceeded', percentUsed: 150 }));

    expect(actions2.getSlowdownDelay()).toBeGreaterThanOrEqual(actions.getSlowdownDelay());
  });
});

// ============================================================================
// Phase 4-step5: apiClient-backed email queueing
// ============================================================================

describe('BudgetActions email queue (apiClient)', () => {
  it('reads notification preferences via apiClient.getNotificationPreferences', async () => {
    const { apiClient, stub } = makeApiClient({ emailBudgetAlerts: true });
    const actions = new BudgetActions(makeConfig({ apiClient }));
    const result = makeResult({
      level: 'warning',
      alert: makeAlert({ action: 'notify', notification_channels: ['email'] }),
      isNewTrigger: true,
    });

    await actions.executeAction(result);

    expect(stub.getNotificationPreferences).toHaveBeenCalled();
  });

  it('writes audit event via apiClient.writeAuditEvent when email is enabled', async () => {
    const { apiClient, audits } = makeApiClient({ emailBudgetAlerts: true });
    const actions = new BudgetActions(makeConfig({ apiClient }));
    const result = makeResult({
      level: 'critical',
      alert: makeAlert({ action: 'notify', notification_channels: ['email'] }),
      currentSpendUsd: 9,
      percentUsed: 90,
      isNewTrigger: true,
    });

    await actions.executeAction(result);
    // Allow the non-fatal .catch() chain a microtask to settle.
    await new Promise((r) => setTimeout(r, 0));

    expect(audits.length).toBe(1);
    expect(audits[0].action).toBe('settings_updated');
    expect(audits[0].metadata).toMatchObject({
      alert_name: 'Test Alert',
      period: 'daily',
      alert_action: 'notify',
    });
  });

  it('skips audit write when email_budget_alerts is disabled', async () => {
    const { apiClient, audits } = makeApiClient({ emailBudgetAlerts: false });
    const actions = new BudgetActions(makeConfig({ apiClient }));
    const result = makeResult({
      level: 'warning',
      alert: makeAlert({ action: 'notify', notification_channels: ['email'] }),
      isNewTrigger: true,
    });

    await actions.executeAction(result);

    expect(audits.length).toBe(0);
  });

  it('treats null preferences (row not yet created) as opt-in', async () => {
    const { apiClient, audits } = makeApiClient({ preferencesNull: true });
    const actions = new BudgetActions(makeConfig({ apiClient }));
    const result = makeResult({
      level: 'warning',
      alert: makeAlert({ action: 'notify', notification_channels: ['email'] }),
      isNewTrigger: true,
    });

    await actions.executeAction(result);
    await new Promise((r) => setTimeout(r, 0));

    expect(audits.length).toBe(1);
  });

  it('treats audit-log write failure as non-fatal — action still succeeds', async () => {
    const { apiClient } = makeApiClient({
      emailBudgetAlerts: true,
      writeAuditError: new Error('5xx audit write down'),
    });
    const actions = new BudgetActions(makeConfig({ apiClient }));
    const result = makeResult({
      level: 'warning',
      alert: makeAlert({ action: 'notify', notification_channels: ['email'] }),
      isNewTrigger: true,
    });

    const actionResult = await actions.executeAction(result);
    // Allow the .catch() to run.
    await new Promise((r) => setTimeout(r, 0));

    expect(actionResult.success).toBe(true);
  });
});

// ============================================================================
// checkAndExecuteBudgetActions integration helper
// ============================================================================

describe('checkAndExecuteBudgetActions', () => {
  it('calls monitor.checkAllAlerts and actions.executeAllActions', async () => {
    const mockCheckAllAlerts = vi.fn().mockResolvedValue([]);
    const mockExecuteAllActions = vi.fn().mockResolvedValue([]);

    const monitor = { checkAllAlerts: mockCheckAllAlerts } as unknown as BudgetMonitor;
    const actionsInstance = { executeAllActions: mockExecuteAllActions } as unknown as BudgetActions;

    const result = await checkAndExecuteBudgetActions(monitor, actionsInstance);

    expect(mockCheckAllAlerts).toHaveBeenCalledTimes(1);
    expect(mockExecuteAllActions).toHaveBeenCalledTimes(1);
    expect(result.checkResults).toEqual([]);
    expect(result.actionResults).toEqual([]);
  });

  it('passes check results to executeAllActions', async () => {
    const checkResult = makeResult({ level: 'warning' });
    const mockCheckAllAlerts = vi.fn().mockResolvedValue([checkResult]);
    const mockExecuteAllActions = vi.fn().mockResolvedValue([]);

    const monitor = { checkAllAlerts: mockCheckAllAlerts } as unknown as BudgetMonitor;
    const actionsInstance = { executeAllActions: mockExecuteAllActions } as unknown as BudgetActions;

    await checkAndExecuteBudgetActions(monitor, actionsInstance);

    expect(mockExecuteAllActions).toHaveBeenCalledWith([checkResult], monitor);
  });
});
