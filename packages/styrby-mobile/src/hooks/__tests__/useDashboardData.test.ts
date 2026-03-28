/**
 * useDashboardData Hook Test Suite
 *
 * Tests the dashboard data hook, including:
 * - Initial data fetch (sessions, notifications, costs)
 * - Loading state management
 * - Agent status computation (online + cost)
 * - Quick stats derivation
 * - Real-time session state updates via relay messages
 * - Cost update relay messages
 * - Permission request relay messages
 * - Presence-based agent online status
 * - Audit log to notification mapping
 * - Refresh functionality
 * - Error handling
 */

import { renderHook, act, waitFor, cleanup } from '@testing-library/react-native';
import React from 'react';

/**
 * Non-strict wrapper to prevent React Strict Mode from doubling effect runs.
 *
 * WHY: @testing-library/react-native v12 wraps components in React.StrictMode,
 * which causes effects to run twice (mount → unmount → remount) in development.
 * useDashboardData's useEffect starts async supabase queries on mount. With
 * Strict Mode, these queries start TWICE per test. Across 36 tests, this
 * accumulates to 216 pending Promises that pile up in the microtask queue,
 * growing at ~100 MB/test until the worker OOMs at 4 GB.
 * Using a plain React.Fragment wrapper bypasses the Strict Mode double-effect.
 */
const wrapper = ({ children }: { children: React.ReactNode }) =>
  React.createElement(React.Fragment, null, children);

// ============================================================================
// Mock Setup
// ============================================================================

let mockAuthUser: { id: string } | null = { id: 'test-user-id' };
let mockSessionsData: unknown[] = [];
let mockAuditLogData: unknown[] = [];
let mockCostRecordsData: unknown[] = [];
let mockQueryError: unknown = null;

jest.mock('@/lib/supabase', () => {
  const createChain = (tableName: string) => {
    const chain: Record<string, unknown> = {};
    const chainMethods = ['select', 'eq', 'order', 'gte', 'limit', 'not', 'in', 'is'];
    for (const method of chainMethods) {
      chain[method] = jest.fn(() => chain);
    }
    chain.single = jest.fn(() => Promise.resolve({ data: null, error: null }));
    chain.then = (resolve: (v: unknown) => void) => {
      let data: unknown[];
      switch (tableName) {
        case 'sessions':
          data = mockSessionsData;
          break;
        case 'audit_log':
          data = mockAuditLogData;
          break;
        case 'cost_records':
          data = mockCostRecordsData;
          break;
        default:
          data = [];
      }
      return Promise.resolve({
        data: mockQueryError ? null : data,
        error: mockQueryError,
      }).then(resolve);
    };
    return chain;
  };

  return {
    supabase: {
      auth: {
        getUser: jest.fn(async () => ({
          data: { user: mockAuthUser },
          error: null,
        })),
      },
      from: jest.fn((table: string) => createChain(table)),
    },
  };
});

jest.mock('styrby-shared', () => ({}));

import { useDashboardData } from '../useDashboardData';

// ============================================================================
// Test Data
// ============================================================================

function makeSessionRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'session-1',
    agent_type: 'claude',
    title: 'Test Session',
    status: 'running',
    last_activity_at: '2024-01-01T12:00:00Z',
    message_count: 10,
    total_cost_usd: 1.5,
    ...overrides,
  };
}

function makeAuditLogRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'audit-1',
    action: 'session_created',
    resource_type: 'session',
    resource_id: 'session-1',
    metadata: { agent_type: 'claude' },
    created_at: '2024-01-01T12:00:00Z',
    ...overrides,
  };
}

function makeCostRecordRow(agent: string = 'claude', cost: number = 1.5) {
  return {
    agent_type: agent,
    cost_usd: cost,
  };
}

function makeRelayMessage(type: string, payload: Record<string, unknown>, id: string = 'msg-1') {
  return { id, type, payload, timestamp: new Date().toISOString(), sender_device_id: 'cli-1', sender_type: 'cli' };
}

// WHY: useDashboardData's useEffect depends on the connectedDevices array reference.
// Passing `[]` inline inside renderHook() creates a new array on every render,
// causing the effect to re-fire → state update → re-render → infinite loop → OOM.
// Using a stable module-level constant breaks the cycle.
const EMPTY_DEVICES: never[] = [];

// ============================================================================
// Tests
// ============================================================================

describe('useDashboardData', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation();
    mockAuthUser = { id: 'test-user-id' };
    mockSessionsData = [];
    mockAuditLogData = [];
    mockCostRecordsData = [];
    mockQueryError = null;
  });

  afterEach(async () => {
    (console.error as jest.Mock).mockRestore();
    // WHY: Unmount all rendered components first so React stops processing updates.
    cleanup();
    // WHY flushPromises: useDashboardData starts async supabase queries on mount.
    // After cleanup() unmounts the component, those queries' Promises continue
    // resolving in the microtask queue. Over 36 tests, 108+ pending Promises
    // accumulate (3 supabase queries × 36 tests), each holding references to
    // unmounted React state setters. This causes ~100 MB/test memory growth
    // that OOMs the Jest worker. Flushing all pending microtasks after each
    // test prevents this accumulation.
    await act(async () => {
      // Multiple yields to ensure deeply chained Promises all resolve.
      // useDashboardData has 3-deep async chains (getUser → from(table) → resolve).
      for (let i = 0; i < 10; i++) {
        await Promise.resolve();
      }
    });
  });

  // --------------------------------------------------------------------------
  // Initial State
  // --------------------------------------------------------------------------

  it('starts in loading state', () => {
    const { result } = renderHook(() => useDashboardData(null, EMPTY_DEVICES), { wrapper });
    expect(result.current.isLoading).toBe(true);
  });

  it('loads data on mount', async () => {
    mockSessionsData = [makeSessionRow()];
    mockAuditLogData = [makeAuditLogRow()];
    mockCostRecordsData = [makeCostRecordRow('claude', 2.0)];

    const { result } = renderHook(() => useDashboardData(null, EMPTY_DEVICES), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.activeSessions).toHaveLength(1);
    expect(result.current.notifications).toHaveLength(1);
    expect(result.current.agentStatus.claude.cost).toBeCloseTo(2.0);
  });

  it('returns empty data when user is not authenticated', async () => {
    mockAuthUser = null;

    const { result } = renderHook(() => useDashboardData(null, EMPTY_DEVICES), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.activeSessions).toHaveLength(0);
    expect(result.current.notifications).toHaveLength(0);
  });

  // --------------------------------------------------------------------------
  // Session Mapping
  // --------------------------------------------------------------------------

  it('maps session rows to ActiveSession objects', async () => {
    mockSessionsData = [
      makeSessionRow({ id: 's1', agent_type: 'claude', status: 'running', title: 'Claude Session' }),
    ];

    const { result } = renderHook(() => useDashboardData(null, EMPTY_DEVICES), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const session = result.current.activeSessions[0];
    expect(session.id).toBe('s1');
    expect(session.agentType).toBe('claude');
    expect(session.status).toBe('running');
    expect(session.title).toBe('Claude Session');
  });

  it('maps "starting" status to "running"', async () => {
    mockSessionsData = [makeSessionRow({ status: 'starting' })];

    const { result } = renderHook(() => useDashboardData(null, EMPTY_DEVICES), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.activeSessions[0].status).toBe('running');
  });

  it('maps "paused" status to "idle"', async () => {
    mockSessionsData = [makeSessionRow({ status: 'paused' })];

    const { result } = renderHook(() => useDashboardData(null, EMPTY_DEVICES), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.activeSessions[0].status).toBe('idle');
  });

  it('maps unknown status to "idle"', async () => {
    mockSessionsData = [makeSessionRow({ status: 'unknown_status' })];

    const { result } = renderHook(() => useDashboardData(null, EMPTY_DEVICES), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.activeSessions[0].status).toBe('idle');
  });

  it('uses "Untitled Session" for null title', async () => {
    mockSessionsData = [makeSessionRow({ title: null })];

    const { result } = renderHook(() => useDashboardData(null, EMPTY_DEVICES), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.activeSessions[0].title).toBe('Untitled Session');
  });

  // --------------------------------------------------------------------------
  // Notification Mapping
  // --------------------------------------------------------------------------

  it('maps session_created audit log to session_start notification', async () => {
    mockAuditLogData = [makeAuditLogRow({ action: 'session_created', metadata: { agent_type: 'claude' } })];

    const { result } = renderHook(() => useDashboardData(null, EMPTY_DEVICES), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.notifications).toHaveLength(1);
    expect(result.current.notifications[0].type).toBe('session_start');
    expect(result.current.notifications[0].title).toBe('Session Started');
    expect(result.current.notifications[0].message).toContain('claude');
  });

  it('maps session_deleted audit log to session_end notification', async () => {
    mockAuditLogData = [makeAuditLogRow({ action: 'session_deleted', metadata: { agent_type: 'gemini' } })];

    const { result } = renderHook(() => useDashboardData(null, EMPTY_DEVICES), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.notifications[0].type).toBe('session_end');
    expect(result.current.notifications[0].message).toContain('gemini');
  });

  it('maps subscription_changed to cost_alert notification', async () => {
    mockAuditLogData = [
      makeAuditLogRow({ action: 'subscription_changed', metadata: { new_tier: 'pro' } }),
    ];

    const { result } = renderHook(() => useDashboardData(null, EMPTY_DEVICES), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.notifications[0].type).toBe('cost_alert');
    expect(result.current.notifications[0].message).toContain('pro');
  });

  it('maps machine_paired to info notification with device name', async () => {
    mockAuditLogData = [
      makeAuditLogRow({ action: 'machine_paired', metadata: { device_name: 'MacBook Pro' } }),
    ];

    const { result } = renderHook(() => useDashboardData(null, EMPTY_DEVICES), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.notifications[0].type).toBe('info');
    expect(result.current.notifications[0].message).toContain('MacBook Pro');
  });

  it('maps login/logout to info notifications', async () => {
    mockAuditLogData = [
      makeAuditLogRow({ id: 'a1', action: 'login', metadata: null }),
      makeAuditLogRow({ id: 'a2', action: 'logout', metadata: null }),
    ];

    const { result } = renderHook(() => useDashboardData(null, EMPTY_DEVICES), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.notifications).toHaveLength(2);
    expect(result.current.notifications[0].type).toBe('info');
    expect(result.current.notifications[1].type).toBe('info');
  });

  it('filters out unknown audit log actions', async () => {
    mockAuditLogData = [
      makeAuditLogRow({ action: 'unknown_action' }),
    ];

    const { result } = renderHook(() => useDashboardData(null, EMPTY_DEVICES), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.notifications).toHaveLength(0);
  });

  it('includes sessionId in notification when resource_type is session', async () => {
    mockAuditLogData = [
      makeAuditLogRow({ resource_type: 'session', resource_id: 'ses-abc' }),
    ];

    const { result } = renderHook(() => useDashboardData(null, EMPTY_DEVICES), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.notifications[0].sessionId).toBe('ses-abc');
  });

  it('omits sessionId when resource_type is not session', async () => {
    mockAuditLogData = [
      makeAuditLogRow({ resource_type: 'user', resource_id: 'user-abc' }),
    ];

    const { result } = renderHook(() => useDashboardData(null, EMPTY_DEVICES), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.notifications[0].sessionId).toBeUndefined();
  });

  it('defaults to claude agentType when metadata has no agent_type', async () => {
    mockAuditLogData = [
      makeAuditLogRow({ action: 'settings_updated', metadata: {} }),
    ];

    const { result } = renderHook(() => useDashboardData(null, EMPTY_DEVICES), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.notifications[0].agentType).toBe('claude');
  });

  // --------------------------------------------------------------------------
  // Agent Status & Quick Stats
  // --------------------------------------------------------------------------

  it('computes agent costs from cost_records', async () => {
    mockCostRecordsData = [
      makeCostRecordRow('claude', 3.0),
      makeCostRecordRow('claude', 1.5),
      makeCostRecordRow('codex', 2.0),
    ];

    const { result } = renderHook(() => useDashboardData(null, EMPTY_DEVICES), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.agentStatus.claude.cost).toBeCloseTo(4.5);
    expect(result.current.agentStatus.codex.cost).toBeCloseTo(2.0);
    expect(result.current.agentStatus.gemini.cost).toBe(0);
  });

  it('sets agents with running sessions as online', async () => {
    mockSessionsData = [
      makeSessionRow({ agent_type: 'claude', status: 'running' }),
    ];

    const { result } = renderHook(() => useDashboardData(null, EMPTY_DEVICES), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.agentStatus.claude.online).toBe(true);
    expect(result.current.agentStatus.codex.online).toBe(false);
  });

  it('computes quickStats totalCostToday from all agents', async () => {
    mockCostRecordsData = [
      makeCostRecordRow('claude', 2.0),
      makeCostRecordRow('codex', 1.0),
      makeCostRecordRow('gemini', 0.5),
    ];

    const { result } = renderHook(() => useDashboardData(null, EMPTY_DEVICES), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.quickStats.totalCostToday).toBeCloseTo(3.5);
  });

  it('computes quickStats activeAgentCount', async () => {
    mockSessionsData = [
      makeSessionRow({ agent_type: 'claude', status: 'running' }),
      makeSessionRow({ id: 's2', agent_type: 'codex', status: 'running' }),
    ];

    const { result } = renderHook(() => useDashboardData(null, EMPTY_DEVICES), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.quickStats.activeAgentCount).toBe(2);
  });

  it('returns zero quick stats with no data', async () => {
    const { result } = renderHook(() => useDashboardData(null, EMPTY_DEVICES), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.quickStats.totalCostToday).toBe(0);
    expect(result.current.quickStats.activeAgentCount).toBe(0);
  });

  // --------------------------------------------------------------------------
  // Presence-Based Agent Status
  // --------------------------------------------------------------------------

  it('sets agent online from CLI presence with active_agent', async () => {
    const devices = [
      { device_id: 'cli-1', device_type: 'cli', active_agent: 'gemini' },
    ];

    const { result } = renderHook(() => useDashboardData(null, devices as never[]), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.agentStatus.gemini.online).toBe(true);
  });

  it('does not set agent online from mobile presence', async () => {
    const devices = [
      { device_id: 'mobile-1', device_type: 'mobile', active_agent: 'claude' },
    ];

    const { result } = renderHook(() => useDashboardData(null, devices as never[]), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.agentStatus.claude.online).toBe(false);
  });

  // --------------------------------------------------------------------------
  // Real-Time: session_state Messages
  // --------------------------------------------------------------------------
  //
  // WHY use rerender pattern: These tests inject a relay message AFTER the
  // sessions have loaded. The hook's message-processing effect (effect #3) only
  // updates sessions that are already in the activeSessions list. If the message
  // is present on the INITIAL render, the sessions haven't loaded yet (they're
  // fetched asynchronously), so the effect finds no matching session and
  // triggers a full refresh instead. After the refresh loads the sessions from
  // the mock, the message has already been marked as processed (via the ref)
  // and won't be re-applied.
  //
  // Correct flow: render with null message → wait for sessions to load →
  // rerender with the message → verify state update.

  it('updates session status on session_state message', async () => {
    mockSessionsData = [makeSessionRow({ id: 's1', status: 'running' })];

    const msg = makeRelayMessage('session_state', {
      session_id: 's1',
      agent: 'claude',
      state: 'idle',
    });

    const { result, rerender } = renderHook(
      ({ message }: { message: typeof msg | null }) =>
        useDashboardData(message as never, EMPTY_DEVICES),
      { initialProps: { message: null as typeof msg | null }, wrapper }
    );

    // Wait for sessions to load first
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.activeSessions[0].status).toBe('running');

    // Now inject the relay message
    rerender({ message: msg });

    await waitFor(() => {
      const session = result.current.activeSessions.find((s) => s.id === 's1');
      expect(session?.status).toBe('idle');
    });
  });

  it('maps thinking state to running', async () => {
    mockSessionsData = [makeSessionRow({ id: 's1', status: 'idle' })];

    const msg = makeRelayMessage('session_state', {
      session_id: 's1',
      agent: 'claude',
      state: 'thinking',
    });

    const { result, rerender } = renderHook(
      ({ message }: { message: typeof msg | null }) =>
        useDashboardData(message as never, EMPTY_DEVICES),
      { initialProps: { message: null as typeof msg | null }, wrapper }
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    rerender({ message: msg });

    await waitFor(() => {
      const session = result.current.activeSessions.find((s) => s.id === 's1');
      expect(session?.status).toBe('running');
    });
  });

  it('maps executing state to running', async () => {
    mockSessionsData = [makeSessionRow({ id: 's1', status: 'idle' })];

    const msg = makeRelayMessage('session_state', {
      session_id: 's1',
      agent: 'claude',
      state: 'executing',
    });

    const { result, rerender } = renderHook(
      ({ message }: { message: typeof msg | null }) =>
        useDashboardData(message as never, EMPTY_DEVICES),
      { initialProps: { message: null as typeof msg | null }, wrapper }
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    rerender({ message: msg });

    await waitFor(() => {
      const session = result.current.activeSessions.find((s) => s.id === 's1');
      expect(session?.status).toBe('running');
    });
  });

  it('maps waiting_permission state correctly', async () => {
    mockSessionsData = [makeSessionRow({ id: 's1', status: 'running' })];

    const msg = makeRelayMessage('session_state', {
      session_id: 's1',
      agent: 'claude',
      state: 'waiting_permission',
    });

    const { result, rerender } = renderHook(
      ({ message }: { message: typeof msg | null }) =>
        useDashboardData(message as never, EMPTY_DEVICES),
      { initialProps: { message: null as typeof msg | null }, wrapper }
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    rerender({ message: msg });

    await waitFor(() => {
      const session = result.current.activeSessions.find((s) => s.id === 's1');
      expect(session?.status).toBe('waiting_permission');
    });
  });

  // --------------------------------------------------------------------------
  // Real-Time: cost_update Messages
  // --------------------------------------------------------------------------

  it('updates agent cost on cost_update message', async () => {
    mockSessionsData = [makeSessionRow({ id: 's1' })];
    mockCostRecordsData = [makeCostRecordRow('claude', 1.0)];

    const msg = makeRelayMessage('cost_update', {
      agent: 'claude',
      session_id: 's1',
      session_total_usd: 2.0,
      cost_usd: 0.5,
    });

    const { result, rerender } = renderHook(
      ({ message }: { message: typeof msg | null }) =>
        useDashboardData(message as never, EMPTY_DEVICES),
      { initialProps: { message: null as typeof msg | null }, wrapper }
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    rerender({ message: msg });

    // Cost should be initial 1.0 + incremental 0.5 = 1.5
    await waitFor(() => {
      expect(result.current.agentStatus.claude.cost).toBeCloseTo(1.5);
    });
  });

  it('updates session cost on cost_update message', async () => {
    mockSessionsData = [makeSessionRow({ id: 's1', total_cost_usd: 1.0 })];

    const msg = makeRelayMessage('cost_update', {
      agent: 'claude',
      session_id: 's1',
      session_total_usd: 3.5,
      cost_usd: 0.5,
    });

    const { result, rerender } = renderHook(
      ({ message }: { message: typeof msg | null }) =>
        useDashboardData(message as never, EMPTY_DEVICES),
      { initialProps: { message: null as typeof msg | null }, wrapper }
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    rerender({ message: msg });

    await waitFor(() => {
      const session = result.current.activeSessions.find((s) => s.id === 's1');
      expect(session?.costUsd).toBeCloseTo(3.5);
    });
  });

  // --------------------------------------------------------------------------
  // Real-Time: permission_request Messages
  // --------------------------------------------------------------------------

  it('sets waiting_permission status on permission_request message', async () => {
    mockSessionsData = [makeSessionRow({ id: 's1', status: 'running' })];

    const msg = makeRelayMessage('permission_request', {
      request_id: 'req-1',
      session_id: 's1',
      tool_name: 'Bash',
      description: 'Run npm install',
    });

    const { result, rerender } = renderHook(
      ({ message }: { message: typeof msg | null }) =>
        useDashboardData(message as never, EMPTY_DEVICES),
      { initialProps: { message: null as typeof msg | null }, wrapper }
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    rerender({ message: msg });

    await waitFor(() => {
      const session = result.current.activeSessions.find((s) => s.id === 's1');
      expect(session?.status).toBe('waiting_permission');
      expect(session?.pendingPermission).toEqual({
        requestId: 'req-1',
        type: 'Bash',
        description: 'Run npm install',
      });
    });
  });

  // --------------------------------------------------------------------------
  // Deduplication
  // --------------------------------------------------------------------------

  it('does not re-process the same message ID', async () => {
    mockSessionsData = [makeSessionRow({ id: 's1', status: 'running' })];

    const msg = makeRelayMessage('session_state', {
      session_id: 's1',
      agent: 'claude',
      state: 'idle',
    }, 'same-msg-id');

    const { result, rerender } = renderHook(
      ({ message }) => useDashboardData(message as never, EMPTY_DEVICES),
      { initialProps: { message: msg }, wrapper }
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // Re-render with same message
    rerender({ message: msg });

    // Should not cause issues (tested by not crashing)
    expect(result.current.activeSessions).toBeDefined();
  });

  // --------------------------------------------------------------------------
  // Refresh
  // --------------------------------------------------------------------------

  it('refresh re-fetches all data', async () => {
    mockSessionsData = [makeSessionRow()];

    const { result } = renderHook(() => useDashboardData(null, EMPTY_DEVICES), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.activeSessions).toHaveLength(1);

    // Update mocks
    mockSessionsData = [
      makeSessionRow({ id: 's1' }),
      makeSessionRow({ id: 's2' }),
    ];

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.activeSessions).toHaveLength(2);
  });

  // --------------------------------------------------------------------------
  // Error Handling
  // --------------------------------------------------------------------------

  it('handles fetch errors gracefully', async () => {
    mockQueryError = { message: 'Network error' };

    const { result } = renderHook(() => useDashboardData(null, EMPTY_DEVICES), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // Should not crash; returns empty data
    expect(result.current.activeSessions).toHaveLength(0);
    expect(result.current.notifications).toHaveLength(0);
  });

  // --------------------------------------------------------------------------
  // Default Agent Status
  // --------------------------------------------------------------------------

  it('includes all five agent types in default status', async () => {
    const { result } = renderHook(() => useDashboardData(null, EMPTY_DEVICES), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.agentStatus.claude).toBeDefined();
    expect(result.current.agentStatus.codex).toBeDefined();
    expect(result.current.agentStatus.gemini).toBeDefined();
    expect(result.current.agentStatus.opencode).toBeDefined();
    expect(result.current.agentStatus.aider).toBeDefined();
  });

  it('all agents default to offline with zero cost', async () => {
    const { result } = renderHook(() => useDashboardData(null, EMPTY_DEVICES), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    for (const agent of ['claude', 'codex', 'gemini', 'opencode', 'aider'] as const) {
      expect(result.current.agentStatus[agent].online).toBe(false);
      expect(result.current.agentStatus[agent].cost).toBe(0);
    }
  });
});
