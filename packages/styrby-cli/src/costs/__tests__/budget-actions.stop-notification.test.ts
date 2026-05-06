/**
 * Tests for BudgetActions stop-notification failure handling (B4-Wave2).
 *
 * WHY: When a budget alert fires `hard_stop`, the action chain calls
 * `relayClient.send({ action: 'end_session' })` to tell the mobile UI the
 * session is being terminated. If that send rejects (relay disconnected,
 * server returning 5xx), the previous code silently swallowed via
 * `this.log()` — which only emits when `config.debug=true`. In production,
 * the failure was completely invisible.
 *
 * The fix upgrades to `logger.warn` with structured context so ops can see
 * the failure even though the local stop callback still fires (CLI does
 * halt; only the mobile-side notification is lost).
 *
 * @module costs/__tests__/budget-actions.stop-notification
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================================
// Mocks
// ============================================================================

const { mockLoggerWarn } = vi.hoisted(() => ({
  mockLoggerWarn: vi.fn(),
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: mockLoggerWarn,
    error: vi.fn(),
  },
}));

vi.mock('@styrby/shared/pricing', () => ({
  getModelPriceSync: vi.fn(() => ({
    inputPer1k: 0.003,
    outputPer1k: 0.015,
    cachePer1k: 0.0003,
    cacheWritePer1k: 0.00375,
  })),
}));

vi.mock('../jsonl-parser.js', () => ({
  getCostsForDateRange: vi.fn(async () => ({
    totalCostUsd: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    entries: [],
  })),
}));

import { BudgetActions, type BudgetActionsConfig } from '../budget-actions.js';
import type { BudgetAlert, BudgetCheckResult } from '../budget-monitor.js';
import type { RelayClient } from 'styrby-shared';

// ============================================================================
// Fixtures
// ============================================================================

const VALID_UUID = '12345678-1234-4234-8234-123456789abc';

function makeAlert(overrides: Partial<BudgetAlert> = {}): BudgetAlert {
  return {
    id: VALID_UUID,
    user_id: VALID_UUID,
    name: 'Daily Budget',
    threshold_usd: 50,
    period: 'daily',
    agent_type: null,
    action: 'hard_stop',
    notification_channels: ['in_app'],
    is_enabled: true,
    last_triggered_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeExceededResult(): BudgetCheckResult {
  return {
    level: 'exceeded',
    alert: makeAlert(),
    currentSpendUsd: 75,
    percentUsed: 150,
    remainingUsd: -25,
    exceeded: true,
    isNewTrigger: true,
  };
}

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

function makeApiClient() {
  return {
    getNotificationPreferences: vi.fn(async () => ({ preferences: null })),
    writeAuditEvent: vi.fn(async () => ({ id: 'a-1', created_at: new Date().toISOString() })),
  } as unknown as import('@/api/styrbyApiClient').StyrbyApiClient;
}

function makeConfig(overrides: Partial<BudgetActionsConfig> = {}): BudgetActionsConfig {
  return {
    supabase: makeSupabase(),
    apiClient: makeApiClient(),
    userId: VALID_UUID,
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('BudgetActions stop-notification failure (B4-Wave2)', () => {
  beforeEach(() => {
    mockLoggerWarn.mockClear();
  });

  it('logs at WARN with alert context when relayClient.send rejects', async () => {
    const failingRelay: RelayClient = {
      send: vi.fn().mockRejectedValue(new Error('relay-disconnected')),
    } as unknown as RelayClient;

    const onStopSession = vi.fn().mockResolvedValue(undefined);
    const actions = new BudgetActions(
      makeConfig({ relayClient: failingRelay, onStopSession })
    );

    // hard_stop action triggers stopSession()
    await actions.executeAction(makeExceededResult());

    expect(mockLoggerWarn).toHaveBeenCalled();
    const [msg, ctx] = mockLoggerWarn.mock.calls[0] as [string, Record<string, unknown>];
    expect(msg).toContain('stop-notification failed');
    // Structured context — ops can grep by alert ID
    expect(ctx.alertId).toBe(VALID_UUID);
    expect(ctx.alertName).toBe('Daily Budget');
    expect(ctx.error).toBe('relay-disconnected');
  });

  it('local stop callback STILL fires even when relay-notification fails (CLI halts regardless)', async () => {
    const failingRelay: RelayClient = {
      send: vi.fn().mockRejectedValue(new Error('relay-down')),
    } as unknown as RelayClient;

    const onStopSession = vi.fn().mockResolvedValue(undefined);
    const actions = new BudgetActions(
      makeConfig({ relayClient: failingRelay, onStopSession })
    );

    await actions.executeAction(makeExceededResult());

    // The CLI-side stop must still fire — mobile-notification failure
    // does NOT stop the user from being protected from over-spend
    expect(onStopSession).toHaveBeenCalledTimes(1);
  });

  it('does NOT log warn when relay-notification succeeds (no spam on happy path)', async () => {
    const okRelay: RelayClient = {
      send: vi.fn().mockResolvedValue(undefined),
    } as unknown as RelayClient;

    const actions = new BudgetActions(
      makeConfig({ relayClient: okRelay, onStopSession: vi.fn() })
    );

    await actions.executeAction(makeExceededResult());

    // No warn fired; the only path that warns is rejection
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  it('handles non-Error rejections from relay (string, plain object) without crashing', async () => {
    const stringRejecting: RelayClient = {
      send: vi.fn().mockRejectedValue('relay-error-string'),
    } as unknown as RelayClient;

    const actions = new BudgetActions(
      makeConfig({ relayClient: stringRejecting, onStopSession: vi.fn() })
    );

    await actions.executeAction(makeExceededResult());

    expect(mockLoggerWarn).toHaveBeenCalled();
    const [, ctx] = mockLoggerWarn.mock.calls[0] as [string, Record<string, unknown>];
    expect(ctx.error).toBe('relay-error-string');
  });
});
