/**
 * Tests for GET + POST /api/approval/[id]
 *
 * Covers:
 *   - GET: 404 on missing row, 200 on valid row, 401 on unauthenticated call
 *   - POST: validation errors, self-approval guard (forwarded from edge fn),
 *           approved and denied flows, 409 on already-resolved row
 *
 * All Supabase and fetch calls are stubbed — no network traffic.
 *
 * @module api/approval/__tests__/route
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Module mocks ─────────────────────────────────────────────────────────────

const mockGetUser = vi.fn();
const mockGetSession = vi.fn();
const mockSupabaseFrom = vi.fn();

/**
 * WHY the factory rebuilds the client object on each call:
 * `vi.resetAllMocks()` clears mock implementations, so if createClient's
 * mockResolvedValue is set once, it is cleared by reset. By using a factory
 * function that returns a fresh object each time, we ensure the client is
 * always valid — mockGetUser/mockGetSession are re-set in beforeEach.
 */
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(() =>
    Promise.resolve({
      auth: {
        getUser: mockGetUser,
        getSession: mockGetSession,
      },
      from: mockSupabaseFrom,
    }),
  ),
}));

const mockRateLimit = vi.fn();
const mockRateLimitResponse = vi.fn();

vi.mock('@/lib/rateLimit', () => ({
  get rateLimit() { return mockRateLimit; },
  get rateLimitResponse() { return mockRateLimitResponse; },
  RATE_LIMITS: { standard: { windowMs: 60000, maxRequests: 100 } },
}));

// Mock process.env before importing the route module
vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://test.supabase.co');

// ─── Test helpers ─────────────────────────────────────────────────────────────

const UUID = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const APPROVAL_ID = UUID(1);
const USER_ID = UUID(2);
const TEAM_ID = UUID(3);

/** Mocked approval row shape returned by Supabase. */
const mockApprovalRow = {
  id: APPROVAL_ID,
  team_id: TEAM_ID,
  session_id: UUID(4),
  policy_id: null,
  requester_user_id: UUID(5),
  tool_name: 'Bash',
  estimated_cost_usd: 0.05,
  request_payload: { command: 'rm -rf /tmp/test' },
  status: 'pending',
  resolver_user_id: null,
  resolution_note: null,
  expires_at: new Date(Date.now() + 900_000).toISOString(),
  created_at: new Date().toISOString(),
  resolved_at: null,
};

/** Helper to build a NextRequest-like object. */
function makeRequest(
  method: 'GET' | 'POST',
  body?: Record<string, unknown>,
): Request {
  return new Request(`https://example.com/api/approval/${APPROVAL_ID}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

// ─── Import the route handlers after mocks are in place ───────────────────────

// Dynamic import ensures mocks are applied first
let GET: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
let POST: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

beforeEach(async () => {
  vi.resetAllMocks();

  // Default: authenticated user
  mockGetUser.mockResolvedValue({ data: { user: { id: USER_ID } }, error: null });
  mockGetSession.mockResolvedValue({
    data: { session: { access_token: 'test-jwt-token' } },
  });

  // Default: rate limit allows request
  mockRateLimit.mockResolvedValue({ allowed: true, remaining: 99, resetAt: 0 });

  const route = await import('../route.js');
  // WHY double cast: The route handlers use NextRequest/NextResponse types
  // which have extra properties vs the base Request/Response. In tests we pass
  // plain Request objects via the test helper; the double cast suppresses the
  // TypeScript overlap error without affecting runtime behaviour.
  GET = route.GET as unknown as typeof GET;
  POST = route.POST as unknown as typeof POST;
});

const routeCtx = { params: Promise.resolve({ id: APPROVAL_ID }) };
const invalidCtx = { params: Promise.resolve({ id: 'not-a-uuid' }) };

// ============================================================================
// GET tests
// ============================================================================

describe('GET /api/approval/[id]', () => {
  it('returns 400 for invalid UUID format', async () => {
    const req = makeRequest('GET');
    const res = await GET(req as unknown as Request & { nextUrl: URL }, invalidCtx);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Invalid approval ID format');
  });

  it('returns 401 when user is not authenticated', async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: null }, error: new Error('No session') });
    const req = makeRequest('GET');
    const res = await GET(req as unknown as Request & { nextUrl: URL }, routeCtx);
    expect(res.status).toBe(401);
  });

  it('returns 404 when the approval row is not found (RLS or missing)', async () => {
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: null, error: { message: 'not found' } }),
    };
    mockSupabaseFrom.mockReturnValue(chain);

    const req = makeRequest('GET');
    const res = await GET(req as unknown as Request & { nextUrl: URL }, routeCtx);
    expect(res.status).toBe(404);
  });

  it('returns 200 with camelCase approval data on success', async () => {
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: mockApprovalRow, error: null }),
    };
    mockSupabaseFrom.mockReturnValue(chain);

    const req = makeRequest('GET');
    const res = await GET(req as unknown as Request & { nextUrl: URL }, routeCtx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.approval.id).toBe(APPROVAL_ID);
    expect(body.approval.teamId).toBe(TEAM_ID);
    expect(body.approval.toolName).toBe('Bash');
    expect(body.approval.status).toBe('pending');
    // Verify snake_case keys are NOT present
    expect(body.approval.team_id).toBeUndefined();
    expect(body.approval.tool_name).toBeUndefined();
  });
});

// ============================================================================
// POST tests
// ============================================================================

/** Builds a stub for the global fetch that simulates the edge function. */
function stubEdgeFetch(status: number, responseBody: Record<string, unknown>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      status,
      json: vi.fn().mockResolvedValue(responseBody),
    }),
  );
}

describe('POST /api/approval/[id] — validation', () => {
  it('returns 400 for invalid UUID format', async () => {
    const req = makeRequest('POST', { vote: 'approved' });
    const res = await POST(req as unknown as Request & { nextUrl: URL }, invalidCtx);
    expect(res.status).toBe(400);
  });

  it('returns 401 when unauthenticated', async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: null }, error: null });
    const req = makeRequest('POST', { vote: 'approved' });
    const res = await POST(req as unknown as Request & { nextUrl: URL }, routeCtx);
    expect(res.status).toBe(401);
  });

  it('returns 400 when vote is missing', async () => {
    const req = makeRequest('POST', { resolutionNote: 'looks good' });
    const res = await POST(req as unknown as Request & { nextUrl: URL }, routeCtx);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('vote');
  });

  it('returns 400 when vote is an invalid value', async () => {
    const req = makeRequest('POST', { vote: 'maybe' });
    const res = await POST(req as unknown as Request & { nextUrl: URL }, routeCtx);
    expect(res.status).toBe(400);
  });

  it('returns 400 when resolutionNote exceeds 1000 characters', async () => {
    const req = makeRequest('POST', { vote: 'denied', resolutionNote: 'x'.repeat(1001) });
    const res = await POST(req as unknown as Request & { nextUrl: URL }, routeCtx);
    expect(res.status).toBe(400);
  });
});

describe('POST /api/approval/[id] — resolution flows', () => {
  it('proxies approved vote to edge function and returns 200', async () => {
    stubEdgeFetch(200, { approvalId: APPROVAL_ID, status: 'approved', reason: 'Approved by approver' });
    const req = makeRequest('POST', { vote: 'approved', resolutionNote: 'LGTM' });
    const res = await POST(req as unknown as Request & { nextUrl: URL }, routeCtx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('approved');
    expect(body.approvalId).toBe(APPROVAL_ID);
  });

  it('proxies denied vote to edge function and returns 200', async () => {
    stubEdgeFetch(200, {
      approvalId: APPROVAL_ID,
      status: 'denied',
      reason: 'Too risky without review',
    });
    const req = makeRequest('POST', { vote: 'denied', resolutionNote: 'Too risky without review' });
    const res = await POST(req as unknown as Request & { nextUrl: URL }, routeCtx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('denied');
  });

  it('forwards self-approval rejection from edge function (403)', async () => {
    stubEdgeFetch(403, { error: 'Self-approval is not permitted (SOC2 CC6.3)' });
    const req = makeRequest('POST', { vote: 'approved' });
    const res = await POST(req as unknown as Request & { nextUrl: URL }, routeCtx);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain('Self-approval');
  });

  it('forwards already-resolved conflict from edge function (409)', async () => {
    stubEdgeFetch(409, {
      error: 'Approval is already approved. Resolution is a no-op.',
      approvalId: APPROVAL_ID,
      status: 'approved',
    });
    const req = makeRequest('POST', { vote: 'approved' });
    const res = await POST(req as unknown as Request & { nextUrl: URL }, routeCtx);
    expect(res.status).toBe(409);
  });

  it('forwards forbidden from edge function when caller is not an admin (403)', async () => {
    stubEdgeFetch(403, { error: 'Forbidden: only team admins or owners may resolve approvals' });
    const req = makeRequest('POST', { vote: 'approved' });
    const res = await POST(req as unknown as Request & { nextUrl: URL }, routeCtx);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain('admins or owners');
  });
});
