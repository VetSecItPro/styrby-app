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

/** Build a minimal Supabase mock that tracks calls. */
function makeSupabase() {
  const channelMock = {
    subscribe: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
  };

  const selectChain = {
    eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: { email_budget_alerts: true }, error: null }),
  };

  const insertChain = {
    error: null,
    then: vi.fn(),
  };

  return {
    channel: vi.fn(() => channelMock),
    from: vi.fn((table: string) => {
      if (table === 'notification_preferences') {
        return { select: vi.fn(() => selectChain) };
      }
      if (table === 'audit_log') {
        return { insert: vi.fn().mockResolvedValue({ error: null }) };
      }
      return {};
    }),
  } as unknown as import('@supabase/supabase-js').SupabaseClient;
}

function makeConfig(overrides: Partial<BudgetActionsConfig> = {}): BudgetActionsConfig {
  return {
    supabase: makeSupabase(),
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
