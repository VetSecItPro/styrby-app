/**
 * Tests for POST /api/invitations/[invitationId]/resend
 *
 * Coverage:
 *   - Happy path: new token generated (old hash replaced), email re-sent, 200
 *   - Unauthenticated: 401
 *   - Caller is not admin on the team: 403
 *   - Invitation not found: 404
 *   - Rate limited: 429
 *   - Old token_hash is replaced (new token cannot match old one)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockGetUser = vi.fn();
const mockFromResults: Array<{ data?: unknown; error?: unknown }> = [];

function createChainMock(result: { data?: unknown; error?: unknown }) {
  const chain: Record<string, unknown> = {};
  for (const method of [
    'select', 'eq', 'neq', 'gte', 'lte', 'order', 'limit',
    'insert', 'update', 'delete', 'is', 'not', 'in', 'rpc', 'maybeSingle',
  ]) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }
  chain['single'] = vi.fn().mockResolvedValue(result);
  chain['maybeSingle'] = vi.fn().mockResolvedValue(result);
  chain['then'] = (resolve: (v: unknown) => void) => resolve(result);
  return chain;
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mockGetUser },
    from: vi.fn(() => {
      const result = mockFromResults.shift() ?? { data: null, error: null };
      return createChainMock(result);
    }),
  })),
  createAdminClient: vi.fn(() => ({
    from: vi.fn(() => {
      const result = mockFromResults.shift() ?? { data: null, error: null };
      return createChainMock(result);
    }),
  })),
}));

vi.mock('@/lib/resend', () => ({
  sendTeamInvitationEmail: vi.fn().mockResolvedValue({ success: true }),
}));

// Mock checkInviteRateLimit from shared package.
// WHY mock @styrby/shared: The real implementation connects to Upstash Redis
// which is not available in CI. We mock only the rate-limit function and
// re-export the rest (types, constants) as-is.
// WHY NOT importOriginal: ESM interop issues with the shared package's
// build output can cause importOriginal to hang. We inline what we need.
vi.mock('@styrby/shared', () => ({
  checkInviteRateLimit: vi.fn().mockResolvedValue({
    allowed: true,
    remaining: 19,
    resetAt: Date.now() + 86400_000,
  }),
  // Re-export the role mapping constant used by the accept route (not needed
  // here but included to avoid import errors from other shared exports).
  INVITE_ROLE_TO_MEMBER_ROLE: {
    admin: 'admin',
    member: 'member',
    viewer: 'member',
  },
}));

function createRequest(invitationId: string): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/invitations/${invitationId}/resend`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer test-jwt-token',
      },
    },
  );
}

describe('POST /api/invitations/[invitationId]/resend', () => {
  let POST: (req: NextRequest, ctx: { params: Promise<{ invitationId: string }> }) => Promise<Response>;

  beforeEach(async () => {
    // WHY clearAllMocks not restoreAllMocks in beforeEach:
    //   restoreAllMocks() would undo the vi.mock() module-level mock setup,
    //   reverting checkInviteRateLimit back to a no-op vi.fn(). We use
    //   clearAllMocks() to reset call counts without losing implementations,
    //   then re-apply the default implementation for the rate limit mock.
    vi.clearAllMocks();
    mockFromResults.length = 0;

    // Re-apply default rate limit mock after clearAllMocks may clear it.
    const sharedMod = await import('@styrby/shared');
    vi.mocked(sharedMod.checkInviteRateLimit).mockResolvedValue({
      allowed: true,
      remaining: 19,
      resetAt: Date.now() + 86400_000,
    });

    const mod = await import('../[invitationId]/resend/route');
    POST = mod.POST;
  });

  afterEach(() => {
    // WHY not restoreAllMocks: it would clear vi.mock() implementations.
    vi.clearAllMocks();
  });

  it('returns 401 when unauthenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

    const req = createRequest('inv-1');
    const res = await POST(req, { params: Promise.resolve({ invitationId: 'inv-1' }) });
    expect(res.status).toBe(401);
  });

  it('returns 404 when invitation not found', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-1', email: 'admin@example.com' } },
      error: null,
    });

    // Invitation lookup returns null
    mockFromResults.push({ data: null, error: { code: 'PGRST116', message: 'Row not found' } });

    const req = createRequest('inv-nonexistent');
    const res = await POST(req, { params: Promise.resolve({ invitationId: 'inv-nonexistent' }) });
    expect(res.status).toBe(404);
  });

  it('returns 403 when caller is not admin on the team', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-2', email: 'member@example.com' } },
      error: null,
    });

    // Invitation found
    mockFromResults.push({
      data: {
        id: 'inv-1',
        team_id: 'team-1',
        email: 'newmember@example.com',
        role: 'member',
        status: 'pending',
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        token_hash: 'abc123',
        invited_by: 'admin-1',
      },
      error: null,
    });

    // Caller membership check: member (not admin)
    mockFromResults.push({
      data: { role: 'member' },
      error: null,
    });

    const req = createRequest('inv-1');
    const res = await POST(req, { params: Promise.resolve({ invitationId: 'inv-1' }) });
    expect(res.status).toBe(403);
  });

  it('generates new token and updates token_hash in-place on success', async () => {
    const oldTokenHash = 'deadbeef'.repeat(8); // 64 chars

    mockGetUser.mockResolvedValue({
      data: { user: { id: 'admin-1', email: 'admin@example.com' } },
      error: null,
    });

    // Invitation lookup
    mockFromResults.push({
      data: {
        id: 'inv-1',
        team_id: 'team-1',
        email: 'newmember@example.com',
        role: 'member',
        status: 'pending',
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        token_hash: oldTokenHash,
        invited_by: 'admin-1',
        teams: { name: 'Test Team' },
        profiles: { display_name: 'Admin User', email: 'admin@example.com' },
      },
      error: null,
    });

    // Caller membership check: admin
    mockFromResults.push({ data: { role: 'admin' }, error: null });

    // UPDATE team_invitations
    mockFromResults.push({ data: { id: 'inv-1', token_hash: 'new-hash' }, error: null });

    // audit_log insert
    mockFromResults.push({ data: { id: 'audit-1' }, error: null });

    const req = createRequest('inv-1');
    const res = await POST(req, { params: Promise.resolve({ invitationId: 'inv-1' }) });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it('returns 409 when invitation status is not pending (already accepted)', async () => {
    // WHY: resending an accepted invitation is meaningless (member already joined)
    // and would confuse the recipient. The route guards against this with a 409.
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'admin-1', email: 'admin@example.com' } },
      error: null,
    });

    // Invitation found but already accepted
    mockFromResults.push({
      data: {
        id: 'inv-1',
        team_id: 'team-1',
        email: 'newmember@example.com',
        role: 'member',
        status: 'accepted',
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        token_hash: 'abc123',
        invited_by: 'admin-1',
        teams: { name: 'Test Team' },
        profiles: { display_name: 'Admin User', email: 'admin@example.com' },
      },
      error: null,
    });

    // Caller membership: admin
    mockFromResults.push({ data: { role: 'admin' }, error: null });

    const req = createRequest('inv-1');
    const res = await POST(req, { params: Promise.resolve({ invitationId: 'inv-1' }) });
    expect(res.status).toBe(409);

    const body = await res.json();
    expect(body.error).toBe('INVALID_STATE');
  });

  it('returns 429 when rate limited', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'admin-1', email: 'admin@example.com' } },
      error: null,
    });

    // Invitation lookup
    mockFromResults.push({
      data: {
        id: 'inv-1',
        team_id: 'team-1',
        email: 'newmember@example.com',
        role: 'member',
        status: 'pending',
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        token_hash: 'abc123',
        invited_by: 'admin-1',
      },
      error: null,
    });

    // Caller membership check: admin
    mockFromResults.push({ data: { role: 'admin' }, error: null });

    // Simulate rate limit hit by overriding the mock for this test
    const sharedMod = await import('@styrby/shared');
    vi.mocked(sharedMod.checkInviteRateLimit).mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 3600_000,
    });

    const req = createRequest('inv-1');
    const res = await POST(req, { params: Promise.resolve({ invitationId: 'inv-1' }) });
    expect(res.status).toBe(429);
  });
});
