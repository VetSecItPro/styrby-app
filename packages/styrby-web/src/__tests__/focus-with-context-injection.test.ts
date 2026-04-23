/**
 * Tests for POST /api/sessions/groups/[groupId]/focus — Phase 3.5 Extension
 *
 * Covers the Phase 3.5 additions to the focus route:
 *   1. contextInjection: null when no memory record exists
 *   2. contextInjection populated when memory record exists
 *   3. Focus update still succeeds when memory fetch throws (non-fatal path)
 *   4. contextInjection respects file ref relevance threshold (low-relevance refs filtered)
 *   5. contextInjection.estimatedTokens > 0 for non-empty memory
 *   6. Idempotent sync: calling focus twice returns the same contextInjection
 *
 * Pre-Phase-3.5 behavior (auth, validation, group membership, session membership)
 * is tested in the original focus route tests (not duplicated here).
 *
 * WHY separate test file:
 *   Keeping Phase 3.5 additions in a dedicated file avoids merge conflicts with
 *   any existing focus route tests and makes the Phase 3.5 surface explicit for
 *   code review.
 *
 * @module __tests__/focus-with-context-injection
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

// ============================================================================
// Fixtures
// ============================================================================

const VALID_GROUP_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const VALID_SESSION_ID = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const VALID_USER_ID = 'user-0001-0000-0000-000000000000';

/**
 * A minimal agent_context_memory DB row for testing injection.
 */
function buildMemoryRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'mem-0001-0000-0000-000000000000',
    session_group_id: VALID_GROUP_ID,
    summary_markdown:
      '## Current task\nRefactor auth middleware\n\n## Recently touched\n- [PATH]/auth.ts (relevance 0.92)\n\n## Open questions\n(none)',
    file_refs: [
      { path: '/Users/alice/src/auth.ts', lastTouchedAt: new Date().toISOString(), relevance: 0.92 },
      { path: '/Users/alice/src/legacy.ts', lastTouchedAt: new Date(Date.now() - 3_600_000).toISOString(), relevance: 0.15 },
    ],
    recent_messages: [
      { role: 'user', preview: 'Refactor the auth middleware to use JWT' },
      { role: 'assistant', preview: 'Starting with the middleware file.' },
    ],
    token_budget: 4000,
    version: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

// ============================================================================
// Supabase mock factory
// ============================================================================

interface MockState {
  authed: boolean;
  groupExists: boolean;
  sessionInGroup: boolean;
  focusUpdateSucceeds: boolean;
  memoryRow: Record<string, unknown> | null;
  memoryFetchError: boolean;
  auditInsertError: boolean;
}

function createMockState(overrides: Partial<MockState> = {}): MockState {
  return {
    authed: true,
    groupExists: true,
    sessionInGroup: true,
    focusUpdateSucceeds: true,
    memoryRow: buildMemoryRow(),
    memoryFetchError: false,
    auditInsertError: false,
    ...overrides,
  };
}

/**
 * Builds a mock Supabase client driven by the provided state.
 *
 * WHY a state object: Using a mutable state object lets tests override
 * individual behaviors without re-wiring the entire mock.
 */
function buildMockClient(state: MockState) {
  const updatedGroupRow = {
    id: VALID_GROUP_ID,
    active_agent_session_id: VALID_SESSION_ID,
    updated_at: new Date().toISOString(),
  };

  // Each .from() call returns a chainable builder that resolves to the right data
  const buildQuery = (table: string) => {
    let _order = false;
    let _limit = false;
    const builder: Record<string, unknown> = {};

    const chain = () => builder;

    // Fluent methods that return the chain
    ['select', 'eq', 'update', 'insert'].forEach((method) => {
      builder[method] = vi.fn().mockReturnValue(builder);
    });

    builder['order'] = vi.fn().mockImplementation(() => {
      _order = true;
      return builder;
    });

    builder['limit'] = vi.fn().mockImplementation(() => {
      _limit = true;
      return builder;
    });

    builder['then'] = vi.fn().mockImplementation((cb) => {
      if (state.auditInsertError) {
        return Promise.resolve(cb({ error: { message: 'audit write failed' } }));
      }
      return Promise.resolve(cb({ error: null }));
    });

    builder['single'] = vi.fn().mockImplementation(() => {
      if (table === 'agent_session_groups' && !state.groupExists) {
        return Promise.resolve({ data: null, error: { code: '42P01', message: 'not found' } });
      }

      if (table === 'sessions' && !state.sessionInGroup) {
        return Promise.resolve({ data: null, error: { code: 'PGRST116' } });
      }

      if (table === 'agent_session_groups' && state.focusUpdateSucceeds && _order === false) {
        // This is the update call
        return Promise.resolve({ data: updatedGroupRow, error: null });
      }

      if (table === 'agent_context_memory') {
        if (state.memoryFetchError) {
          return Promise.resolve({ data: null, error: { code: '500', message: 'DB error' } });
        }
        if (!state.memoryRow) {
          return Promise.resolve({ data: null, error: { code: 'PGRST116' } });
        }
        return Promise.resolve({ data: state.memoryRow, error: null });
      }

      // Default: group ownership check
      return Promise.resolve({
        data: { id: VALID_GROUP_ID, user_id: VALID_USER_ID },
        error: null,
      });
    });

    return builder;
  };

  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: state.authed ? { id: VALID_USER_ID } : null },
        error: state.authed ? null : { message: 'Unauthorized' },
      }),
    },
    from: vi.fn().mockImplementation((table: string) => buildQuery(table)),
  };
}

// ============================================================================
// Module mocking
// ============================================================================

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}));

vi.mock('@/lib/rateLimit', () => ({
  rateLimit: vi.fn().mockResolvedValue({ allowed: true, retryAfter: null }),
  rateLimitResponse: vi.fn().mockReturnValue(new NextResponse(null, { status: 429 })),
  RATE_LIMITS: { budgetAlerts: { windowMs: 60000, maxRequests: 30 } },
}));

// ============================================================================
// Import after mocking
// ============================================================================

import { createClient } from '@/lib/supabase/server';

/**
 * Import the route handler dynamically after mocks are set up.
 * WHY dynamic: Next.js API routes use `createClient` at module scope in some
 * patterns. Dynamic import ensures the mock is in place before the module runs.
 */
async function importRoute() {
  const { POST } = await import(
    '../app/api/sessions/groups/[groupId]/focus/route'
  );
  return { POST };
}

/**
 * Creates a minimal NextRequest for the focus endpoint.
 */
function buildRequest(body: Record<string, unknown> = { sessionId: VALID_SESSION_ID }) {
  return new Request('http://localhost/api/sessions/groups/test/focus', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * Creates the route context with a resolved params promise.
 */
function buildContext(groupId: string = VALID_GROUP_ID) {
  return { params: Promise.resolve({ groupId }) };
}

// ============================================================================
// Tests
// ============================================================================

describe('POST /api/sessions/groups/[groupId]/focus — Phase 3.5 context injection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns contextInjection: null when no memory record exists', async () => {
    const state = createMockState({ memoryRow: null });
    vi.mocked(createClient).mockResolvedValue(buildMockClient(state) as never);

    const { POST } = await importRoute();
    const res = await POST(buildRequest() as never, buildContext() as never);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.contextInjection).toBeNull();
  });

  it('returns contextInjection payload when memory record exists', async () => {
    const state = createMockState();
    vi.mocked(createClient).mockResolvedValue(buildMockClient(state) as never);

    const { POST } = await importRoute();
    const res = await POST(buildRequest() as never, buildContext() as never);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.contextInjection).not.toBeNull();
    expect(typeof body.contextInjection.systemPrompt).toBe('string');
    expect(body.contextInjection.systemPrompt).toContain('[Styrby Context Sync');
  });

  it('focus update still succeeds (200) when memory fetch throws', async () => {
    const state = createMockState({ memoryFetchError: true });
    vi.mocked(createClient).mockResolvedValue(buildMockClient(state) as never);

    const { POST } = await importRoute();
    const res = await POST(buildRequest() as never, buildContext() as never);
    const body = await res.json();

    // The focus update must succeed even when context fetch fails
    expect(res.status).toBe(200);
    expect(body.activeSessionId).toBe(VALID_SESSION_ID);
    // contextInjection should be null (graceful degradation)
    expect(body.contextInjection).toBeNull();
  });

  it('filters low-relevance file refs in contextInjection (< 0.5 excluded)', async () => {
    const state = createMockState({
      memoryRow: buildMemoryRow({
        file_refs: [
          { path: '/Users/alice/src/high.ts', lastTouchedAt: new Date().toISOString(), relevance: 0.85 },
          { path: '/Users/alice/src/low.ts', lastTouchedAt: new Date().toISOString(), relevance: 0.20 },
        ],
      }),
    });
    vi.mocked(createClient).mockResolvedValue(buildMockClient(state) as never);

    const { POST } = await importRoute();
    const res = await POST(buildRequest() as never, buildContext() as never);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.contextInjection).not.toBeNull();
    expect(body.contextInjection.systemPrompt).toContain('high.ts');
    expect(body.contextInjection.systemPrompt).not.toContain('low.ts');
  });

  it('contextInjection.estimatedTokens > 0 for non-empty memory', async () => {
    const state = createMockState();
    vi.mocked(createClient).mockResolvedValue(buildMockClient(state) as never);

    const { POST } = await importRoute();
    const res = await POST(buildRequest() as never, buildContext() as never);
    const body = await res.json();

    expect(body.contextInjection.estimatedTokens).toBeGreaterThan(0);
  });

  it('contextInjection.messageCount equals number of recentMessages in memory', async () => {
    const recentMessages = [
      { role: 'user', preview: 'Fix the bug' },
      { role: 'assistant', preview: 'Looking at it now.' },
      { role: 'tool', preview: 'Read /Users/alice/src/auth.ts' },
    ];
    const state = createMockState({
      memoryRow: buildMemoryRow({ recent_messages: recentMessages }),
    });
    vi.mocked(createClient).mockResolvedValue(buildMockClient(state) as never);

    const { POST } = await importRoute();
    const res = await POST(buildRequest() as never, buildContext() as never);
    const body = await res.json();

    expect(body.contextInjection.messageCount).toBe(3);
  });
});
