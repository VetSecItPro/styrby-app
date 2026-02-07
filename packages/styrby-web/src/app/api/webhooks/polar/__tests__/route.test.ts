/**
 * Polar Webhook Route Integration Tests
 *
 * Tests the POST /api/webhooks/polar endpoint which handles:
 * - subscription.created / subscription.updated / subscription.canceled
 * - order.created
 *
 * WHY these tests matter: The webhook handler is the only entry point for
 * billing state changes. A bug here can silently downgrade paying users,
 * grant free upgrades, or corrupt subscription records.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';

// ============================================================================
// Mocks — must be declared before any imports that use them
// ============================================================================

/** Mock Supabase query builder chain */
const mockSelect = vi.fn().mockReturnThis();
const mockEq = vi.fn();
const mockSingle = vi.fn();
const mockUpsert = vi.fn().mockResolvedValue({ data: null, error: null });
const mockUpdate = vi.fn().mockReturnThis();

const mockFrom = vi.fn().mockReturnValue({
  select: mockSelect,
  eq: mockEq,
  single: mockSingle,
  upsert: mockUpsert,
  update: mockUpdate,
});

vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: vi.fn(() => ({
    from: mockFrom,
  })),
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(),
}));

import { POST } from '../route';
import { headers } from 'next/headers';

// ============================================================================
// Test Helpers
// ============================================================================

const WEBHOOK_SECRET = 'test-webhook-secret-12345';

/**
 * Generate a valid HMAC-SHA256 signature for a payload.
 * Mirrors the verification logic in the route handler.
 */
function signPayload(payload: string): string {
  return crypto.createHmac('sha256', WEBHOOK_SECRET).update(payload).digest('hex');
}

/**
 * Create a mock Request with proper headers and signed body.
 */
function createWebhookRequest(
  body: Record<string, unknown>,
  options?: { signature?: string; ip?: string }
): Request {
  const payload = JSON.stringify(body);
  const signature = options?.signature ?? signPayload(payload);
  const ip = options?.ip ?? '10.0.0.1';

  return new Request('http://localhost:3000/api/webhooks/polar', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-forwarded-for': ip,
    },
    body: payload,
  });
}

/**
 * Standard subscription event payload for testing.
 */
function createSubscriptionEvent(
  type: string,
  overrides?: Record<string, unknown>
) {
  return {
    type,
    data: {
      id: 'sub_test_123',
      customer_id: 'cust_test_456',
      product_id: 'prod_pro_monthly',
      user_id: 'user-uuid-123',
      status: 'active',
      current_period_start: '2026-02-01T00:00:00Z',
      current_period_end: '2026-03-01T00:00:00Z',
      cancel_at_period_end: false,
      ...overrides,
    },
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('POST /api/webhooks/polar', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Set required env vars
    vi.stubEnv('POLAR_WEBHOOK_SECRET', WEBHOOK_SECRET);
    vi.stubEnv('POLAR_PRO_MONTHLY_PRODUCT_ID', 'prod_pro_monthly');
    vi.stubEnv('POLAR_PRO_ANNUAL_PRODUCT_ID', 'prod_pro_annual');
    vi.stubEnv('POLAR_POWER_MONTHLY_PRODUCT_ID', 'prod_power_monthly');
    vi.stubEnv('POLAR_POWER_ANNUAL_PRODUCT_ID', 'prod_power_annual');

    // Mock Next.js headers() to return signature
    vi.mocked(headers).mockResolvedValue(
      new Headers() as unknown as Awaited<ReturnType<typeof headers>>
    );

    // Default: profile lookup succeeds
    mockEq.mockReturnThis();
    mockSingle.mockResolvedValue({
      data: { id: 'user-uuid-123' },
      error: null,
    });
  });

  // --------------------------------------------------------------------------
  // Signature Verification
  // --------------------------------------------------------------------------

  describe('signature verification', () => {
    it('rejects requests with missing signature', async () => {
      const event = createSubscriptionEvent('subscription.created');
      const payload = JSON.stringify(event);

      // Mock headers to return null for x-polar-signature
      vi.mocked(headers).mockResolvedValue(
        new Headers() as unknown as Awaited<ReturnType<typeof headers>>
      );

      const request = new Request('http://localhost:3000/api/webhooks/polar', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-forwarded-for': '10.0.0.1',
        },
        body: payload,
      });

      const response = await POST(request);
      expect(response.status).toBe(401);

      const body = await response.json();
      expect(body.error).toBe('Invalid signature');
    });

    it('rejects requests with invalid signature', async () => {
      const event = createSubscriptionEvent('subscription.created');
      const payload = JSON.stringify(event);

      // WHY: Signature must be 64 hex chars (SHA-256 digest length) because
      // crypto.timingSafeEqual requires equal-length buffers.
      const badHeaders = new Headers();
      badHeaders.set('x-polar-signature', 'a'.repeat(64));
      vi.mocked(headers).mockResolvedValue(
        badHeaders as unknown as Awaited<ReturnType<typeof headers>>
      );

      const request = new Request('http://localhost:3000/api/webhooks/polar', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-forwarded-for': '10.0.0.1',
        },
        body: payload,
      });

      const response = await POST(request);
      expect(response.status).toBe(401);
    });

    it('accepts requests with valid signature', async () => {
      const event = createSubscriptionEvent('subscription.created');
      const payload = JSON.stringify(event);
      const signature = signPayload(payload);

      const headersMock = new Headers();
      headersMock.set('x-polar-signature', signature);
      vi.mocked(headers).mockResolvedValue(
        headersMock as unknown as Awaited<ReturnType<typeof headers>>
      );

      const request = new Request('http://localhost:3000/api/webhooks/polar', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-forwarded-for': '10.0.0.1',
        },
        body: payload,
      });

      const response = await POST(request);
      expect(response.status).toBe(200);
    });
  });

  // --------------------------------------------------------------------------
  // Missing Configuration
  // --------------------------------------------------------------------------

  describe('missing configuration', () => {
    it('returns 500 if POLAR_WEBHOOK_SECRET is not set', async () => {
      vi.stubEnv('POLAR_WEBHOOK_SECRET', '');

      const event = createSubscriptionEvent('subscription.created');
      const request = createWebhookRequest(event);

      const response = await POST(request);
      expect(response.status).toBe(500);

      const body = await response.json();
      expect(body.error).toBe('Webhook not configured');
    });
  });

  // --------------------------------------------------------------------------
  // Payload Validation
  // --------------------------------------------------------------------------

  describe('payload validation', () => {
    it('rejects malformed JSON', async () => {
      const headersMock = new Headers();
      const badPayload = 'not json at all{{{';
      headersMock.set('x-polar-signature', signPayload(badPayload));
      vi.mocked(headers).mockResolvedValue(
        headersMock as unknown as Awaited<ReturnType<typeof headers>>
      );

      const request = new Request('http://localhost:3000/api/webhooks/polar', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-forwarded-for': '10.0.0.1',
        },
        body: badPayload,
      });

      const response = await POST(request);
      expect(response.status).toBe(400);
    });

    it('rejects payload missing type field', async () => {
      const payload = JSON.stringify({ data: { id: 'test' } });
      const headersMock = new Headers();
      headersMock.set('x-polar-signature', signPayload(payload));
      vi.mocked(headers).mockResolvedValue(
        headersMock as unknown as Awaited<ReturnType<typeof headers>>
      );

      const request = new Request('http://localhost:3000/api/webhooks/polar', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-forwarded-for': '10.0.0.1',
        },
        body: payload,
      });

      const response = await POST(request);
      expect(response.status).toBe(400);
    });

    it('returns 200 for unrecognized event type (to prevent Polar retries)', async () => {
      const event = { type: 'some.future.event', data: {} };
      const payload = JSON.stringify(event);
      const headersMock = new Headers();
      headersMock.set('x-polar-signature', signPayload(payload));
      vi.mocked(headers).mockResolvedValue(
        headersMock as unknown as Awaited<ReturnType<typeof headers>>
      );

      const request = new Request('http://localhost:3000/api/webhooks/polar', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-forwarded-for': '10.0.0.1',
        },
        body: payload,
      });

      const response = await POST(request);
      // WHY: Returns 200 to avoid Polar retry loops on unknown event types
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.received).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Subscription Created / Updated
  // --------------------------------------------------------------------------

  describe('subscription.created / subscription.updated', () => {
    /**
     * Helper to set up mocks and send a signed webhook event.
     */
    async function sendSignedEvent(event: Record<string, unknown>) {
      const payload = JSON.stringify(event);
      const signature = signPayload(payload);

      const headersMock = new Headers();
      headersMock.set('x-polar-signature', signature);
      vi.mocked(headers).mockResolvedValue(
        headersMock as unknown as Awaited<ReturnType<typeof headers>>
      );

      const request = new Request('http://localhost:3000/api/webhooks/polar', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-forwarded-for': '10.0.0.1',
        },
        body: payload,
      });

      return POST(request);
    }

    it('upserts subscription for valid subscription.created event', async () => {
      // Profile lookup succeeds
      mockSingle.mockResolvedValueOnce({
        data: { id: 'user-uuid-123' },
        error: null,
      });
      // Existing sub check (no existing)
      mockSingle.mockResolvedValueOnce({
        data: null,
        error: null,
      });

      const event = createSubscriptionEvent('subscription.created');
      const response = await sendSignedEvent(event);

      expect(response.status).toBe(200);
      expect(mockUpsert).toHaveBeenCalled();
    });

    it('handles subscription.updated event', async () => {
      // Profile lookup succeeds
      mockSingle.mockResolvedValueOnce({
        data: { id: 'user-uuid-123' },
        error: null,
      });
      // Existing sub check
      mockSingle.mockResolvedValueOnce({
        data: { tier: 'pro', status: 'active' },
        error: null,
      });

      const event = createSubscriptionEvent('subscription.updated', {
        product_id: 'prod_power_monthly',
      });
      const response = await sendSignedEvent(event);

      expect(response.status).toBe(200);
    });

    it('returns 200 when no user found (Polar ahead of signup)', async () => {
      // Profile lookup returns null
      mockSingle.mockResolvedValueOnce({
        data: null,
        error: null,
      });
      // Customer ID lookup also returns null
      mockSingle.mockResolvedValueOnce({
        data: null,
        error: null,
      });

      const event = createSubscriptionEvent('subscription.created', {
        user_id: null,
      });
      const response = await sendSignedEvent(event);

      // WHY: Returns 200 to acknowledge receipt even though user wasn't found.
      // Polar may fire subscription events before user completes signup.
      expect(response.status).toBe(200);
      expect(mockUpsert).not.toHaveBeenCalled();
    });

    it('skips upsert for unrecognized product_id (prevents tier corruption)', async () => {
      mockSingle.mockResolvedValueOnce({
        data: { id: 'user-uuid-123' },
        error: null,
      });

      const event = createSubscriptionEvent('subscription.created', {
        product_id: 'prod_unknown_thing',
      });
      const response = await sendSignedEvent(event);

      expect(response.status).toBe(200);
      expect(mockUpsert).not.toHaveBeenCalled();
    });

    it('prevents downgrade from power to pro (FIX-007)', async () => {
      // Profile lookup succeeds
      mockSingle.mockResolvedValueOnce({
        data: { id: 'user-uuid-123' },
        error: null,
      });
      // Existing sub is power tier
      mockSingle.mockResolvedValueOnce({
        data: { tier: 'power', status: 'active' },
        error: null,
      });

      const event = createSubscriptionEvent('subscription.updated', {
        product_id: 'prod_pro_monthly',
      });
      const response = await sendSignedEvent(event);

      expect(response.status).toBe(200);
      // WHY: Downgrade protection — should NOT upsert when existing tier > event tier
      expect(mockUpsert).not.toHaveBeenCalled();
    });

    it('allows upgrade from pro to power', async () => {
      // Profile lookup succeeds
      mockSingle.mockResolvedValueOnce({
        data: { id: 'user-uuid-123' },
        error: null,
      });
      // Existing sub is pro tier
      mockSingle.mockResolvedValueOnce({
        data: { tier: 'pro', status: 'active' },
        error: null,
      });

      const event = createSubscriptionEvent('subscription.updated', {
        product_id: 'prod_power_monthly',
      });
      const response = await sendSignedEvent(event);

      expect(response.status).toBe(200);
      expect(mockUpsert).toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // Subscription Canceled
  // --------------------------------------------------------------------------

  describe('subscription.canceled', () => {
    async function sendSignedEvent(event: Record<string, unknown>) {
      const payload = JSON.stringify(event);
      const signature = signPayload(payload);
      const headersMock = new Headers();
      headersMock.set('x-polar-signature', signature);
      vi.mocked(headers).mockResolvedValue(
        headersMock as unknown as Awaited<ReturnType<typeof headers>>
      );

      const request = new Request('http://localhost:3000/api/webhooks/polar', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-forwarded-for': '10.0.0.1',
        },
        body: payload,
      });
      return POST(request);
    }

    it('updates subscription status to canceled', async () => {
      const event = {
        type: 'subscription.canceled',
        data: {
          id: 'sub_test_123',
          customer_id: 'cust_test_456',
          status: 'canceled',
          canceled_at: '2026-02-05T10:00:00Z',
        },
      };

      // Chain: .update(...).eq(...)
      mockEq.mockResolvedValueOnce({ data: null, error: null });

      const response = await sendSignedEvent(event);
      expect(response.status).toBe(200);
      expect(mockUpdate).toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // Order Created
  // --------------------------------------------------------------------------

  describe('order.created', () => {
    it('acknowledges order.created with 200', async () => {
      const event = { type: 'order.created', data: { id: 'ord_123' } };
      const payload = JSON.stringify(event);
      const headersMock = new Headers();
      headersMock.set('x-polar-signature', signPayload(payload));
      vi.mocked(headers).mockResolvedValue(
        headersMock as unknown as Awaited<ReturnType<typeof headers>>
      );

      const request = new Request('http://localhost:3000/api/webhooks/polar', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-forwarded-for': '10.0.0.1',
        },
        body: payload,
      });

      const response = await POST(request);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.received).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Rate Limiting
  // --------------------------------------------------------------------------

  describe('rate limiting', () => {
    it('returns 429 after exceeding rate limit', async () => {
      // The webhook route uses its own in-memory rate limiter with
      // 100 requests per minute per IP. We need to exhaust it.
      // Use a unique IP to avoid collisions with other tests.
      const uniqueIp = `10.99.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
      const event = createSubscriptionEvent('subscription.created');
      const payload = JSON.stringify(event);
      const signature = signPayload(payload);

      const headersMock = new Headers();
      headersMock.set('x-polar-signature', signature);
      vi.mocked(headers).mockResolvedValue(
        headersMock as unknown as Awaited<ReturnType<typeof headers>>
      );

      // Mock all profile lookups to succeed
      mockSingle.mockResolvedValue({ data: { id: 'user-uuid-123' }, error: null });

      // Fire 101 requests from the same IP
      let rateLimited = false;
      for (let i = 0; i < 105; i++) {
        const request = new Request('http://localhost:3000/api/webhooks/polar', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-forwarded-for': uniqueIp,
          },
          body: payload,
        });

        const response = await POST(request);
        if (response.status === 429) {
          rateLimited = true;
          expect(response.headers.get('Retry-After')).toBe('60');
          break;
        }
      }

      expect(rateLimited).toBe(true);
    });
  });
});
