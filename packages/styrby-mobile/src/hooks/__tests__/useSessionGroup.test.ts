/**
 * Tests for useSessionGroup hook
 *
 * Covers:
 *   - Returns empty state when groupId is null/undefined
 *   - Sets loading=true while fetching, false after resolve
 *   - Sets group + sessions on successful fetch
 *   - Sets error on group fetch failure
 *   - Realtime subscription creates two channels on mount
 *   - Realtime subscription cleans up channels on unmount
 *   - focus() calls the focus API with correct body
 *   - focus() optimistically updates active_agent_session_id
 *   - focus() reverts optimistic update on API failure
 *
 * WHY mock Supabase client (not use a real one):
 *   The hook imports `supabase` from '../lib/supabase' which references
 *   Expo SecureStore and other native modules unavailable in Node.
 *   We mock the entire module and control return values per test.
 *
 * WHY jest.mock() with inline factory (not variable reference):
 *   jest.mock() calls are hoisted to the top of the file by Babel. Any
 *   variable referenced in the factory must be declared before the call —
 *   but since the call is hoisted, that's impossible for normal `const`/`let`
 *   variables. We use `jest.fn()` inside the factory and retrieve the mock
 *   via jest.requireMock() after module load. This is the established pattern
 *   used in useSessions.test.ts and other hooks in this package.
 *
 * @module hooks/__tests__/useSessionGroup
 */

import { renderHook, act, waitFor } from '@testing-library/react-native';
import { useSessionGroup } from '../useSessionGroup';

// ============================================================================
// Supabase mock — must be declared BEFORE any jest.mock() call
// ============================================================================

// WHY '../../lib/supabase': mock paths are resolved relative to the test file,
// not the module under test. This test lives in src/hooks/__tests__/, so going
// up two levels reaches src/lib/supabase.
jest.mock('../../lib/supabase', () => {
  const mockChannel = {
    on: jest.fn().mockReturnThis(),
    subscribe: jest.fn().mockReturnThis(),
    unsubscribe: jest.fn().mockReturnThis(),
  };

  return {
    supabase: {
      from: jest.fn(),
      channel: jest.fn(() => mockChannel),
    },
    __mockChannel: mockChannel,
  };
});

// ============================================================================
// Fixtures
// ============================================================================

const GROUP_ID  = '11111111-1111-1111-1111-111111111111';
const SESSION_A = '22222222-2222-2222-2222-222222222222';
const SESSION_B = '33333333-3333-3333-3333-333333333333';

const MOCK_GROUP = {
  id: GROUP_ID,
  name: 'Refactoring PR #42',
  active_agent_session_id: SESSION_A,
  created_at: '2026-04-22T00:00:00.000Z',
  updated_at: '2026-04-22T00:00:00.000Z',
};

const MOCK_SESSIONS = [
  {
    id: SESSION_A,
    agent_type: 'claude',
    status: 'running' as const,
    project_path: '/my/project',
    total_tokens: 12345,
    cost_usd: 0.025,
    started_at: '2026-04-22T00:00:00.000Z',
    last_activity_at: '2026-04-22T00:05:00.000Z',
  },
  {
    id: SESSION_B,
    agent_type: 'codex',
    status: 'running' as const,
    project_path: '/my/project',
    total_tokens: 8900,
    cost_usd: 0.014,
    started_at: '2026-04-22T00:00:05.000Z',
    last_activity_at: '2026-04-22T00:04:50.000Z',
  },
];

// ============================================================================
// Helpers
// ============================================================================

// Holds queued results returned by the mock Supabase chain
const queryQueue: Array<{ data?: unknown; error?: unknown }> = [];

/**
 * Build a chainable mock that resolves to the next item in queryQueue.
 * Each call to supabase.from() pops one result from the queue.
 */
function buildChain(result: { data?: unknown; error?: unknown }) {
  const chain: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'order', 'limit', 'insert', 'update', 'single']) {
    chain[method] = jest.fn().mockReturnValue(chain);
  }
  chain['single'] = jest.fn().mockResolvedValue(result);
  chain['then'] = (resolve: (v: unknown) => void) => resolve(result);
  return chain;
}

function setupSupabaseMock() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require('../../lib/supabase');
  const mockFrom = mod.supabase.from as jest.Mock;
  mockFrom.mockImplementation(() => {
    const result = queryQueue.shift() ?? { data: null, error: null };
    return buildChain(result);
  });
  return { mockFrom, mockChannel: mod.__mockChannel };
}

// ============================================================================
// fetch mock (for focus() API calls)
// ============================================================================

const mockFetch = jest.fn();
global.fetch = mockFetch;

// ============================================================================
// Tests
// ============================================================================

describe('useSessionGroup', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    queryQueue.length = 0;
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
  });

  // ── Null groupId ──────────────────────────────────────────────────────────

  it('returns empty state when groupId is null', () => {
    const { result } = renderHook(() => useSessionGroup(null));
    expect(result.current.group).toBeNull();
    expect(result.current.sessions).toEqual([]);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('returns empty state when groupId is undefined', () => {
    const { result } = renderHook(() => useSessionGroup(undefined));
    expect(result.current.group).toBeNull();
    expect(result.current.sessions).toEqual([]);
  });

  // ── Successful load ───────────────────────────────────────────────────────

  it('loads group and sessions on mount', async () => {
    setupSupabaseMock();
    queryQueue.push({ data: MOCK_GROUP, error: null });
    queryQueue.push({ data: MOCK_SESSIONS, error: null });

    const { result } = renderHook(() => useSessionGroup(GROUP_ID));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.group?.id).toBe(GROUP_ID);
    expect(result.current.group?.name).toBe('Refactoring PR #42');
    expect(result.current.sessions).toHaveLength(2);
    expect(result.current.error).toBeNull();
  });

  it('sets correct session data on load', async () => {
    setupSupabaseMock();
    queryQueue.push({ data: MOCK_GROUP, error: null });
    queryQueue.push({ data: MOCK_SESSIONS, error: null });

    const { result } = renderHook(() => useSessionGroup(GROUP_ID));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.sessions[0].agent_type).toBe('claude');
    expect(result.current.sessions[1].agent_type).toBe('codex');
  });

  // ── Error states ──────────────────────────────────────────────────────────

  it('sets error when group fetch fails', async () => {
    setupSupabaseMock();
    queryQueue.push({ data: null, error: { message: 'DB error' } });

    const { result } = renderHook(() => useSessionGroup(GROUP_ID));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toContain('Failed to load group');
    expect(result.current.group).toBeNull();
  });

  // ── Realtime subscription ─────────────────────────────────────────────────

  it('creates Realtime channels on mount', async () => {
    const { mockChannel } = setupSupabaseMock();
    queryQueue.push({ data: MOCK_GROUP, error: null });
    queryQueue.push({ data: MOCK_SESSIONS, error: null });

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('../../lib/supabase');
    const channelSpy = mod.supabase.channel as jest.Mock;

    const { unmount } = renderHook(() => useSessionGroup(GROUP_ID));

    await waitFor(() => {
      expect(channelSpy).toHaveBeenCalled();
    });

    // Two channels: group changes + session changes
    expect(channelSpy).toHaveBeenCalledTimes(2);
    expect(channelSpy).toHaveBeenCalledWith(`session-group:${GROUP_ID}`);
    expect(channelSpy).toHaveBeenCalledWith(`session-group-sessions:${GROUP_ID}`);

    // Cleanup on unmount
    unmount();
    expect(mockChannel.unsubscribe).toHaveBeenCalledTimes(2);
  });

  // ── focus() ───────────────────────────────────────────────────────────────

  it('focus() optimistically updates active_agent_session_id', async () => {
    setupSupabaseMock();
    queryQueue.push({ data: MOCK_GROUP, error: null });
    queryQueue.push({ data: MOCK_SESSIONS, error: null });

    const { result } = renderHook(() => useSessionGroup(GROUP_ID));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.group?.active_agent_session_id).toBe(SESSION_A);

    await act(async () => {
      await result.current.focus(SESSION_B);
    });

    // Optimistic update applied
    expect(result.current.group?.active_agent_session_id).toBe(SESSION_B);

    // Correct API call
    expect(mockFetch).toHaveBeenCalledWith(
      `/api/sessions/groups/${GROUP_ID}/focus`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ sessionId: SESSION_B }),
      })
    );
  });

  it('focus() reverts optimistic update when API returns error', async () => {
    setupSupabaseMock();
    queryQueue.push({ data: MOCK_GROUP, error: null });
    queryQueue.push({ data: MOCK_SESSIONS, error: null });

    const { result } = renderHook(() => useSessionGroup(GROUP_ID));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ message: 'Not found' }),
    });

    await act(async () => {
      await result.current.focus(SESSION_B);
    });

    // Should revert to the original value
    expect(result.current.group?.active_agent_session_id).toBe(SESSION_A);
    expect(result.current.error).toBeTruthy();
  });

  it('focus() is a no-op when group is null', async () => {
    const { result } = renderHook(() => useSessionGroup(null));

    await act(async () => {
      await result.current.focus(SESSION_B);
    });

    expect(mockFetch).not.toHaveBeenCalled();
  });
});
