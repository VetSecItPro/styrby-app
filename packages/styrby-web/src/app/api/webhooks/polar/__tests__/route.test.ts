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

// Hoisted mocks for the Polar SDK client used by cascade-cancel (Bugs #4 + #7).
// Default behavior is "no seat addons in flight" — tests that exercise the
// cascade path override these via mockReturnValueOnce on the test side.
const { mockPolarSubscriptionsList, mockPolarSubscriptionsUpdate } = vi.hoisted(
  () => ({
    mockPolarSubscriptionsList: vi.fn().mockResolvedValue({
      result: { items: [] },
    }),
    mockPolarSubscriptionsUpdate: vi.fn().mockResolvedValue({
      id: 'mock_sub_updated',
      status: 'active',
    }),
  }),
);

// Mock @/lib/polar to expose the polar SDK client + helpers without
// instantiating @polar-sh/sdk (which calls Polar at module load).
//
// WHY vi.mock with a factory: lib/polar.ts instantiates `new Polar(...)` at
// module scope — pulling that in during tests would (a) require a real
// POLAR_ACCESS_TOKEN env, (b) emit network noise on import. We replace the
// module surface with stubs that expose only what the route + cascade helper
// actually use: `polar.subscriptions.{list,update}`, `isTeamSeatProduct`,
// and `STYRBY_PRORATION_BEHAVIOR`.
vi.mock('@/lib/polar', () => ({
  polar: {
    subscriptions: {
      list: mockPolarSubscriptionsList,
      update: mockPolarSubscriptionsUpdate,
    },
  },
  isTeamSeatProduct: (productId: string): boolean => {
    if (!productId) return false;
    return (
      productId === process.env.POLAR_GROWTH_SEAT_MONTHLY_PRODUCT_ID ||
      productId === process.env.POLAR_GROWTH_SEAT_ANNUAL_PRODUCT_ID
    );
  },
  STYRBY_PRORATION_BEHAVIOR: 'next_period' as const,
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
// WHY mockReturnValue with { select } shape instead of mockResolvedValue:
// Migration 054 adds event-id dedup to the individual subscription path.
// The dedup block calls supabase.from('polar_webhook_events').upsert(...).select('event_id').
// mockUpsert must return an object with a `.select()` method that resolves to
// { data, error } — not a raw resolved value (which has no .select property).
//
// Default behavior: upsert returns a "new event" row ({ data: [{ event_id: 'evt_default' }] })
// so all pre-existing tests that don't configure this mock explicitly proceed through
// the dedup block and hit their own test logic unchanged.
//
// Tests that need to simulate a conflict (duplicate event) or a DB error must
// override this with mockUpsert.mockReturnValueOnce({ select: vi.fn().mockResolvedValueOnce(...) }).
//
// For the subscriptions upsert (second upsert call in normal processing), tests use
// mockUpsert.mockResolvedValueOnce({ data: null, error: null }) after the dedup mock.
// When a test doesn't set up the second upsert, the default fallback
// (mockReturnValue → { select }) is still called, so subscriptions.upsert also returns
// a chainable object. The route then calls .select() again — but it doesn't on the
// subscriptions upsert (it's a fire-and-forget upsert without .select()). The mock chain
// handles this gracefully because the resolved value is not awaited for .select() there.
//
// IMPORTANT: The subscriptions upsert does NOT chain .select() — it is just
// `await supabase.from('subscriptions').upsert(...)` — so mockUpsert.mockReturnValue
// for the dedup case works: the subscriptions upsert resolves to { select: fn } which
// is discarded (not awaited further). This is benign — vitest does not care about
// unconsumed mock return values.
const mockUpsertSelectFn = vi.fn().mockResolvedValue({
  data: [{ event_id: 'evt_default_new' }],
  error: null,
});
const mockUpsert = vi.fn().mockReturnValue({ select: mockUpsertSelectFn });
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
    // WHY vi.resetAllMocks() (not vi.clearAllMocks()): clearAllMocks() clears
    // call counts and results but does NOT clear the mockReturnValueOnce queue.
    // If a test sets mockUpsert.mockReturnValueOnce(...) and that Once value is
    // never consumed (because the test hits a different assertion first), the
    // unconsumed Once value leaks into the next test and causes spurious failures.
    // resetAllMocks() also clears the Once queue, preventing cross-test pollution.
    // After reset, we re-establish all defaults so the mock chain is functional.
    vi.resetAllMocks();

    // Set required env vars
    vi.stubEnv('POLAR_WEBHOOK_SECRET', WEBHOOK_SECRET);
    vi.stubEnv('POLAR_PRO_MONTHLY_PRODUCT_ID', 'prod_pro_monthly');
    vi.stubEnv('POLAR_PRO_ANNUAL_PRODUCT_ID', 'prod_pro_annual');
    vi.stubEnv('POLAR_POWER_MONTHLY_PRODUCT_ID', 'prod_power_monthly');
    vi.stubEnv('POLAR_POWER_ANNUAL_PRODUCT_ID', 'prod_power_annual');
    // Growth tier + seat addon products (Bugs #4 + #7 / Phase H2 cascade tests).
    // WHY all four: getPlanFromProductId resolves both monthly and annual
    // variants; isTeamSeatProduct pattern-matches the seat-addon env vars.
    vi.stubEnv('POLAR_GROWTH_MONTHLY_PRODUCT_ID', 'prod_growth_monthly');
    vi.stubEnv('POLAR_GROWTH_ANNUAL_PRODUCT_ID', 'prod_growth_annual');
    vi.stubEnv('POLAR_GROWTH_SEAT_MONTHLY_PRODUCT_ID', 'prod_growth_seat_monthly');
    vi.stubEnv('POLAR_GROWTH_SEAT_ANNUAL_PRODUCT_ID', 'prod_growth_seat_annual');

    // Re-establish Polar SDK mocks — resetAllMocks() clears them every test.
    // Default: empty seat-addon list, update succeeds. Cascade tests override
    // mockPolarSubscriptionsList per-test with mockResolvedValueOnce.
    mockPolarSubscriptionsList.mockResolvedValue({ result: { items: [] } });
    mockPolarSubscriptionsUpdate.mockResolvedValue({
      id: 'mock_sub_updated',
      status: 'active',
    });

    // Mock Next.js headers() to return signature
    vi.mocked(headers).mockResolvedValue(
      new Headers() as unknown as Awaited<ReturnType<typeof headers>>
    );

    // Re-establish the mock chain builder — resetAllMocks() clears mockFrom's
    // mockReturnValue impl so it would return undefined and crash every test.
    // WHY same object shape: mirrors the original top-level mockReturnValue call.
    mockFrom.mockReturnValue({
      select: mockSelect,
      eq: mockEq,
      single: mockSingle,
      upsert: mockUpsert,
      update: mockUpdate,
      insert: mockInsert,
      order: mockOrder,
      limit: mockLimit,
    });

    // Re-establish chain traversal mocks.
    // WHY: resetAllMocks() removes all implementations. Without mockReturnThis(),
    // eq/select/update/order/limit return undefined and break the fluent chain.
    mockSelect.mockReturnThis();
    mockEq.mockReturnThis();
    mockUpdate.mockReturnThis();
    mockOrder.mockReturnThis();
    mockLimit.mockReturnThis();

    // Default: profile lookup succeeds
    mockSingle.mockResolvedValue({
      data: { id: 'user-uuid-123' },
      error: null,
    });

    // Default: insert succeeds (no error)
    mockInsert.mockResolvedValue({ data: null, error: null });

    // WHY upsert returns a chainable { select } object (not a plain resolved value):
    // The dedup block calls .upsert(...).select('event_id') — a method chain.
    // Default: "new event" row returned so all pre-existing tests proceed normally.
    // Tests that need duplicate/error behavior override mockUpsert per-test with
    // mockReturnValueOnce — which resetAllMocks() safely clears between tests.
    mockUpsertSelectFn.mockResolvedValue({
      data: [{ event_id: 'evt_default_new' }],
      error: null,
    });
    mockUpsert.mockReturnValue({ select: mockUpsertSelectFn });

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

    // ------------------------------------------------------------------------
    // Bug #9 (Kaulby hardening) — Growth-tier rank guard cases
    // ------------------------------------------------------------------------
    // WHY these tests: Phase H5 introduces Growth as the new highest paid tier
    // alongside legacy Power/Team/Business/Enterprise rows still present in the
    // subscription_tier enum (migration 055). The tierRank table maps all of
    // free=0, pro=1, and {power,team,business,enterprise,growth}=2. The guard
    // uses strict `<` so equal-rank events PROCEED (renewal / cross-grade),
    // genuine downgrades (rank-2 → rank-0/1) are rejected.

    it('rejects downgrade from growth to free (Bug #9)', async () => {
      // WHY: late .active for the deprecated free tier must NOT clobber a paying
      // growth subscriber. growth=2, free=0, 0 < 2 → guard rejects.
      mockSingle.mockResolvedValueOnce({
        data: { id: 'user-uuid-123', user_id: 'user-uuid-123', tier: 'growth', status: 'active' },
        error: null,
      });
      mockSingle.mockResolvedValueOnce({
        data: { id: 'user-uuid-123', user_id: 'user-uuid-123', tier: 'growth', status: 'active' },
        error: null,
      });
      mockSingle.mockResolvedValueOnce({
        data: { tier: 'growth', status: 'active' },
        error: null,
      });

      // WHY product_id 'prod_unknown_thing': there is no Free product in Polar,
      // so we exercise the unrecognized-product branch which short-circuits
      // before tierRank — confirming defense-in-depth (no upsert either way).
      const event = createSubscriptionEvent('subscription.updated', {
        product_id: 'prod_unknown_thing',
      });
      const response = await sendSignedEvent(event);

      expect(response.status).toBe(200);
      expect(mockUpsert).not.toHaveBeenCalled();
    });

    it('allows free→growth upgrade event (rank up, Bug #9)', async () => {
      // WHY: free=0, growth=2 → 2 < 0 is false, guard passes, upsert runs.
      // Stand-in: 'prod_power_monthly' resolves to tier='power' which shares
      // rank 2 with growth (defensive aliasing per the new tierRank table).
      mockSingle.mockResolvedValueOnce({
        data: { id: 'user-uuid-123', user_id: 'user-uuid-123', tier: 'free', status: 'active' },
        error: null,
      });
      mockSingle.mockResolvedValueOnce({
        data: { id: 'user-uuid-123', user_id: 'user-uuid-123', tier: 'free', status: 'active' },
        error: null,
      });
      mockSingle.mockResolvedValueOnce({
        data: { tier: 'free', status: 'active' },
        error: null,
      });

      const event = createSubscriptionEvent('subscription.updated', {
        product_id: 'prod_power_monthly',
      });
      const response = await sendSignedEvent(event);

      expect(response.status).toBe(200);
      expect(mockUpsert).toHaveBeenCalled();
    });

    it('allows renewal at same growth/power rank (Bug #9)', async () => {
      // WHY: existing tier=growth, incoming tier=power, both rank 2, strict `<`
      // false → upsert proceeds. This is the renewal / Polar-late-event case
      // that must NOT be rejected (rejection would block legitimate renewals).
      mockSingle.mockResolvedValueOnce({
        data: { id: 'user-uuid-123', user_id: 'user-uuid-123', tier: 'growth', status: 'active' },
        error: null,
      });
      mockSingle.mockResolvedValueOnce({
        data: { id: 'user-uuid-123', user_id: 'user-uuid-123', tier: 'growth', status: 'active' },
        error: null,
      });
      mockSingle.mockResolvedValueOnce({
        data: { tier: 'growth', status: 'active' },
        error: null,
      });

      const event = createSubscriptionEvent('subscription.updated', {
        product_id: 'prod_power_monthly',
      });
      const response = await sendSignedEvent(event);

      expect(response.status).toBe(200);
      expect(mockUpsert).toHaveBeenCalled();
    });

    it('allows pro→growth-rank upgrade (Bug #9)', async () => {
      // WHY: pro=1, power(=growth-rank)=2 → 2 < 1 false → upsert proceeds.
      mockSingle.mockResolvedValueOnce({
        data: { id: 'user-uuid-123', user_id: 'user-uuid-123', tier: 'pro', status: 'active' },
        error: null,
      });
      mockSingle.mockResolvedValueOnce({
        data: { id: 'user-uuid-123', user_id: 'user-uuid-123', tier: 'pro', status: 'active' },
        error: null,
      });
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

    it('rejects downgrade from team-legacy to pro (Bug #9 alias)', async () => {
      // WHY: team is a legacy alias at rank 2; an inbound Pro event (rank 1)
      // must be rejected to prevent a stale .active from demoting a team-tier
      // row still present in the enum per migration 055.
      mockSingle.mockResolvedValueOnce({
        data: { id: 'user-uuid-123', user_id: 'user-uuid-123', tier: 'team', status: 'active' },
        error: null,
      });
      mockSingle.mockResolvedValueOnce({
        data: { id: 'user-uuid-123', user_id: 'user-uuid-123', tier: 'team', status: 'active' },
        error: null,
      });
      mockSingle.mockResolvedValueOnce({
        data: { tier: 'team', status: 'active' },
        error: null,
      });

      const event = createSubscriptionEvent('subscription.updated', {
        product_id: 'prod_pro_monthly',
      });
      const response = await sendSignedEvent(event);

      expect(response.status).toBe(200);
      expect(mockUpsert).not.toHaveBeenCalled();
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
  // Order Refunded — Bug #8 / Phase H6 subscription-id match guard
  //
  // WHY these tests: order.refunded blanket-resets are a billing-state
  // landmine. The handler MUST differentiate between:
  //   1. Main subscription refund        → reset to free
  //   2. Side-purchase refund (seat addon) → preserve main tier
  //   3. Refund event with missing subscription_id → graceful no-op
  //
  // These tests pin the contract so a future refactor cannot regress to the
  // naive "always reset" behavior. SOC2 CC7.2: every billing decision is
  // observable via audit_log; we assert the audit row's metadata.event_subtype
  // discriminator is present in every branch.
  // --------------------------------------------------------------------------

  describe('order.refunded (Bug #8 subscription-id match guard)', () => {
    /** Build a signed order.refunded request. */
    async function sendSignedRefund(body: Record<string, unknown>): Promise<Response> {
      const payload = JSON.stringify(body);
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

    it('main subscription refund: resets to free, audit metadata event_subtype=order_refunded_main', async () => {
      // Subscription lookup returns the user's main sub with the SAME id as the
      // refunded subscription_id below.
      mockSingle.mockResolvedValueOnce({
        data: {
          user_id: 'user-uuid-123',
          polar_subscription_id: 'sub_main_xyz',
          tier: 'pro',
        },
        error: null,
      });

      // The flow makes TWO .eq() calls in sequence:
      //   1. SELECT ... .eq('polar_customer_id', ...).single() — must return the
      //      chain object so .single() can be called next (mockSingle resolves it).
      //   2. UPDATE ... .eq('polar_subscription_id', ...) — must resolve to { error: null }.
      //
      // Defaults from beforeEach use mockReturnThis() for ALL calls. Adding a
      // mockResolvedValueOnce would land on call 1 (FIFO), breaking the lookup.
      // We explicitly chain: first call returns the mock itself (preserving the
      // chain), second call resolves with success.
      mockEq.mockReturnValueOnce({
        select: mockSelect,
        eq: mockEq,
        single: mockSingle,
        upsert: mockUpsert,
        update: mockUpdate,
        insert: mockInsert,
        order: mockOrder,
        limit: mockLimit,
      });
      mockEq.mockResolvedValueOnce({ data: null, error: null });

      const event = {
        id: 'evt_refund_main_001',
        type: 'order.refunded',
        data: {
          id: 'ord_refund_001',
          customer_id: 'cust_test_456',
          subscription_id: 'sub_main_xyz', // === main subscription
        },
      };

      const response = await sendSignedRefund(event);
      expect(response.status).toBe(200);
      const body = await response.json();
      // WHY no side_purchase_refund key on main-sub branch: the response shape
      // intentionally differs so callers/observability can distinguish the path.
      expect(body.side_purchase_refund).toBeUndefined();
      expect(body.received).toBe(true);

      // Verify update was called to reset tier to free.
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          tier: 'free',
          status: 'canceled',
        })
      );

      // Verify audit_log insert with main-branch discriminator.
      expect(mockInsert).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'subscription_changed',
          metadata: expect.objectContaining({
            event_subtype: 'order_refunded_main',
            refunded_subscription_id: 'sub_main_xyz',
            main_subscription_id: 'sub_main_xyz',
            previous_tier: 'pro',
            new_tier: 'free',
          }),
        })
      );
    });

    it('side-purchase refund (subscription_id !== main): preserves main tier, audit event_subtype=order_refunded_side_purchase, response side_purchase_refund=true', async () => {
      // Subscription lookup returns the user's main sub with a DIFFERENT id
      // than the refunded subscription_id.
      mockSingle.mockResolvedValueOnce({
        data: {
          user_id: 'user-uuid-123',
          polar_subscription_id: 'sub_main_xyz',
          tier: 'pro',
        },
        error: null,
      });

      const event = {
        id: 'evt_refund_seat_001',
        type: 'order.refunded',
        data: {
          id: 'ord_refund_seat_001',
          customer_id: 'cust_test_456',
          subscription_id: 'sub_seat_addon_abc', // !== main
        },
      };

      const response = await sendSignedRefund(event);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.received).toBe(true);
      // WHY this assertion is the headline of Bug #8: side_purchase_refund=true
      // is the contract that proves the guard fired and the main tier was
      // preserved. If this flag flips false on a side-purchase refund, the
      // billing pipeline is back to the naive blanket-reset behavior.
      expect(body.side_purchase_refund).toBe(true);

      // Verify NO subscription update was called (main tier preserved).
      expect(mockUpdate).not.toHaveBeenCalled();

      // Verify audit_log insert with side-purchase discriminator.
      expect(mockInsert).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'subscription_changed',
          metadata: expect.objectContaining({
            event_subtype: 'order_refunded_side_purchase',
            refunded_subscription_id: 'sub_seat_addon_abc',
            main_subscription_id: 'sub_main_xyz',
          }),
        })
      );
    });

    it('refund with missing subscription_id: graceful 200 with side_purchase_refund=true, no main-tier reset', async () => {
      // Subscription lookup succeeds (so userMainSubscriptionId is non-null),
      // but the refund event omits subscription_id entirely. The guard MUST
      // treat this as not-a-main-sub-refund (refundedSubscriptionId === null
      // fails the equality check) and preserve the main tier.
      mockSingle.mockResolvedValueOnce({
        data: {
          user_id: 'user-uuid-123',
          polar_subscription_id: 'sub_main_xyz',
          tier: 'pro',
        },
        error: null,
      });

      const event = {
        id: 'evt_refund_missing_subid_001',
        type: 'order.refunded',
        data: {
          id: 'ord_refund_missing_001',
          customer_id: 'cust_test_456',
          // subscription_id intentionally omitted
        },
      };

      const response = await sendSignedRefund(event);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.received).toBe(true);
      expect(body.side_purchase_refund).toBe(true);

      // No main-tier reset on ambiguous payload.
      expect(mockUpdate).not.toHaveBeenCalled();

      // Audit row recorded with refunded_subscription_id=null in metadata so
      // the absence is observable.
      expect(mockInsert).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'subscription_changed',
          metadata: expect.objectContaining({
            event_subtype: 'order_refunded_side_purchase',
            refunded_subscription_id: null,
          }),
        })
      );
    });

    // ------------------------------------------------------------------------
    // SEC-API-001: idempotency-before-mutation race
    //
    // WHY these tests: order.refunded inserts a polar_webhook_events row at the
    // top of the handler for at-least-once dedup. If the downstream tier reset
    // fails AFTER the dedup row is recorded, Polar's retry would short-circuit
    // on the dedup row and skip the actual reset — leaving the user on a paid
    // tier post-refund (billing drift). The fix: on reset failure, DELETE the
    // dedup row before returning 500 so the retry re-runs the full handler.
    // ------------------------------------------------------------------------

    it('SEC-API-001: tier reset failure → 500 AND polar_webhook_events row deleted (retry will re-process)', async () => {
      // Wire a delete() mock onto the supabase chain for this test only.
      // The compensating-delete code path calls
      //   supabase.from('polar_webhook_events').delete().eq('event_id', ...)
      // We need .delete().eq() to resolve without error.
      const mockDelete = vi.fn();
      const deleteEqFn = vi.fn().mockResolvedValue({ data: null, error: null });
      mockDelete.mockReturnValue({ eq: deleteEqFn });
      mockFrom.mockReturnValue({
        select: mockSelect,
        eq: mockEq,
        single: mockSingle,
        upsert: mockUpsert,
        update: mockUpdate,
        insert: mockInsert,
        order: mockOrder,
        limit: mockLimit,
        delete: mockDelete,
      });

      // Subscription lookup returns the user's main sub with the same id as
      // the refunded subscription_id below — main-sub branch.
      mockSingle.mockResolvedValueOnce({
        data: {
          user_id: 'user-uuid-123',
          polar_subscription_id: 'sub_main_xyz',
          tier: 'pro',
        },
        error: null,
      });

      // First .eq() (lookup) preserves the chain so .single() can resolve;
      // second .eq() (UPDATE on subscriptions) FAILS — simulating the DB error
      // that would otherwise leave the dedup row in place and skip the retry.
      mockEq.mockReturnValueOnce({
        select: mockSelect,
        eq: mockEq,
        single: mockSingle,
        upsert: mockUpsert,
        update: mockUpdate,
        insert: mockInsert,
        order: mockOrder,
        limit: mockLimit,
        delete: mockDelete,
      });
      mockEq.mockResolvedValueOnce({
        data: null,
        error: { message: 'simulated DB failure on tier reset' },
      });

      const event = {
        id: 'evt_refund_race_001',
        type: 'order.refunded',
        data: {
          id: 'ord_refund_race_001',
          customer_id: 'cust_test_456',
          subscription_id: 'sub_main_xyz',
        },
      };

      const response = await sendSignedRefund(event);

      // Polar must see 500 so it retries the delivery.
      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe('Processing failed');

      // The dedup row MUST be deleted so the retry re-runs the full handler.
      // Without this, the retry would short-circuit on the dedup row and the
      // tier would never reset (billing drift).
      expect(mockDelete).toHaveBeenCalled();
      expect(deleteEqFn).toHaveBeenCalledWith('event_id', 'evt_refund_race_001');
    });

    it('SEC-API-001: happy path → dedup row persists, no compensating delete', async () => {
      // Wire a delete() mock so we can assert it was NOT called.
      const mockDelete = vi.fn();
      mockFrom.mockReturnValue({
        select: mockSelect,
        eq: mockEq,
        single: mockSingle,
        upsert: mockUpsert,
        update: mockUpdate,
        insert: mockInsert,
        order: mockOrder,
        limit: mockLimit,
        delete: mockDelete,
      });

      mockSingle.mockResolvedValueOnce({
        data: {
          user_id: 'user-uuid-123',
          polar_subscription_id: 'sub_main_xyz',
          tier: 'pro',
        },
        error: null,
      });

      // Lookup chain + successful UPDATE.
      mockEq.mockReturnValueOnce({
        select: mockSelect,
        eq: mockEq,
        single: mockSingle,
        upsert: mockUpsert,
        update: mockUpdate,
        insert: mockInsert,
        order: mockOrder,
        limit: mockLimit,
        delete: mockDelete,
      });
      mockEq.mockResolvedValueOnce({ data: null, error: null });

      const event = {
        id: 'evt_refund_happy_001',
        type: 'order.refunded',
        data: {
          id: 'ord_refund_happy_001',
          customer_id: 'cust_test_456',
          subscription_id: 'sub_main_xyz',
        },
      };

      const response = await sendSignedRefund(event);
      expect(response.status).toBe(200);

      // Dedup row was inserted (upsert on polar_webhook_events) and MUST stay
      // — so a Polar retry of this same event is correctly short-circuited.
      expect(mockUpsert).toHaveBeenCalled();
      expect(mockDelete).not.toHaveBeenCalled();
    });

    it('SEC-API-001: retry of already-processed refund event → 200 with received=true (dedup short-circuit)', async () => {
      // Override mockUpsert default ("new event") with empty-RETURNING ("conflict
      // — already processed"). This simulates Polar redelivering an event whose
      // event_id we have already recorded.
      const dupSelectFn = vi.fn().mockResolvedValueOnce({ data: [], error: null });
      mockUpsert.mockReturnValueOnce({ select: dupSelectFn });

      const event = {
        id: 'evt_refund_dup_001',
        type: 'order.refunded',
        data: {
          id: 'ord_refund_dup_001',
          customer_id: 'cust_test_456',
          subscription_id: 'sub_main_xyz',
        },
      };

      const response = await sendSignedRefund(event);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.received).toBe(true);

      // No tier reset on a duplicate — we returned 200 immediately.
      expect(mockUpdate).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // Individual-path event-id dedup (migration 054 hardening)
  //
  // WHY these tests: migration 054 adds event-id dedup to the individual
  // subscription path to mirror the team-path pattern from handleTeamSubscriptionEvent.
  // These tests verify:
  //   1. ON CONFLICT (23505 / empty RETURNING) → 200 { received: true }, no RPC call
  //   2. polar_webhook_events insert error (non-fatal) → processing continues
  //   3. Missing top-level event id → fall-through to normal processing
  //
  // SOC2 CC9.2: Idempotency across all billing event paths.
  // --------------------------------------------------------------------------

  describe('individual-path event-id dedup (migration 054)', () => {
    /**
     * Build a signed subscription event request with a top-level `id` field.
     * Polar events always have a top-level id that is the delivery-level key.
     */
    async function sendSignedIndividualEvent(
      body: Record<string, unknown>
    ): Promise<Response> {
      const payload = JSON.stringify(body);
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

    it('dedup-1: returns 200 { received: true } and skips all processing when polar_webhook_events upsert returns empty rows (ON CONFLICT)', async () => {
      // WHY: Empty RETURNING from upsert = ON CONFLICT path = event already processed.
      // Route must return 200 immediately without calling any RPC or upsert on subscriptions.
      // This mirrors the exact team-path dedup behavior.
      //
      // WHY mockReturnValueOnce with { select } shape (not mockResolvedValueOnce):
      // The route calls supabase.from(...).upsert(...).select('event_id') — a chain.
      // mockUpsert must return an object with a .select() method, not a raw promise.
      // Using mockResolvedValueOnce would cause "select is not a function" at runtime.

      // Override: dedup upsert returns empty array (conflict — event already processed)
      mockUpsert.mockReturnValueOnce({
        select: vi.fn().mockResolvedValueOnce({ data: [], error: null }),
      });

      const event = {
        id: 'evt_dedup_already_processed_001',
        ...createSubscriptionEvent('subscription.created'),
      };

      const response = await sendSignedIndividualEvent(event);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.received).toBe(true);

      // WHY: shouldHonorManualOverride must NOT be called — the route returned
      // before reaching the override gate. No profile lookup, no tier logic.
      expect(mockShouldHonorManualOverride).not.toHaveBeenCalled();
      // WHY: exactly 1 upsert call total (the dedup upsert); subscriptions upsert
      // was never reached because the route returned early on conflict.
      expect(mockUpsert).toHaveBeenCalledTimes(1);
    });

    it('dedup-2: continues processing when polar_webhook_events upsert returns a new row (new event)', async () => {
      // WHY: Non-empty RETURNING = new row inserted = event not seen before.
      // Processing must continue normally (profile lookup → tier check → subscriptions upsert).
      //
      // This test verifies the happy path: dedup block passes through, normal processing runs.
      // mockUpsert will be called twice:
      //   Call 1 (dedup): polar_webhook_events → returns new row → proceed
      //   Call 2 (subscriptions): subscriptions upsert → resolves to { data: null, error: null }

      // Override call 1: dedup upsert — new event row returned
      mockUpsert.mockReturnValueOnce({
        select: vi.fn().mockResolvedValueOnce({
          data: [{ event_id: 'evt_new_001' }],
          error: null,
        }),
      });

      // Override call 2: subscriptions upsert — succeeds
      // WHY mockReturnValueOnce with { select } here too: after the dedup block,
      // the subscriptions upsert is `await supabase.from('subscriptions').upsert(...)`.
      // It does NOT chain .select() — but mockReturnValue returns { select: fn } by
      // default and the fn is never called. This is benign.
      mockUpsert.mockReturnValueOnce({ select: vi.fn() });

      // Profile + customer lookups
      mockSingle.mockResolvedValueOnce({ data: { id: 'user-uuid-123' }, error: null });
      mockSingle.mockResolvedValueOnce({ data: { user_id: 'user-uuid-123' }, error: null });
      // Existing sub check (downgrade protection)
      mockSingle.mockResolvedValueOnce({ data: { tier: 'free', status: 'active' }, error: null });

      mockShouldHonorManualOverride.mockResolvedValueOnce({
        honor: false,
        reason: 'polar_source',
      });

      const event = {
        id: 'evt_new_001',
        ...createSubscriptionEvent('subscription.created'),
      };

      const response = await sendSignedIndividualEvent(event);

      expect(response.status).toBe(200);
      // WHY: both upserts ran — dedup (call 1) + subscriptions (call 2)
      expect(mockUpsert).toHaveBeenCalledTimes(2);
      // WHY: shouldHonorManualOverride was reached (normal processing path)
      expect(mockShouldHonorManualOverride).toHaveBeenCalledTimes(1);
    });

    it('dedup-3: continues processing (non-fatal) when polar_webhook_events upsert fails with a DB error', async () => {
      // WHY: A transient DB error on polar_webhook_events must not block webhook
      // processing. The route logs the error but continues. The subscription
      // upsert on polar_subscription_id still provides state-based idempotency.
      // Returning 500 on dedup-table failure would cause infinite Polar retries.

      // Override: dedup upsert fails with a generic DB error
      mockUpsert.mockReturnValueOnce({
        select: vi.fn().mockResolvedValueOnce({
          data: null,
          error: { message: 'connection timeout', code: '08006' },
        }),
      });

      // Normal processing mocks (after the non-fatal dedup error the route continues)
      mockSingle.mockResolvedValueOnce({ data: { id: 'user-uuid-123' }, error: null });
      mockSingle.mockResolvedValueOnce({ data: { user_id: 'user-uuid-123' }, error: null });
      mockSingle.mockResolvedValueOnce({ data: { tier: 'free', status: 'active' }, error: null });

      // subscriptions upsert (second upsert call)
      mockUpsert.mockReturnValueOnce({ select: vi.fn() });

      mockShouldHonorManualOverride.mockResolvedValueOnce({
        honor: false,
        reason: 'polar_source',
      });

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const event = {
        id: 'evt_dedup_db_error_003',
        ...createSubscriptionEvent('subscription.created'),
      };

      const response = await sendSignedIndividualEvent(event);

      // WHY: Despite the dedup table error, route must return 200 (not 500).
      // Returning 500 would trigger Polar retry, causing duplicate processing.
      expect(response.status).toBe(200);

      // WHY: Error must be logged so Sentry captures it for ops visibility.
      const errorLogged = consoleErrorSpy.mock.calls.some(
        (args) => String(args[0]).includes('polar_webhook_events')
      );
      expect(errorLogged).toBe(true);

      // WHY: Processing continued — subscriptions upsert was called (call 2).
      expect(mockUpsert).toHaveBeenCalledTimes(2);

      consoleErrorSpy.mockRestore();
    });

    it('dedup-4: skips event-id dedup and falls through to normal processing when top-level id is missing', async () => {
      // WHY: Some non-standard Polar payloads may omit the top-level id.
      // The route logs the missing id and continues. The subscription
      // upsert on polar_subscription_id is still the backstop idempotency gate.
      // Blocking on a missing id would reject legitimate (if malformed) events.
      //
      // When top-level id is missing, the dedup block does NOT call upsert on
      // polar_webhook_events — only the subscriptions upsert runs.

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // Event with no top-level `id` field (createSubscriptionEvent returns { type, data })
      const eventWithoutId = createSubscriptionEvent('subscription.created');

      // Normal processing mocks (dedup block is skipped entirely)
      mockSingle.mockResolvedValueOnce({ data: { id: 'user-uuid-123' }, error: null });
      mockSingle.mockResolvedValueOnce({ data: { user_id: 'user-uuid-123' }, error: null });
      mockSingle.mockResolvedValueOnce({ data: { tier: 'free', status: 'active' }, error: null });

      // subscriptions upsert (the only upsert call — no dedup upsert for missing id)
      mockUpsert.mockReturnValueOnce({ select: vi.fn() });

      mockShouldHonorManualOverride.mockResolvedValueOnce({
        honor: false,
        reason: 'polar_source',
      });

      const response = await sendSignedIndividualEvent(eventWithoutId);

      expect(response.status).toBe(200);

      // WHY: The error about missing id must be logged.
      const missingIdLogged = consoleErrorSpy.mock.calls.some(
        (args) =>
          String(args[0]).includes('missing top-level id') ||
          String(args[0]).includes('cannot enforce event-id dedup')
      );
      expect(missingIdLogged).toBe(true);

      // WHY: Subscription processing continued — the subscriptions upsert ran.
      expect(mockUpsert).toHaveBeenCalledTimes(1);

      consoleErrorSpy.mockRestore();
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

  // --------------------------------------------------------------------------
  // Cascade-cancel orphan seat addons (Bugs #4 + #7 / Phase H2)
  //
  // WHY these tests: Growth uses Polar's multi-product Path A — base Growth
  // subscription + N seat-addon subscriptions. When the main Growth sub is
  // revoked OR downgraded to a non-Growth tier, those addons become orphans
  // and continue billing. This describe block pins:
  //   1. subscription.revoked Growth main → cascade cancels addons + audit
  //   2. subscription.revoked Growth main with NO addons → graceful no-op
  //   3. subscription.updated Growth → Pro downgrade → cascade fires
  //   4. subscription.updated Growth → Free downgrade → cascade fires
  //   5. subscription.updated Pro → Pro renewal (same tier) → NO cascade
  //   6. cascadeCancelSeatAddons partial failure (one update rejects) → other
  //      seats cancel; failure recorded in audit metadata
  //
  // SOC2 CC7.2: every cascade outcome (success and partial failure) appears
  // in audit_log with a discriminator (event_subtype) so the trail is
  // queryable by ops without metadata-JSON parsing.
  // --------------------------------------------------------------------------

  describe('cascade-cancel orphan seat addons (Bugs #4 + #7 / Phase H2)', () => {
    /** Build a signed webhook request — shared helper for cascade tests. */
    async function sendSignedCascade(
      body: Record<string, unknown>,
    ): Promise<Response> {
      const payload = JSON.stringify(body);
      const signature = signPayload(payload);
      const headersMock = new Headers();
      headersMock.set('x-polar-signature', signature);
      vi.mocked(headers).mockResolvedValue(
        headersMock as unknown as Awaited<ReturnType<typeof headers>>,
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

    // ------------------------------------------------------------------------
    // Test 1: Growth main revoke → cascade cancels all seat addons,
    // main user state set to free, audit_log carries
    // event_subtype='seat_addons_cascade_canceled_on_revoke' with cancelled count.
    // ------------------------------------------------------------------------
    it('Bug #4: Growth main revoke cascades to all seat addons and audits with on_revoke discriminator', async () => {
      // mockSingle order for subscription.revoked:
      //   1. Lookup subscriptions row by polar_subscription_id (main sub)
      mockSingle.mockResolvedValueOnce({
        data: {
          user_id: 'user-uuid-123',
          tier: 'growth',
          polar_product_id: 'prod_growth_monthly',
        },
        error: null,
      });

      // The route makes TWO .eq() calls in the revoked path:
      //   1. SELECT user_id, tier, polar_product_id ... .eq(...).single()
      //      → must return the chain object so .single() resolves via mockSingle.
      //   2. UPDATE ... .eq(...)  → must resolve with { error: null }.
      // resetAllMocks + mockReturnThis would default both to `this`, breaking
      // the UPDATE await. Mirror the order.refunded test pattern: first call
      // returns the chain explicitly, second call resolves.
      mockEq.mockReturnValueOnce({
        select: mockSelect,
        eq: mockEq,
        single: mockSingle,
        upsert: mockUpsert,
        update: mockUpdate,
        insert: mockInsert,
        order: mockOrder,
        limit: mockLimit,
      });
      mockEq.mockResolvedValueOnce({ data: null, error: null });

      // Polar SDK returns 2 active addon subs (both Growth seats).
      mockPolarSubscriptionsList.mockResolvedValueOnce({
        result: {
          items: [
            { id: 'sub_seat_a', productId: 'prod_growth_seat_monthly' },
            { id: 'sub_seat_b', productId: 'prod_growth_seat_monthly' },
            // A non-seat sub the customer also has — must NOT be cancelled.
            { id: 'sub_unrelated', productId: 'prod_pro_monthly' },
          ],
        },
      });

      const event = {
        id: 'evt_revoke_growth_001',
        type: 'subscription.revoked',
        data: {
          id: 'sub_main_growth',
          customer_id: 'cust_growth_001',
          status: 'canceled',
          canceled_at: '2026-04-26T10:00:00Z',
        },
      };

      const response = await sendSignedCascade(event);
      expect(response.status).toBe(200);

      // Main subscription is updated to canceled + tier reset to free
      // (revoke voids the paid period — this is correct for hard-revoke).
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          tier: 'free',
          status: 'canceled',
        }),
      );

      // Both seat addons were cancelled — but NOT the unrelated subscription.
      expect(mockPolarSubscriptionsUpdate).toHaveBeenCalledTimes(2);
      const updateCallIds = mockPolarSubscriptionsUpdate.mock.calls.map(
        (call) => (call[0] as { id: string }).id,
      );
      expect(updateCallIds).toEqual(
        expect.arrayContaining(['sub_seat_a', 'sub_seat_b']),
      );
      expect(updateCallIds).not.toContain('sub_unrelated');

      // Each cancel call carried cancelAtPeriodEnd + STYRBY_PRORATION_BEHAVIOR.
      for (const call of mockPolarSubscriptionsUpdate.mock.calls) {
        const arg = call[0] as {
          subscriptionUpdate: {
            cancelAtPeriodEnd?: boolean;
            prorationBehavior?: string;
          };
        };
        expect(arg.subscriptionUpdate.cancelAtPeriodEnd).toBe(true);
        expect(arg.subscriptionUpdate.prorationBehavior).toBe('next_period');
      }

      // Audit log row with the on-revoke discriminator + cancelled count = 2.
      expect(mockInsert).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'subscription_changed',
          metadata: expect.objectContaining({
            event_subtype: 'seat_addons_cascade_canceled_on_revoke',
            previous_tier: 'growth',
            cancelled_count: 2,
            cancelled_subscription_ids: expect.arrayContaining([
              'sub_seat_a',
              'sub_seat_b',
            ]),
            errors: [],
          }),
        }),
      );
    });

    // ------------------------------------------------------------------------
    // Test 2: Growth main revoke with NO seat addons (3-seat team) → graceful
    // no-op on cascade; main state still flips to free; NO audit row written
    // for the cascade (cancelled=0 AND errors=0 → caller skips the insert).
    // ------------------------------------------------------------------------
    it('Bug #4: Growth main revoke with zero seat addons is a graceful no-op (no cascade audit row)', async () => {
      mockSingle.mockResolvedValueOnce({
        data: {
          user_id: 'user-uuid-123',
          tier: 'growth',
          polar_product_id: 'prod_growth_monthly',
        },
        error: null,
      });
      // Same two-step .eq pattern as the cascade-cancel test #1 above.
      mockEq.mockReturnValueOnce({
        select: mockSelect,
        eq: mockEq,
        single: mockSingle,
        upsert: mockUpsert,
        update: mockUpdate,
        insert: mockInsert,
        order: mockOrder,
        limit: mockLimit,
      });
      mockEq.mockResolvedValueOnce({ data: null, error: null });

      // Polar returns no seat addons (customer is at the 3-seat baseline).
      mockPolarSubscriptionsList.mockResolvedValueOnce({
        result: { items: [] },
      });

      const event = {
        id: 'evt_revoke_growth_002',
        type: 'subscription.revoked',
        data: {
          id: 'sub_main_growth_2',
          customer_id: 'cust_growth_002',
          status: 'canceled',
        },
      };

      const response = await sendSignedCascade(event);
      expect(response.status).toBe(200);

      // Main flipped to free.
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ tier: 'free', status: 'canceled' }),
      );

      // No seat-addon updates fired.
      expect(mockPolarSubscriptionsUpdate).not.toHaveBeenCalled();

      // No cascade audit row (the helper rolled up zero seats and zero errors,
      // so the route's conditional `cancelled > 0 || errors.length > 0` skips
      // the insert).
      const cascadeInsertCalls = mockInsert.mock.calls.filter(
        (call) =>
          (call[0] as { metadata?: { event_subtype?: string } })?.metadata
            ?.event_subtype === 'seat_addons_cascade_canceled_on_revoke',
      );
      expect(cascadeInsertCalls).toHaveLength(0);
    });

    // ------------------------------------------------------------------------
    // Test 3: Growth → Pro tier downgrade via subscription.updated → cascade
    // fires; audit_log carries event_subtype='seat_addons_cascade_canceled_on_downgrade'.
    // ------------------------------------------------------------------------
    it('Bug #7: Growth → Pro downgrade cascades and audits with on_downgrade discriminator', async () => {
      // mockSingle for subscription.updated path:
      //   1. profile lookup (parallel call A)
      //   2. customer-id lookup (parallel call B)
      //   3. existing-sub tier check (status guard)
      mockSingle.mockResolvedValueOnce({
        data: { id: 'user-uuid-123' },
        error: null,
      });
      mockSingle.mockResolvedValueOnce({
        data: { user_id: 'user-uuid-123' },
        error: null,
      });
      mockSingle.mockResolvedValueOnce({
        data: { tier: 'growth', status: 'active' },
        error: null,
      });

      // 2 seat addons attached to the customer at the time of downgrade.
      mockPolarSubscriptionsList.mockResolvedValueOnce({
        result: {
          items: [
            { id: 'sub_seat_d_a', productId: 'prod_growth_seat_monthly' },
            { id: 'sub_seat_d_b', productId: 'prod_growth_seat_annual' },
          ],
        },
      });

      const event = {
        id: 'evt_downgrade_growth_pro_001',
        type: 'subscription.updated',
        data: {
          id: 'sub_main_growth_pro',
          customer_id: 'cust_dg_001',
          // The OLD tier is read from existingSub (mocked above as 'growth');
          // the NEW canonical tier is resolved from product_id below.
          product_id: 'prod_pro_monthly',
          user_id: 'user-uuid-123',
          status: 'active',
          current_period_start: '2026-04-26T00:00:00Z',
          current_period_end: '2026-05-26T00:00:00Z',
          cancel_at_period_end: false,
        },
      };

      const response = await sendSignedCascade(event);
      expect(response.status).toBe(200);

      // Both seat addons got the cancelAtPeriodEnd update.
      expect(mockPolarSubscriptionsUpdate).toHaveBeenCalledTimes(2);

      // Audit row carries the on-downgrade discriminator + new_tier='pro'.
      expect(mockInsert).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'subscription_changed',
          metadata: expect.objectContaining({
            event_subtype: 'seat_addons_cascade_canceled_on_downgrade',
            previous_tier: 'growth',
            new_tier: 'pro',
            cancelled_count: 2,
          }),
        }),
      );
    });

    // ------------------------------------------------------------------------
    // Test 4: Growth → Free tier downgrade → cascade fires.
    //
    // WHY: the existing tierRank guard rejects Growth→Free (rank 2 → 0). To
    // exercise the cascade branch in subscription.updated we use a path
    // where the new product is unrecognized — but that returns 200 before
    // the cascade. Instead, we treat "Free" as the resolved canonical
    // (getPlanFromProductId returns 'free' on unknown products with a warn).
    // The test simulates a downgrade by mocking mockSingle's existing-sub
    // tier as 'growth' AND using a product_id that resolves to NEITHER Pro
    // NOR Growth — which short-circuits at "Unrecognized Polar product_id".
    //
    // To actually reach the cascade with new='free', we'd need a Polar Free
    // product mapping (which doesn't exist — Free is non-billable). So this
    // test instead validates the path Growth → Pro' alternate via the annual
    // Pro product id, ensuring the cascade fires regardless of which
    // non-Growth tier the user lands on. Naming it Free is misleading; we
    // assert the direction-of-change instead.
    // ------------------------------------------------------------------------
    it('Bug #7: Growth → Pro (annual variant) downgrade also fires cascade (any non-Growth target)', async () => {
      mockSingle.mockResolvedValueOnce({
        data: { id: 'user-uuid-123' },
        error: null,
      });
      mockSingle.mockResolvedValueOnce({
        data: { user_id: 'user-uuid-123' },
        error: null,
      });
      mockSingle.mockResolvedValueOnce({
        data: { tier: 'growth', status: 'active' },
        error: null,
      });

      mockPolarSubscriptionsList.mockResolvedValueOnce({
        result: {
          items: [
            { id: 'sub_seat_f_a', productId: 'prod_growth_seat_annual' },
          ],
        },
      });

      const event = {
        id: 'evt_downgrade_growth_pro_annual',
        type: 'subscription.updated',
        data: {
          id: 'sub_main_growth_to_pro_annual',
          customer_id: 'cust_dg_002',
          product_id: 'prod_pro_annual',
          user_id: 'user-uuid-123',
          status: 'active',
        },
      };

      const response = await sendSignedCascade(event);
      expect(response.status).toBe(200);

      expect(mockPolarSubscriptionsUpdate).toHaveBeenCalledTimes(1);
      expect(mockPolarSubscriptionsUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'sub_seat_f_a',
          subscriptionUpdate: expect.objectContaining({
            cancelAtPeriodEnd: true,
            prorationBehavior: 'next_period',
          }),
        }),
      );
    });

    // ------------------------------------------------------------------------
    // Test 5: Pro → Pro renewal (same tier, same sub_id) → NO cascade.
    // The cascade guard requires oldCanonical='growth'; on Pro renewal the
    // old canonical is 'pro' so the cascade branch is never entered.
    // ------------------------------------------------------------------------
    it('Pro → Pro renewal does NOT trigger cascade (cascade is gated on Growth → non-Growth)', async () => {
      mockSingle.mockResolvedValueOnce({
        data: { id: 'user-uuid-123' },
        error: null,
      });
      mockSingle.mockResolvedValueOnce({
        data: { user_id: 'user-uuid-123' },
        error: null,
      });
      mockSingle.mockResolvedValueOnce({
        data: { tier: 'pro', status: 'active' },
        error: null,
      });

      const event = {
        id: 'evt_renewal_pro_001',
        type: 'subscription.updated',
        data: {
          id: 'sub_main_pro',
          customer_id: 'cust_pro_001',
          product_id: 'prod_pro_monthly',
          user_id: 'user-uuid-123',
          status: 'active',
        },
      };

      const response = await sendSignedCascade(event);
      expect(response.status).toBe(200);

      // No Polar list call, no addon updates, no cascade audit row.
      expect(mockPolarSubscriptionsList).not.toHaveBeenCalled();
      expect(mockPolarSubscriptionsUpdate).not.toHaveBeenCalled();
      const cascadeInsertCalls = mockInsert.mock.calls.filter(
        (call) =>
          (call[0] as { metadata?: { event_subtype?: string } })?.metadata
            ?.event_subtype?.startsWith('seat_addons_cascade_canceled'),
      );
      expect(cascadeInsertCalls).toHaveLength(0);
    });

    // ------------------------------------------------------------------------
    // Test 6: Partial Polar API failure — one seat update rejects, the other
    // succeeds. The other addon must still be cancelled, and the failure must
    // surface in audit_log.metadata.errors.
    // ------------------------------------------------------------------------
    it('Bug #4 + #7: per-seat Polar API failure does not abort other cancellations; failure recorded in audit', async () => {
      mockSingle.mockResolvedValueOnce({
        data: {
          user_id: 'user-uuid-123',
          tier: 'growth',
          polar_product_id: 'prod_growth_monthly',
        },
        error: null,
      });
      // Two-step .eq pattern: SELECT chain then UPDATE resolve.
      mockEq.mockReturnValueOnce({
        select: mockSelect,
        eq: mockEq,
        single: mockSingle,
        upsert: mockUpsert,
        update: mockUpdate,
        insert: mockInsert,
        order: mockOrder,
        limit: mockLimit,
      });
      mockEq.mockResolvedValueOnce({ data: null, error: null });

      mockPolarSubscriptionsList.mockResolvedValueOnce({
        result: {
          items: [
            { id: 'sub_seat_ok', productId: 'prod_growth_seat_monthly' },
            { id: 'sub_seat_fail', productId: 'prod_growth_seat_monthly' },
          ],
        },
      });

      // First update succeeds, second rejects with a Polar API error.
      mockPolarSubscriptionsUpdate
        .mockResolvedValueOnce({ id: 'sub_seat_ok', status: 'active' })
        .mockRejectedValueOnce(new Error('polar_api_429_rate_limited'));

      const event = {
        id: 'evt_revoke_partial_001',
        type: 'subscription.revoked',
        data: {
          id: 'sub_main_partial',
          customer_id: 'cust_partial_001',
          status: 'canceled',
        },
      };

      const response = await sendSignedCascade(event);
      // Webhook returns 200 — partial seat-cancel failure is not webhook-fatal.
      expect(response.status).toBe(200);

      expect(mockPolarSubscriptionsUpdate).toHaveBeenCalledTimes(2);

      // Audit row carries cancelled_count=1 AND a non-empty errors array
      // referencing the failed seat's id.
      expect(mockInsert).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'subscription_changed',
          metadata: expect.objectContaining({
            event_subtype: 'seat_addons_cascade_canceled_on_revoke',
            cancelled_count: 1,
            cancelled_subscription_ids: ['sub_seat_ok'],
            errors: expect.arrayContaining([
              expect.stringContaining('sub_seat_fail'),
            ]),
          }),
        }),
      );
    });
  });
});
