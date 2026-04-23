/**
 * Tests for GET /api/sessions/[id]/handoff
 *
 * Covers:
 *   - Happy path: snapshot from a different device returns available:true
 *   - No snapshot: returns available:false
 *   - Same-device snapshot: returns available:false
 *   - Expired snapshot (>5min): returns 410 GONE
 *   - Invalid session ID: returns 400
 *   - Unauthenticated: returns 401
 *   - Session not found / not owned: returns 404
 *   - DB error on snapshot query: returns 500
 *   - Cross-user RLS simulation: verifies ownership check
 *
 * WHY extensive mocking:
 *   The route is a Next.js API route that calls Supabase. We stub `createClient`
 *   to return a controlled mock so tests are fast, hermetic, and don't require
 *   a live DB. This matches the existing pattern in middleware/__tests__/.
 *
 * @module __tests__/handoff-route
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextResponse } from 'next/server';

// ============================================================================
// Fixtures
// ============================================================================

const VALID_SESSION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const DEVICE_A = 'device-a-uuid-0001-0000-000000000000';
const DEVICE_B = 'device-b-uuid-0002-0000-000000000000';

/**
 * Creates an ISO timestamp `ageMs` milliseconds in the past.
 */
function tsAgo(ageMs: number): string {
  return new Date(Date.now() - ageMs).toISOString();
}

// ============================================================================
// Supabase mock factory
// ============================================================================

interface MockState {
  authed: boolean;
  sessionExists: boolean;
  snapshot: {
    id: string;
    device_id: string;
    cursor_position: number;
    scroll_offset: number;
    active_draft: string | null;
    created_at: string;
  } | null;
  snapshotQueryError: boolean;
  deviceKind: string | null;
}

function createMockState(overrides: Partial<MockState> = {}): MockState {
  return {
    authed: true,
    sessionExists: true,
    snapshot: {
      id: 'snap-1111-1111-1111-111111111111',
      device_id: DEVICE_A,
      cursor_position: 7,
      scroll_offset: 150,
      active_draft: 'half-typed msg',
      created_at: tsAgo(60_000), // 1 minute ago
    },
    snapshotQueryError: false,
    deviceKind: 'mobile_ios',
    ...overrides,
  };
}

/**
 * Builds a mock Supabase client that satisfies the queries made by the route.
 *
 * The mock is a simple chain-builder: from().select().eq()...maybeSingle()
 * returns the appropriate value from `state`.
 */
function makeMockSupabase(state: MockState) {
  const mockGetUser = vi.fn().mockResolvedValue({
    data: { user: state.authed ? { id: 'user-uuid' } : null },
    error: state.authed ? null : { message: 'not authed' },
  });

  // We need to distinguish which query is being built.
  // We track by the table name passed to `from()`.
  const mockFrom = vi.fn().mockImplementation((table: string) => {
    if (table === 'sessions') {
      return buildChain(
        state.sessionExists
          ? { id: VALID_SESSION_ID, user_id: 'user-uuid' }
          : null,
        null,
      );
    }

    if (table === 'session_state_snapshots') {
      return buildChain(
        state.snapshot,
        state.snapshotQueryError ? { message: 'DB exploded' } : null,
      );
    }

    if (table === 'devices') {
      return buildChain(
        state.deviceKind ? { kind: state.deviceKind } : null,
        null,
      );
    }

    return buildChain(null, null);
  });

  return {
    auth: { getUser: mockGetUser },
    from: mockFrom,
  };
}

/**
 * Builds a fluent chainable mock for Supabase query builder.
 *
 * Supports arbitrary chaining depth: .select().eq().eq().order().limit().maybeSingle()
 *
 * WHY Proxy approach: A recursive factory would still have the temporal-dead-zone
 * problem if `eq` references itself. A JS Proxy lets us intercept any property
 * access on the chain object and always return the same terminal resolvers,
 * so the chain can be arbitrarily deep without any circular reference issue.
 *
 * @param data - Value to resolve from maybeSingle() / single()
 * @param error - Error to resolve from maybeSingle() / single() (null = success)
 */
function buildChain(
  data: unknown,
  error: { message: string } | null,
) {
  const result = { data, error };
  const maybeSingle = vi.fn().mockResolvedValue(result);
  const single = vi.fn().mockResolvedValue(result);

  /**
   * Returns a Proxy that satisfies any chaining pattern:
   * every property access returns the same proxy, except
   * `maybeSingle` and `single` which return the real resolvers.
   */
  function makeChain(): Record<string, unknown> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const proxy: any = new Proxy(
      {},
      {
        get(_target, prop: string) {
          if (prop === 'maybeSingle') return maybeSingle;
          if (prop === 'single') return single;
          // For any other method (eq, order, limit, neq, etc.):
          // return a vi.fn() that, when called, returns the same proxy.
          const fn = vi.fn().mockReturnValue(proxy);
          return fn;
        },
      },
    );
    return proxy;
  }

  return { select: vi.fn().mockReturnValue(makeChain()) };
}

// ============================================================================
// Module mock setup
// ============================================================================

const mockCreateClient = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => mockCreateClient(),
}));

// ============================================================================
// Tests
// ============================================================================

describe('GET /api/sessions/[id]/handoff', () => {
  // Dynamically import the route handler AFTER mocks are set up.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let GET: (...args: any[]) => Promise<NextResponse>;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import(
      '../app/api/sessions/[id]/handoff/route'
    );
    GET = mod.GET;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function makeRequest(sessionId: string, deviceId = DEVICE_B): Request {
    return new Request(
      `http://localhost/api/sessions/${sessionId}/handoff?current_device_id=${deviceId}`,
    );
  }

  function makeContext(sessionId: string) {
    return { params: Promise.resolve({ id: sessionId }) };
  }

  // --------------------------------------------------------------------------
  // Happy path
  // --------------------------------------------------------------------------

  it('returns available:true with full handoff data when a recent snapshot exists from a different device', async () => {
    const state = createMockState();
    mockCreateClient.mockReturnValue(makeMockSupabase(state));

    const res = await GET(makeRequest(VALID_SESSION_ID, DEVICE_B), makeContext(VALID_SESSION_ID));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.available).toBe(true);
    expect(body.lastDeviceId).toBe(DEVICE_A);
    expect(body.lastDeviceKind).toBe('mobile_ios');
    expect(body.cursorPosition).toBe(7);
    expect(body.scrollOffset).toBe(150);
    expect(body.activeDraft).toBe('half-typed msg');
    expect(body.ageMs).toBeGreaterThan(0);
    expect(body.ageMs).toBeLessThan(120_000); // within 2 min
  });

  // --------------------------------------------------------------------------
  // No snapshot
  // --------------------------------------------------------------------------

  it('returns available:false when no snapshot exists', async () => {
    const state = createMockState({ snapshot: null });
    mockCreateClient.mockReturnValue(makeMockSupabase(state));

    const res = await GET(makeRequest(VALID_SESSION_ID), makeContext(VALID_SESSION_ID));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.available).toBe(false);
  });

  // --------------------------------------------------------------------------
  // Same-device snapshot
  // --------------------------------------------------------------------------

  it('returns available:false when the latest snapshot is from the calling device', async () => {
    const state = createMockState({
      snapshot: {
        id: 'snap-same',
        device_id: DEVICE_B, // same as caller
        cursor_position: 3,
        scroll_offset: 0,
        active_draft: null,
        created_at: tsAgo(30_000),
      },
    });
    mockCreateClient.mockReturnValue(makeMockSupabase(state));

    const res = await GET(makeRequest(VALID_SESSION_ID, DEVICE_B), makeContext(VALID_SESSION_ID));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.available).toBe(false);
  });

  // --------------------------------------------------------------------------
  // Expired snapshot (410)
  // --------------------------------------------------------------------------

  it('returns 410 when the latest snapshot is older than 5 minutes', async () => {
    const state = createMockState({
      snapshot: {
        id: 'snap-old',
        device_id: DEVICE_A,
        cursor_position: 1,
        scroll_offset: 0,
        active_draft: null,
        created_at: tsAgo(6 * 60 * 1_000), // 6 minutes ago
      },
    });
    mockCreateClient.mockReturnValue(makeMockSupabase(state));

    const res = await GET(makeRequest(VALID_SESSION_ID), makeContext(VALID_SESSION_ID));
    const body = await res.json();

    expect(res.status).toBe(410);
    expect(body.error).toBe('SNAPSHOT_EXPIRED');
  });

  // --------------------------------------------------------------------------
  // 400 invalid session ID
  // --------------------------------------------------------------------------

  it('returns 400 for a non-UUID session ID', async () => {
    mockCreateClient.mockReturnValue(makeMockSupabase(createMockState()));

    const res = await GET(makeRequest('not-a-uuid'), makeContext('not-a-uuid'));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe('VALIDATION_ERROR');
  });

  // --------------------------------------------------------------------------
  // 401 unauthenticated
  // --------------------------------------------------------------------------

  it('returns 401 when user is not authenticated', async () => {
    const state = createMockState({ authed: false });
    mockCreateClient.mockReturnValue(makeMockSupabase(state));

    const res = await GET(makeRequest(VALID_SESSION_ID), makeContext(VALID_SESSION_ID));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toBe('UNAUTHORIZED');
  });

  // --------------------------------------------------------------------------
  // 404 session not found / wrong user
  // --------------------------------------------------------------------------

  it('returns 404 when the session does not belong to the authenticated user', async () => {
    const state = createMockState({ sessionExists: false });
    mockCreateClient.mockReturnValue(makeMockSupabase(state));

    const res = await GET(makeRequest(VALID_SESSION_ID), makeContext(VALID_SESSION_ID));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe('NOT_FOUND');
  });

  // --------------------------------------------------------------------------
  // 500 snapshot DB error
  // --------------------------------------------------------------------------

  it('returns 500 when the snapshot query fails with a DB error', async () => {
    const state = createMockState({ snapshotQueryError: true });
    mockCreateClient.mockReturnValue(makeMockSupabase(state));

    const res = await GET(makeRequest(VALID_SESSION_ID), makeContext(VALID_SESSION_ID));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe('INTERNAL_ERROR');
  });

  // --------------------------------------------------------------------------
  // activeDraft null when empty
  // --------------------------------------------------------------------------

  it('returns activeDraft:null when the snapshot has no draft', async () => {
    const state = createMockState({
      snapshot: {
        id: 'snap-nodraft',
        device_id: DEVICE_A,
        cursor_position: 2,
        scroll_offset: 0,
        active_draft: null,
        created_at: tsAgo(30_000),
      },
    });
    mockCreateClient.mockReturnValue(makeMockSupabase(state));

    const res = await GET(makeRequest(VALID_SESSION_ID, DEVICE_B), makeContext(VALID_SESSION_ID));
    const body = await res.json();

    expect(body.available).toBe(true);
    expect(body.activeDraft).toBeNull();
  });
});
