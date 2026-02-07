/**
 * User Webhooks API Route Integration Tests
 *
 * Tests GET, POST, PATCH, DELETE /api/webhooks/user
 *
 * WHY: Webhooks are tier-gated (Free: 0, Pro: 3, Power: 10) and handle
 * user-facing configuration that triggers outbound HTTP calls. Bugs here
 * could allow free users to create webhooks (bypassing billing), expose
 * signing secrets, or enable SSRF attacks against internal infrastructure
 * via malicious webhook URLs (FIX-027 / FIX-042).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ============================================================================
// Mocks
// ============================================================================

const mockGetUser = vi.fn();

/**
 * Tracks sequential .from() call results.
 * Each call to supabase.from() creates a new chain mock that will resolve
 * to the next result in this queue when a terminal method is called.
 *
 * WHY: The webhooks route calls supabase.from() multiple times (webhooks
 * table, subscriptions table). Each call needs different mock data.
 * This queue approach handles the sequencing automatically.
 */
const fromCallQueue: Array<{ data?: unknown; error?: unknown; count?: number }> = [];

/**
 * Creates a chainable Supabase query builder mock.
 * Every chainable method (select, eq, is, etc.) returns `this`.
 * Terminal methods (single, then) resolve with the next result from the queue.
 */
function createChainMock() {
  const result = fromCallQueue.shift() ?? { data: null, error: null };
  const chain: Record<string, unknown> = {};

  // Chainable methods return the chain itself
  for (const method of ['select', 'eq', 'gte', 'lte', 'order', 'limit', 'insert', 'update', 'delete', 'is', 'not', 'in', 'range']) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }

  // Terminal methods resolve with the queued result
  chain['single'] = vi.fn().mockResolvedValue(result);
  // Make the chain thenable for await without .single()
  chain['then'] = (resolve: (v: unknown) => void) => resolve(result);

  return chain;
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mockGetUser },
    from: vi.fn(() => createChainMock()),
  })),
}));

/** Mock rate limiting to always allow requests */
vi.mock('@/lib/rateLimit', () => ({
  rateLimit: vi.fn(() => ({ allowed: true, remaining: 29 })),
  RATE_LIMITS: {
    budgetAlerts: { windowMs: 60000, maxRequests: 30 },
    standard: { windowMs: 60000, maxRequests: 100 },
    sensitive: { windowMs: 60000, maxRequests: 10 },
  },
  rateLimitResponse: vi.fn((retryAfter: number) =>
    new Response(JSON.stringify({ error: 'RATE_LIMITED' }), {
      status: 429,
      headers: { 'Retry-After': String(retryAfter) },
    })
  ),
}));

import { GET, POST, PATCH, DELETE } from '../route';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Creates a NextRequest suitable for testing POST/PATCH/DELETE handlers.
 *
 * @param method - HTTP method
 * @param body - Request body to serialize as JSON
 * @returns NextRequest instance
 */
function createNextRequest(method: string, body?: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost:3000/api/webhooks/user', {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-forwarded-for': '203.0.113.1',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

const AUTH_USER = { id: 'user-uuid-123', email: 'test@example.com' };

function mockAuthenticated() {
  mockGetUser.mockResolvedValue({
    data: { user: AUTH_USER },
    error: null,
  });
}

function mockUnauthenticated() {
  mockGetUser.mockResolvedValue({
    data: { user: null },
    error: { message: 'Not authenticated' },
  });
}

/** Valid webhook creation payload that passes all Zod validation */
const VALID_WEBHOOK = {
  name: 'My CI Webhook',
  url: 'https://example.com/webhook',
  events: ['session.completed'],
};

// ============================================================================
// Tests
// ============================================================================

describe('User Webhooks API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fromCallQueue.length = 0;
  });

  // --------------------------------------------------------------------------
  // GET /api/webhooks/user
  // --------------------------------------------------------------------------

  describe('GET /api/webhooks/user', () => {
    it('returns 401 when unauthenticated', async () => {
      mockUnauthenticated();

      const response = await GET();
      expect(response.status).toBe(401);

      const body = await response.json();
      expect(body.error).toBe('Unauthorized');
    });

    it('returns webhooks with tier info for authenticated user', async () => {
      mockAuthenticated();

      // 1. webhooks.select().eq().is().order() — webhook list
      fromCallQueue.push({
        data: [
          { id: 'wh-1', name: 'Prod', url: 'https://prod.example.com/wh', events: ['session.completed'], is_active: true },
          { id: 'wh-2', name: 'Staging', url: 'https://staging.example.com/wh', events: ['budget.exceeded'], is_active: false },
        ],
        error: null,
      });
      // 2. subscriptions.select().eq().eq().single() — getUserTier → pro
      fromCallQueue.push({ data: { tier: 'pro' }, error: null });

      const response = await GET();
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.webhooks).toHaveLength(2);
      expect(body.tier).toBe('pro');
      expect(body.webhookLimit).toBe(3);
      expect(body.webhookCount).toBe(2);
    });

    it('returns empty webhooks array when user has none', async () => {
      mockAuthenticated();

      // 1. Empty webhooks
      fromCallQueue.push({ data: [], error: null });
      // 2. Free tier
      fromCallQueue.push({ data: null, error: null });

      const response = await GET();
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.webhooks).toHaveLength(0);
      expect(body.webhookCount).toBe(0);
    });

    it('returns webhookLimit=0 for free tier', async () => {
      mockAuthenticated();

      fromCallQueue.push({ data: [], error: null });
      // Free tier — no subscription row
      fromCallQueue.push({ data: null, error: null });

      const response = await GET();
      const body = await response.json();
      expect(body.webhookLimit).toBe(0);
      expect(body.tier).toBe('free');
    });

    it('returns webhookLimit=10 for power tier', async () => {
      mockAuthenticated();

      fromCallQueue.push({ data: [], error: null });
      fromCallQueue.push({ data: { tier: 'power' }, error: null });

      const response = await GET();
      const body = await response.json();
      expect(body.webhookLimit).toBe(10);
      expect(body.tier).toBe('power');
    });
  });

  // --------------------------------------------------------------------------
  // POST /api/webhooks/user
  // --------------------------------------------------------------------------

  describe('POST /api/webhooks/user', () => {
    it('returns 401 when unauthenticated', async () => {
      mockUnauthenticated();

      const req = createNextRequest('POST', VALID_WEBHOOK);
      const response = await POST(req);
      expect(response.status).toBe(401);
    });

    it('returns 400 when name is missing', async () => {
      mockAuthenticated();

      const req = createNextRequest('POST', {
        url: 'https://example.com/wh',
        events: ['session.started'],
      });
      const response = await POST(req);
      expect(response.status).toBe(400);
    });

    it('returns 400 for non-HTTPS URL', async () => {
      mockAuthenticated();

      // WHY (FIX-042): HTTP URLs must be rejected to prevent man-in-the-middle
      // attacks on webhook payloads that may contain session data.
      const req = createNextRequest('POST', {
        name: 'Insecure',
        url: 'http://example.com/webhook',
        events: ['session.started'],
      });
      const response = await POST(req);
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toContain('HTTPS');
    });

    // WHY (FIX-027): The following SSRF tests verify that isSafeWebhookUrl()
    // blocks all internal/private network targets. Without this protection, an
    // attacker with an account could register a webhook pointing at our own
    // infrastructure (localhost, cloud metadata, private VPC addresses) and
    // use the webhook delivery system to probe internal services.

    it('returns 400 for SSRF: localhost URL blocked', async () => {
      mockAuthenticated();

      const req = createNextRequest('POST', {
        name: 'SSRF localhost',
        url: 'https://localhost/admin',
        events: ['session.started'],
      });
      const response = await POST(req);
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toContain('internal or private');
    });

    it('returns 400 for SSRF: 169.254.169.254 (AWS metadata) blocked', async () => {
      mockAuthenticated();

      // WHY: AWS EC2 metadata service at 169.254.169.254 returns instance
      // credentials, IAM role tokens, and VPC configuration. SSRF to this
      // endpoint is a critical cloud security vulnerability.
      const req = createNextRequest('POST', {
        name: 'SSRF metadata',
        url: 'https://169.254.169.254/latest/meta-data/',
        events: ['session.started'],
      });
      const response = await POST(req);
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toContain('internal or private');
    });

    it('returns 400 for SSRF: 10.0.0.1 (RFC 1918) blocked', async () => {
      mockAuthenticated();

      const req = createNextRequest('POST', {
        name: 'SSRF 10.x',
        url: 'https://10.0.0.1/internal-api',
        events: ['session.started'],
      });
      const response = await POST(req);
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toContain('internal or private');
    });

    it('returns 400 for SSRF: 192.168.1.1 (RFC 1918) blocked', async () => {
      mockAuthenticated();

      const req = createNextRequest('POST', {
        name: 'SSRF 192.168',
        url: 'https://192.168.1.1/router',
        events: ['session.started'],
      });
      const response = await POST(req);
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toContain('internal or private');
    });

    it('returns 400 for SSRF: 172.16.0.1 (RFC 1918) blocked', async () => {
      mockAuthenticated();

      const req = createNextRequest('POST', {
        name: 'SSRF 172.16',
        url: 'https://172.16.0.1/vpc-service',
        events: ['session.started'],
      });
      const response = await POST(req);
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toContain('internal or private');
    });

    it('returns 400 for SSRF: 127.0.0.1 loopback blocked', async () => {
      mockAuthenticated();

      // WHY: 127.0.0.1 is localhost and must be blocked to prevent SSRF
      // against services bound to loopback.
      const req = createNextRequest('POST', {
        name: 'SSRF loopback',
        url: 'https://127.0.0.1/admin',
        events: ['session.started'],
      });
      const response = await POST(req);
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toContain('internal or private');
    });

    it('returns 400 for SSRF: 0.0.0.0 blocked', async () => {
      mockAuthenticated();

      // WHY: 0.0.0.0 binds to all interfaces and is a common SSRF target.
      const req = createNextRequest('POST', {
        name: 'SSRF zero',
        url: 'https://0.0.0.0/admin',
        events: ['session.started'],
      });
      const response = await POST(req);
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toContain('internal or private');
    });

    it('returns 400 for SSRF: metadata.google.internal blocked', async () => {
      mockAuthenticated();

      // WHY: GCP metadata service uses this hostname. Must be blocked
      // alongside the AWS 169.254.169.254 IP-based check.
      const req = createNextRequest('POST', {
        name: 'SSRF GCP metadata',
        url: 'https://metadata.google.internal/computeMetadata/v1/',
        events: ['session.started'],
      });
      const response = await POST(req);
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toContain('internal or private');
    });

    it('returns 400 when no events selected', async () => {
      mockAuthenticated();

      const req = createNextRequest('POST', {
        name: 'No events',
        url: 'https://example.com/wh',
        events: [],
      });
      const response = await POST(req);
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toContain('event');
    });

    it('returns 403 when free tier user tries to create webhook (limit 0)', async () => {
      mockAuthenticated();

      // POST calls Promise.all with 2 parallel queries:
      // 1. getUserTier → subscriptions.select().eq().eq().single()
      fromCallQueue.push({ data: null, error: null }); // free tier
      // 2. count query → webhooks.select('id', { count: 'exact', head: true }).eq().is()
      fromCallQueue.push({ count: 0, error: null });

      const req = createNextRequest('POST', VALID_WEBHOOK);
      const response = await POST(req);
      expect(response.status).toBe(403);

      const body = await response.json();
      expect(body.error).toContain('Free plan');
    });

    it('returns 403 when pro user is at webhook limit (3)', async () => {
      mockAuthenticated();

      // 1. getUserTier → pro
      fromCallQueue.push({ data: { tier: 'pro' }, error: null });
      // 2. count → 3 (at limit)
      fromCallQueue.push({ count: 3, error: null });

      const req = createNextRequest('POST', VALID_WEBHOOK);
      const response = await POST(req);
      expect(response.status).toBe(403);

      const body = await response.json();
      expect(body.error).toContain('limit');
      expect(body.error).toContain('3');
    });

    it('returns 201 and secret when pro user creates webhook under limit', async () => {
      mockAuthenticated();

      // 1. getUserTier → pro
      fromCallQueue.push({ data: { tier: 'pro' }, error: null });
      // 2. count → 1 (under limit of 3)
      fromCallQueue.push({ count: 1, error: null });
      // 3. insert().select().single()
      fromCallQueue.push({
        data: {
          id: 'new-wh-id',
          name: 'My CI Webhook',
          url: 'https://example.com/webhook',
          events: ['session.completed'],
          is_active: true,
          secret: 'whsec_test_signing_secret',
          created_at: '2026-02-06T00:00:00Z',
        },
        error: null,
      });

      const req = createNextRequest('POST', VALID_WEBHOOK);
      const response = await POST(req);
      expect(response.status).toBe(201);

      const body = await response.json();
      // WHY: The secret is returned only at creation time (never again).
      // Verify it's present in the response but NOT inside the webhook object.
      expect(body.secret).toBe('whsec_test_signing_secret');
      expect(body.webhook).toBeDefined();
      expect(body.webhook.name).toBe('My CI Webhook');
      expect(body.webhook.secret).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // PATCH /api/webhooks/user
  // --------------------------------------------------------------------------

  describe('PATCH /api/webhooks/user', () => {
    it('returns 401 when unauthenticated', async () => {
      mockUnauthenticated();

      const req = createNextRequest('PATCH', {
        id: '00000000-0000-0000-0000-000000000001',
        name: 'Updated',
      });
      const response = await PATCH(req);
      expect(response.status).toBe(401);
    });

    it('returns 400 when webhook ID is missing', async () => {
      mockAuthenticated();

      const req = createNextRequest('PATCH', { name: 'Updated name' });
      const response = await PATCH(req);
      expect(response.status).toBe(400);
    });

    it('returns 400 when no fields to update are provided', async () => {
      mockAuthenticated();

      const req = createNextRequest('PATCH', {
        id: '00000000-0000-0000-0000-000000000001',
      });
      const response = await PATCH(req);
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toContain('No fields');
    });

    it('returns 404 when webhook not found (PGRST116)', async () => {
      mockAuthenticated();

      // update().eq().eq().is().select().single() → PGRST116
      fromCallQueue.push({ data: null, error: { code: 'PGRST116', message: 'Not found' } });

      const req = createNextRequest('PATCH', {
        id: '00000000-0000-0000-0000-000000000001',
        name: 'Renamed',
      });
      const response = await PATCH(req);
      expect(response.status).toBe(404);

      const body = await response.json();
      expect(body.error).toBe('Webhook not found');
    });

    it('returns 200 and updated webhook on success', async () => {
      mockAuthenticated();

      // update().eq().eq().is().select().single() → success
      fromCallQueue.push({
        data: {
          id: '00000000-0000-0000-0000-000000000001',
          name: 'Renamed Webhook',
          url: 'https://example.com/wh',
          events: ['session.completed'],
          is_active: true,
          created_at: '2026-02-01T00:00:00Z',
          updated_at: '2026-02-06T00:00:00Z',
        },
        error: null,
      });

      const req = createNextRequest('PATCH', {
        id: '00000000-0000-0000-0000-000000000001',
        name: 'Renamed Webhook',
      });
      const response = await PATCH(req);
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.webhook.name).toBe('Renamed Webhook');
    });
  });

  // --------------------------------------------------------------------------
  // DELETE /api/webhooks/user
  // --------------------------------------------------------------------------

  describe('DELETE /api/webhooks/user', () => {
    it('returns 401 when unauthenticated', async () => {
      mockUnauthenticated();

      const req = createNextRequest('DELETE', {
        id: '00000000-0000-0000-0000-000000000001',
      });
      const response = await DELETE(req);
      expect(response.status).toBe(401);
    });

    it('returns 400 for invalid UUID', async () => {
      mockAuthenticated();

      const req = createNextRequest('DELETE', { id: 'not-a-uuid' });
      const response = await DELETE(req);
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toContain('Invalid webhook ID');
    });

    it('returns 404 when webhook not found', async () => {
      mockAuthenticated();

      // Existence check → not found
      fromCallQueue.push({ data: null, error: null });

      const req = createNextRequest('DELETE', {
        id: '00000000-0000-0000-0000-000000000001',
      });
      const response = await DELETE(req);
      expect(response.status).toBe(404);

      const body = await response.json();
      expect(body.error).toBe('Webhook not found');
    });

    it('returns 200 and soft-deletes webhook on success', async () => {
      mockAuthenticated();

      // 1. Existence check → found
      fromCallQueue.push({ data: { id: '00000000-0000-0000-0000-000000000001' }, error: null });
      // 2. update (soft delete) → success
      fromCallQueue.push({ data: null, error: null });

      const req = createNextRequest('DELETE', {
        id: '00000000-0000-0000-0000-000000000001',
      });
      const response = await DELETE(req);
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.success).toBe(true);
    });
  });
});
