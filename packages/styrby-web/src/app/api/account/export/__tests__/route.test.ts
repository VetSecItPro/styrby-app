/**
 * Integration tests for POST /api/account/export
 *
 * Tests data export flow including:
 * - Authentication validation
 * - Fetching user's session IDs
 * - Parallel fetching of all 20 user data tables
 * - Audit log creation
 * - Response headers for file download
 * - JSON export data structure
 * - Graceful error handling for individual table failures
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '../route';

/**
 * Mock state for Supabase auth.getUser()
 */
const mockGetUser = vi.fn();

/**
 * Queue of mock responses for Supabase query chain.
 * Each .from() call shifts one entry from this queue.
 */
const fromCallQueue: Array<{ data?: unknown; error?: unknown; count?: number }> = [];

/**
 * Creates a chainable Supabase query mock.
 * The final result is taken from fromCallQueue.
 *
 * @returns Chainable mock with all standard Supabase query methods
 */
function createChainMock() {
  const result = fromCallQueue.shift() ?? { data: null, error: null };
  const chain: Record<string, unknown> = {};

  for (const method of [
    'select', 'eq', 'gte', 'lte', 'lt', 'gt', 'order', 'limit',
    'insert', 'update', 'delete', 'is', 'not', 'in', 'single', 'rpc',
  ]) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }

  chain['single'] = vi.fn().mockResolvedValue(result);
  chain['then'] = (resolve: (v: unknown) => void) => resolve(result);

  return chain;
}

/**
 * Mock Supabase client
 */
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: mockGetUser,
    },
    from: vi.fn(() => createChainMock()),
  })),
}));

/**
 * Mock rate limiter — correct path matching route import
 * WHY: Route imports from '@/lib/rateLimit' (camelCase), not '@/lib/rate-limit'
 */
vi.mock('@/lib/rateLimit', () => ({
  rateLimit: vi.fn(() => ({ allowed: true, remaining: 99 })),
  RATE_LIMITS: {
    export: { windowMs: 3600000, maxRequests: 1 },
  },
  rateLimitResponse: vi.fn((retryAfter: number) =>
    new Response(JSON.stringify({ error: 'RATE_LIMITED' }), {
      status: 429,
      headers: { 'Retry-After': String(retryAfter) },
    })
  ),
  getClientIp: vi.fn(() => '127.0.0.1'),
}));

/**
 * Pushes standard queue entries for a successful export with sessions.
 * Total: 1 (session IDs) + 20 (parallel tables) + 1 (audit log) = 22 entries.
 *
 * WHY: When sessions exist, the messages query uses .from() so all 20
 * Promise.all entries consume from the queue.
 */
function pushStandardQueue() {
  // 1. Session IDs fetch
  fromCallQueue.push({ data: [{ id: 'session-1' }], error: null });

  // 2. 20 parallel table fetches (order matches Promise.all in route)
  for (let i = 0; i < 20; i++) {
    fromCallQueue.push({ data: [], error: null });
  }

  // 3. Audit log insert
  fromCallQueue.push({ data: null, error: null });
}

/**
 * Helper to create a NextRequest
 *
 * @returns NextRequest configured for POST method
 */
function createRequest(): NextRequest {
  return new NextRequest('http://localhost:3000/api/account/export', {
    method: 'POST',
  });
}

describe('POST /api/account/export', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fromCallQueue.length = 0;

    // Default: authenticated user
    mockGetUser.mockResolvedValue({
      data: {
        user: {
          id: 'user-123',
          email: 'test@example.com',
        },
      },
      error: null,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Test 1: Returns 401 when user is not authenticated
   */
  it('returns 401 when user is not authenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

    const request = createRequest();
    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data).toEqual({ error: 'Unauthorized' });
  });

  /**
   * Test 2: Returns 200 with JSON download response
   */
  it('returns 200 with JSON download response', async () => {
    pushStandardQueue();

    const request = createRequest();
    const response = await POST(request);

    expect(response.status).toBe(200);

    // Should be a valid JSON response
    const data = await response.json();
    expect(data).toHaveProperty('userId');
    expect(data).toHaveProperty('exportedAt');
  });

  /**
   * Test 3: Response has Content-Disposition header with filename
   */
  it('has Content-Disposition header with timestamped filename', async () => {
    pushStandardQueue();

    const request = createRequest();
    const response = await POST(request);

    const contentDisposition = response.headers.get('Content-Disposition');
    expect(contentDisposition).toBeTruthy();
    expect(contentDisposition).toMatch(/attachment; filename="styrby-data-export-\d{4}-\d{2}-\d{2}\.json"/);
  });

  /**
   * Test 4: Response has Cache-Control: no-store header
   */
  it('has Cache-Control: no-store header', async () => {
    pushStandardQueue();

    const request = createRequest();
    const response = await POST(request);

    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  /**
   * Test 5: Export data includes userId and email
   */
  it('includes userId and email in export data', async () => {
    pushStandardQueue();

    const request = createRequest();
    const response = await POST(request);
    const data = await response.json();

    expect(data.userId).toBe('user-123');
    expect(data.email).toBe('test@example.com');
  });

  /**
   * Test 6: Export data includes all expected table keys
   * WHY: GDPR Art. 20 requires exporting ALL user data from all 20 tables.
   * Keys must match exact property names in the route's exportData object.
   */
  it('includes all expected table keys in export data', async () => {
    pushStandardQueue();

    const request = createRequest();
    const response = await POST(request);
    const data = await response.json();

    // Core metadata
    expect(data).toHaveProperty('userId');
    expect(data).toHaveProperty('email');
    expect(data).toHaveProperty('exportedAt');

    // All 20 table exports should be present (matching exact route keys)
    const expectedTables = [
      'profile',
      'sessions',
      'messages',
      'costRecords',
      'budgetAlerts',
      'agentConfigs',
      'deviceTokens',
      'feedback',
      'machines',
      'subscriptions',
      'notificationPreferences',
      'bookmarks',
      'teams',
      'teamMemberships',
      'teamInvitations',
      'webhooks',
      'apiKeys',
      'auditLog',
      'promptTemplates',
      'offlineCommandQueue',
    ];

    for (const table of expectedTables) {
      expect(data).toHaveProperty(table);
    }
  });

  /**
   * Test 7: Handles session fetch error gracefully
   * WHY: Route destructures only { data: userSessions }, ignoring errors.
   * Failed session fetch means sessionIds = [], resulting in empty data.
   * Partial export is better than no export — route returns 200.
   */
  it('handles session fetch error gracefully with empty data', async () => {
    // Session IDs query returns error — route ignores error, uses empty array
    fromCallQueue.push({
      data: null,
      error: { message: 'Database error', code: 'DB_ERROR' },
    });

    // Remaining queue entries default to { data: null, error: null }
    // Route uses || [] fallbacks for null data

    const request = createRequest();
    const response = await POST(request);
    const data = await response.json();

    // Route returns 200 — errors are handled gracefully
    expect(response.status).toBe(200);
    expect(data).toHaveProperty('userId');
    expect(data.sessions).toEqual([]);
    expect(data.messages).toEqual([]);
  });

  /**
   * Test 8: Handles individual table fetch errors gracefully
   * WHY: Promise.all resolves all entries (errors don't reject), and the
   * route uses `|| []` fallbacks for null data from failed queries.
   */
  it('handles table fetch errors gracefully with partial data', async () => {
    // Session IDs succeed
    fromCallQueue.push({ data: [{ id: 'session-1' }], error: null });

    // First table (profiles) succeeds
    fromCallQueue.push({ data: { id: 'user-123' }, error: null });

    // Second table (sessions) has error
    fromCallQueue.push({
      data: null,
      error: { message: 'Database error', code: 'DB_ERROR' },
    });

    // Remaining table fetches and audit default to { data: null, error: null }

    const request = createRequest();
    const response = await POST(request);
    const data = await response.json();

    // Route returns 200 with partial data — failed tables get empty arrays
    expect(response.status).toBe(200);
    expect(data).toHaveProperty('userId');
    expect(data.sessions).toEqual([]);
  });

  /**
   * Test 9: Exports session messages for user's sessions only
   * WHY: session_messages has no user_id column — messages are fetched via
   * session IDs using .in('session_id', sessionIds). Messages is the 3rd
   * entry in Promise.all (index 2).
   */
  it('exports session messages filtered by user session IDs', async () => {
    const sessionIds = ['session-1', 'session-2', 'session-3'];

    // Queue session IDs fetch
    fromCallQueue.push({
      data: sessionIds.map((id) => ({ id })),
      error: null,
    });

    // Queue 20 table fetches - messages will have data at index 2
    for (let i = 0; i < 20; i++) {
      if (i === 2) {
        // Messages is the 3rd entry in Promise.all (index 2)
        fromCallQueue.push({
          data: [
            { id: 'msg-1', session_id: 'session-1', content: 'test' },
            { id: 'msg-2', session_id: 'session-2', content: 'test2' },
          ],
          error: null,
        });
      } else {
        fromCallQueue.push({ data: [], error: null });
      }
    }

    // Queue audit log insert
    fromCallQueue.push({ data: null, error: null });

    const request = createRequest();
    const response = await POST(request);
    const data = await response.json();

    // Route exports as 'messages' key (not 'sessionMessages')
    expect(Array.isArray(data.messages)).toBe(true);
    expect(data.messages).toHaveLength(2);
  });

  /**
   * Test 10: Creates audit log entry for export action
   */
  it('creates audit log entry for export action', async () => {
    pushStandardQueue();

    const request = createRequest();
    await POST(request);

    // Verify all queue entries were consumed (including audit log insert)
    expect(fromCallQueue.length).toBe(0);
  });
});
