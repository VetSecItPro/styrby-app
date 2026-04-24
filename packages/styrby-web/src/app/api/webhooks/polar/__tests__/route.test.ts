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

// WHY vi.hoisted: vi.mock() factories are hoisted to the top of the file by
// Vitest before variable initializations run. Variables declared with `const`
// in module scope are in the Temporal Dead Zone at that point — referencing
// them inside a vi.mock() factory throws a ReferenceError. vi.hoisted() runs
// its callback BEFORE the hoist happens, so the returned value is available
// inside the vi.mock() factory. This is the idiomatic Vitest pattern for
// sharing a mock function reference between the factory and test assertions.
const { mockShouldHonorManualOverride } = vi.hoisted(() => ({
  mockShouldHonorManualOverride: vi.fn(),
}));

/** Mock for shouldHonorManualOverride from @styrby/shared/billing (T8) */
vi.mock('@styrby/shared/billing', async (importOriginal) => {
  const original = await importOriginal<typeof import('@styrby/shared/billing')>();
  return {
    ...original,
    shouldHonorManualOverride: mockShouldHonorManualOverride,
  };
});

/** Mock Supabase query builder chain */
const mockSelect = vi.fn().mockReturnThis();
const mockEq = vi.fn();
const mockSingle = vi.fn();
const mockUpsert = vi.fn().mockResolvedValue({ data: null, error: null });
const mockUpdate = vi.fn().mockReturnThis();
const mockInsert = vi.fn().mockResolvedValue({ data: null, error: null });
const mockOrder = vi.fn().mockReturnThis();
const mockLimit = vi.fn().mockReturnThis();

const mockFrom = vi.fn().mockReturnValue({
  select: mockSelect,
  eq: mockEq,
  single: mockSingle,
  upsert: mockUpsert,
  update: mockUpdate,
  insert: mockInsert,
  order: mockOrder,
  limit: mockLimit,
});

vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: vi.fn(() => ({
    from: mockFrom,
    rpc: vi.fn().mockResolvedValue({ data: null, error: new Error('rpc not available in test') }),
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
  const _signature = options?.signature ?? signPayload(payload);
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

    // WHY: vi.clearAllMocks() resets mockInsert to return undefined by default,
    // causing the route to crash on insert calls in tests that don't explicitly
    // set up the insert mock. Restoring the default here keeps pre-existing
    // tests that don't call insert from failing due to undefined.
    mockInsert.mockResolvedValue({ data: null, error: null });

    // WHY: shouldHonorManualOverride must have a default mock return value so
    // pre-existing subscription.created/updated tests (which don't configure
    // the override decision) don't crash. Default to 'polar_source' — the
    // baseline case that applies the webhook update as before T8 existed.
    mockShouldHonorManualOverride.mockResolvedValue({
      honor: false,
      reason: 'polar_source',
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
    it('returns 401 if POLAR_WEBHOOK_SECRET is not set (library treats missing secret as invalid)', async () => {
      // WHY 401 (not 500): with the library-based verifyPolarSignatureOrThrow,
      // a missing POLAR_WEBHOOK_SECRET causes verifyPolarSignature() to return
      // false (secret unset → reject), which verifyPolarSignatureOrThrow
      // converts to a PolarSignatureError → 401. The 500 path is reserved for
      // truly unexpected errors thrown outside PolarSignatureError. This is the
      // correct behavior: a missing secret means every signature verification
      // fails, which is a 401 from the caller's perspective.
      //
      // validatePolarEnv() at cold-start is the first line of defense against
      // a missing POLAR_WEBHOOK_SECRET reaching this path in production.
      vi.stubEnv('POLAR_WEBHOOK_SECRET', '');

      const event = createSubscriptionEvent('subscription.created');
      const request = createWebhookRequest(event);

      const response = await POST(request);
      expect(response.status).toBe(401);

      const body = await response.json();
      expect(body.error).toBe('Invalid signature');
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
      // Mock 1: Profile lookup succeeds
      mockSingle.mockResolvedValueOnce({
        data: { id: 'user-uuid-123' },
        error: null,
      });
      // Mock 2: Customer ID lookup (parallel)
      mockSingle.mockResolvedValueOnce({
        data: { user_id: 'user-uuid-123' },
        error: null,
      });
      // Mock 3: Existing sub check (no existing)
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
      // Mock 1: Profile lookup succeeds
      mockSingle.mockResolvedValueOnce({
        data: { id: 'user-uuid-123' },
        error: null,
      });
      // Mock 2: Customer ID lookup (parallel)
      mockSingle.mockResolvedValueOnce({
        data: { user_id: 'user-uuid-123' },
        error: null,
      });
      // Mock 3: Existing sub check
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
      // Mock 1: Profile lookup
      mockSingle.mockResolvedValueOnce({
        data: { id: 'user-uuid-123' },
        error: null,
      });
      // Mock 2: Customer ID lookup (parallel)
      mockSingle.mockResolvedValueOnce({
        data: { user_id: 'user-uuid-123' },
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
      // WHY: Promise.all fires profile + customer lookups concurrently (2 mocks),
      // then tier check runs (1 mock). We return combined data objects so the
      // result works regardless of which query consumes which mock.
      // Mock 1 & 2: both return data valid for either profile or customer lookup
      mockSingle.mockResolvedValueOnce({
        data: { id: 'user-uuid-123', user_id: 'user-uuid-123', tier: 'power', status: 'active' },
        error: null,
      });
      mockSingle.mockResolvedValueOnce({
        data: { id: 'user-uuid-123', user_id: 'user-uuid-123', tier: 'power', status: 'active' },
        error: null,
      });
      // Mock 3: existing subscription tier check
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
      // Mock 1 & 2: parallel profile + customer lookups (order non-deterministic)
      mockSingle.mockResolvedValueOnce({
        data: { id: 'user-uuid-123', user_id: 'user-uuid-123', tier: 'pro', status: 'active' },
        error: null,
      });
      mockSingle.mockResolvedValueOnce({
        data: { id: 'user-uuid-123', user_id: 'user-uuid-123', tier: 'pro', status: 'active' },
        error: null,
      });
      // Mock 3: existing subscription tier check
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
    it('skips rate limiting when Upstash Redis is not configured', async () => {
      // WHY: The webhook route now uses Upstash Redis for distributed rate
      // limiting (A-002). When UPSTASH_REDIS_REST_URL is not set (test/CI
      // environment), the limiter is null and rate limiting is skipped.
      // This is by design: the webhook signature check is the primary
      // security control, not rate limiting.
      const event = createSubscriptionEvent('subscription.created');
      const payload = JSON.stringify(event);
      const signature = signPayload(payload);

      const headersMock = new Headers();
      headersMock.set('x-polar-signature', signature);
      vi.mocked(headers).mockResolvedValue(
        headersMock as unknown as Awaited<ReturnType<typeof headers>>
      );

      mockSingle.mockResolvedValue({ data: { id: 'user-uuid-123' }, error: null });

      // Without Upstash, all requests should pass (no 429)
      const request = new Request('http://localhost:3000/api/webhooks/polar', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-forwarded-for': '10.0.0.1',
        },
        body: payload,
      });

      const response = await POST(request);
      // Should succeed (signature valid, no rate limit in test env)
      expect(response.status).toBe(200);
    });
  });

  // --------------------------------------------------------------------------
  // Phase 4.1 T8: Manual override honor logic (atomic RPC path)
  //
  // Three scenarios per spec §6 T8:
  //   1. Polar-sourced subscription — decision='polar_source' → tier updated via normal upsert
  //   2. Manual override active — decision='manual_override_active' → tier NOT changed, just logged
  //   3. Manual override expired — decision='override_expired' → route logs structurally ONLY.
  //      The atomic RPC (migration 045) has already applied the tier update + audit INSERT
  //      in a single transaction. The route does NOT call upsert or insert for this case.
  //
  // WHY mock shouldHonorManualOverride at the module boundary (not the DB):
  // shouldHonorManualOverride is tested exhaustively in its own unit test file
  // (packages/styrby-shared/src/billing/__tests__/manual-override.test.ts).
  // Here we test only the ROUTE's response to each decision - not the decision
  // logic itself. Mocking at the module boundary keeps these tests fast and
  // deterministic (no DB round-trip for the decision).
  //
  // SOC2 CC7.2: All three transitions are material billing events; the audit
  //   trail must be complete (for override_expired, guaranteed by the atomic RPC).
  // --------------------------------------------------------------------------

  describe('Phase 4.1 T8 — manual tier-override honor', () => {
    /**
     * Helper: send a signed subscription.updated event and return the response.
     */
    async function sendSignedSubscriptionUpdated(
      productId = 'prod_pro_monthly',
      userId = 'user-uuid-123'
    ) {
      const event = createSubscriptionEvent('subscription.updated', {
        product_id: productId,
        user_id: userId,
      });
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

    beforeEach(() => {
      // Default: profile + customer lookups return user-uuid-123
      mockSingle.mockResolvedValue({
        data: { id: 'user-uuid-123', user_id: 'user-uuid-123', tier: 'free', status: 'active' },
        error: null,
      });
      mockEq.mockReturnThis();
      mockOrder.mockReturnThis();
      mockLimit.mockReturnThis();
    });

    // ────────────────────────────────────────────────────────────────────────
    // Scenario 1: decision='polar_source' (no manual override in effect)
    //
    // WHY: The baseline - Polar is authoritative for this user. The webhook
    // should apply the tier update normally via the standard upsert path.
    // ────────────────────────────────────────────────────────────────────────
    it('T8-S1: applies tier update when shouldHonorManualOverride returns polar_source', async () => {
      mockShouldHonorManualOverride.mockResolvedValueOnce({
        honor: false,
        reason: 'polar_source',
      });

      // Profile lookup (x2 for parallel strategy)
      mockSingle.mockResolvedValueOnce({ data: { id: 'user-uuid-123' }, error: null });
      mockSingle.mockResolvedValueOnce({ data: { user_id: 'user-uuid-123' }, error: null });
      // Existing sub check (downgrade protection)
      mockSingle.mockResolvedValueOnce({ data: { tier: 'free', status: 'active' }, error: null });

      const response = await sendSignedSubscriptionUpdated();

      expect(response.status).toBe(200);
      // WHY: upsert must have been called - tier update applied via normal path.
      expect(mockUpsert).toHaveBeenCalledTimes(1);
      // WHY: no additional audit INSERT from the route for polar_source.
      expect(mockInsert).not.toHaveBeenCalled();
    });

    // ────────────────────────────────────────────────────────────────────────
    // Scenario 2: decision='manual_override_active' (future or permanent expiry)
    //
    // WHY: Active manual override. The webhook must not apply the tier update.
    // The override is preserved, and the skip is logged structurally with
    // skipped_reason='manual_override_active'. No DB writes happen.
    // (SOC2 CC7.2: skip is still a loggable event; the log itself is the audit trail.)
    // ────────────────────────────────────────────────────────────────────────
    it('T8-S2: skips tier update when manual override is active (future expiry)', async () => {
      const futureExpiry = '2027-01-01T00:00:00Z';

      mockShouldHonorManualOverride.mockResolvedValueOnce({
        honor: true,
        reason: 'manual_override_active',
        expiresAt: futureExpiry,
      });

      // Profile lookup (x2 for parallel strategy)
      mockSingle.mockResolvedValueOnce({ data: { id: 'user-uuid-123' }, error: null });
      mockSingle.mockResolvedValueOnce({ data: { user_id: 'user-uuid-123' }, error: null });

      const consoleInfoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      const response = await sendSignedSubscriptionUpdated('prod_power_monthly');

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.received).toBe(true);

      // WHY: tier must NOT have been upserted - override is active.
      expect(mockUpsert).not.toHaveBeenCalled();

      // WHY: no audit INSERT from the route - the atomic RPC did not run,
      // there is nothing to insert from the route for a skipped update.
      expect(mockInsert).not.toHaveBeenCalled();

      // WHY: structured log must contain skipped_reason so ops can trace the skip.
      // SOC2 CC7.2: material billing decisions that are skipped must be logged.
      const loggedJson = consoleInfoSpy.mock.calls
        .map((args) => {
          try { return JSON.parse(args[0] as string); } catch { return null; }
        })
        .find((obj) => obj?.skipped_reason === 'manual_override_active');

      expect(loggedJson).toBeDefined();
      expect(loggedJson?.override_expires_at).toBe(futureExpiry);

      consoleInfoSpy.mockRestore();
    });

    // ────────────────────────────────────────────────────────────────────────
    // Scenario 3: decision='override_expired' (atomic RPC already applied)
    //
    // WHY: Expired manual override. The atomic RPC (migration 045) has already
    // applied the tier update + reset + audit INSERT in one transaction.
    // The route must:
    //   a) NOT call upsert or insert - the DB already handled everything atomically.
    //   b) Log structurally with the audit_id and previous_actor from the RPC response.
    //   c) Return 200 { received: true }.
    //
    // SOC2 CC7.2: the audit row is guaranteed by the atomic DB function.
    // SOC2 CC6.1: the FOR UPDATE lock was held across the full expiry cycle;
    //   no TOCTOU race is possible.
    // ────────────────────────────────────────────────────────────────────────
    it('T8-S3: logs structurally and does NOT call upsert/insert when atomic RPC applied expiry', async () => {
      const pastExpiry = '2026-01-01T00:00:00Z';
      const prevAdminId = 'admin-uuid-999';

      mockShouldHonorManualOverride.mockResolvedValueOnce({
        honor: false,
        reason: 'override_expired',
        expiredAt: pastExpiry,
        previousActor: prevAdminId,
        auditId: 8888,
      });

      // Profile lookup (x2 for parallel strategy)
      mockSingle.mockResolvedValueOnce({ data: { id: 'user-uuid-123' }, error: null });
      mockSingle.mockResolvedValueOnce({ data: { user_id: 'user-uuid-123' }, error: null });

      const consoleInfoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      const response = await sendSignedSubscriptionUpdated('prod_pro_monthly');

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.received).toBe(true);

      // WHY: The atomic RPC already updated subscriptions. The route must NOT
      // call upsert again - that would double-apply the tier update outside the
      // transaction that held the FOR UPDATE lock. (SOC2 CC6.1.)
      expect(mockUpsert).not.toHaveBeenCalled();

      // WHY: The atomic RPC already inserted the admin_audit_log row. The route
      // must NOT insert again - that would create a duplicate audit entry.
      expect(mockInsert).not.toHaveBeenCalled();

      // WHY: Structured log must record the audit_id and previous_actor returned
      // by the RPC so ops can trace the expiry event back to the DB row.
      const loggedJson = consoleInfoSpy.mock.calls
        .map((args) => {
          try { return JSON.parse(args[0] as string); } catch { return null; }
        })
        .find((obj) => obj?.msg?.includes('override expired'));

      expect(loggedJson).toBeDefined();
      expect(loggedJson?.audit_id).toBe(8888);
      expect(loggedJson?.previous_actor).toBe(prevAdminId);
      expect(loggedJson?.expired_at).toBe(pastExpiry);

      consoleInfoSpy.mockRestore();
    });

    // ────────────────────────────────────────────────────────────────────────
    // Scenario 3b: Expired override, no prior audit actor (previousActor = null)
    //
    // WHY: When the override was set via direct SQL before the audit log existed,
    // the atomic RPC sets previousActor=null in the audit row. The route logs
    // null actor correctly and still returns 200 without any DB writes.
    // ────────────────────────────────────────────────────────────────────────
    it('T8-S3b: logs structurally with null previousActor when atomic RPC found no prior audit actor', async () => {
      const pastExpiry = '2026-01-01T00:00:00Z';

      mockShouldHonorManualOverride.mockResolvedValueOnce({
        honor: false,
        reason: 'override_expired',
        expiredAt: pastExpiry,
        previousActor: null, // WHY null: no prior override_tier audit row found
        auditId: 9999,
      });

      // Profile lookup (x2 for parallel strategy)
      mockSingle.mockResolvedValueOnce({ data: { id: 'user-uuid-123' }, error: null });
      mockSingle.mockResolvedValueOnce({ data: { user_id: 'user-uuid-123' }, error: null });

      const response = await sendSignedSubscriptionUpdated('prod_pro_monthly');

      expect(response.status).toBe(200);
      // Route must not perform any DB writes - the atomic RPC already did everything.
      expect(mockUpsert).not.toHaveBeenCalled();
      expect(mockInsert).not.toHaveBeenCalled();
    });

    // ────────────────────────────────────────────────────────────────────────
    // Scenario 3c: RPC rejects with ERRCODE 22023 (invalid tier value)
    //
    // WHY: The RPC-layer tier allowlist (migration 045 §4) raises ERRCODE 22023
    // when p_new_tier is not in the allowed set. shouldHonorManualOverride re-throws
    // this as a hard error (it does NOT fail-open like transient DB errors) because
    // proceeding would corrupt subscription state with an invalid tier.
    //
    // The route's outer try/catch must:
    //   a) Catch the thrown Error from shouldHonorManualOverride
    //   b) Log at error level (NOT crash / unhandled exception)
    //   c) Return HTTP 500 so Polar retries (standard Polar retry-on-5xx behavior)
    //   d) NOT call upsert or insert (no partial DB writes on an invalid tier)
    //
    // WHY 500 (not 422): from Polar's perspective this is a transient server
    // failure (the tier logic regressed). 422 would tell Polar to stop retrying;
    // 500 triggers retry, giving ops time to fix the regression.
    //
    // OWASP A09:2021: the error must surface in logs/Sentry (not swallowed).
    // ────────────────────────────────────────────────────────────────────────
    it('T8-S3c: returns 500 and does not upsert/insert when shouldHonorManualOverride throws 22023', async () => {
      // Simulate the re-throw from shouldHonorManualOverride when RPC returns
      // ERRCODE 22023. This models the scenario where a Node-layer regression
      // (or future Polar payload expansion) passes an invalid tier to the RPC.
      mockShouldHonorManualOverride.mockRejectedValueOnce(
        new Error(
          "shouldHonorManualOverride: invalid tier value 'bad-tier' rejected by RPC allowlist (ERRCODE 22023)"
        )
      );

      // Profile lookup (x2 for parallel strategy)
      mockSingle.mockResolvedValueOnce({ data: { id: 'user-uuid-123' }, error: null });
      mockSingle.mockResolvedValueOnce({ data: { user_id: 'user-uuid-123' }, error: null });

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const response = await sendSignedSubscriptionUpdated('prod_pro_monthly');

      // WHY 500: lets Polar retry; the Node-layer regression must be fixed first.
      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe('Processing failed');

      // WHY: no DB writes — the route must not call upsert or insert when the
      // tier gate throws. Partial writes with an invalid tier corrupt billing state.
      expect(mockUpsert).not.toHaveBeenCalled();
      expect(mockInsert).not.toHaveBeenCalled();

      // WHY: error must appear in logs (not swallowed) so Sentry captures it.
      // The route's outer catch logs `error.message` via console.error.
      const errorLogged = consoleErrorSpy.mock.calls.some(
        (args) => String(args[0]).includes('22023') || String(args[1]).includes('22023')
          || String(args[0]).includes('Processing') || String(args[1]).includes('invalid')
      );
      expect(errorLogged).toBe(true);

      consoleErrorSpy.mockRestore();
    });

    // ────────────────────────────────────────────────────────────────────────
    // Scenario 4: Concurrent delivery simulation
    //
    // WHY: CRITICAL 2 fix (migration 045) ensures only one webhook delivery
    // executes the expiry path. The DB-level FOR UPDATE lock means the second
    // delivery sees 'polar_source' (already reset) rather than 'override_expired'.
    //
    // This test verifies the route handles both decisions correctly in sequence:
    //   - First call: RPC returns override_expired - route logs + no DB writes
    //   - Second call: RPC returns polar_source - route applies tier update normally
    //
    // SOC2 CC6.1: Exactly one expiry event per override; no duplicate audit rows.
    // ────────────────────────────────────────────────────────────────────────
    it('T8-S4: concurrent delivery - only one delivery sees override_expired, other sees polar_source', async () => {
      // First delivery: override expired
      mockShouldHonorManualOverride
        .mockResolvedValueOnce({
          honor: false,
          reason: 'override_expired',
          expiredAt: '2026-01-01T00:00:00Z',
          previousActor: 'admin-uuid-concurrent',
          auditId: 7777,
        })
        // Second delivery: sees updated row (polar source)
        .mockResolvedValueOnce({
          honor: false,
          reason: 'polar_source',
        });

      // First delivery - profile lookups
      mockSingle
        .mockResolvedValueOnce({ data: { id: 'user-uuid-123' }, error: null })
        .mockResolvedValueOnce({ data: { user_id: 'user-uuid-123' }, error: null })
        // Second delivery - profile lookups
        .mockResolvedValueOnce({ data: { id: 'user-uuid-123' }, error: null })
        .mockResolvedValueOnce({ data: { user_id: 'user-uuid-123' }, error: null })
        // Second delivery - existing sub check (downgrade protection)
        .mockResolvedValueOnce({ data: { tier: 'free', status: 'active' }, error: null });

      const [resp1, resp2] = await Promise.all([
        sendSignedSubscriptionUpdated('prod_pro_monthly'),
        sendSignedSubscriptionUpdated('prod_pro_monthly'),
      ]);

      expect(resp1.status).toBe(200);
      expect(resp2.status).toBe(200);

      // First delivery: override_expired path - route must NOT write to DB
      // (atomic RPC already did that). Second delivery: polar_source - route
      // upserts once.
      // WHY exactly 1 upsert: only the polar_source delivery writes to subscriptions.
      // The override_expired delivery relies on the RPC having already done it.
      expect(mockUpsert).toHaveBeenCalledTimes(1);
      // WHY 0 inserts: neither delivery's route code should insert audit rows;
      // the atomic RPC in the first delivery already inserted the audit row.
      expect(mockInsert).not.toHaveBeenCalled();
    });
  });
});
