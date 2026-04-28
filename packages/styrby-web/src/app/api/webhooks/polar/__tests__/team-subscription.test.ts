/**
 * Integration Tests: Team Subscription Webhook Handler (Phase 2.6, Unit B)
 *
 * Tests the POST /api/webhooks/polar endpoint for team-tier subscription
 * events — events where `subscription.metadata.team_id` is present.
 *
 * WHY these tests matter: The team webhook handler is the only entry point for
 * team billing state changes. Bugs here can silently grant unlimited access,
 * fail to enter grace periods, or cause duplicate seat-cap updates on Polar
 * retries. Every code path must be exercised before this ships.
 *
 * Test coverage:
 * - Signature verification (missing, invalid, valid)
 * - Idempotency (same event_id delivered twice)
 * - subscription.updated: seat upgrade (3→5), seat downgrade (10→5)
 * - subscription.canceled: billing_status + grace_period_ends_at
 * - subscription.past_due: billing_status + grace_period_ends_at (3-day)
 * - Malformed payload → 400
 * - Unknown product_id → 422 + audit_log entry
 * - validateSeatCount fail (below tier minimum) → 422 + audit_log entry
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';

// ============================================================================
// Mocks — declared before imports to ensure vi.mock hoisting works
// ============================================================================

/**
 * Supabase mock — tracks all calls so tests can assert DB writes.
 * The mock chain must be re-configured per test because supabase-js
 * chains are stateful (.from().upsert().select() all share state).
 */
const mockUpsert = vi.fn();
const mockUpdate = vi.fn();
const mockInsert = vi.fn();
const mockSelect = vi.fn();
const mockEq = vi.fn();
const mockSingle = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: vi.fn(() => ({
    from: vi.fn((table: string) => {
      return {
        upsert: mockUpsert,
        update: mockUpdate,
        insert: mockInsert,
        select: mockSelect,
        eq: mockEq,
        single: mockSingle,
      };
    }),
  })),
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(),
}));

// ============================================================================
// Import under test (after mocks)
// ============================================================================

import { POST } from '../route';
import { headers } from 'next/headers';

// ============================================================================
// Test Helpers
// ============================================================================

const WEBHOOK_SECRET = 'test-webhook-secret-unit-b-12345';

/**
 * Signs a payload string with the test webhook secret.
 * Mirrors the HMAC-SHA256 verification in polar-webhook-signature.ts.
 */
function signPayload(payload: string): string {
  return crypto.createHmac('sha256', WEBHOOK_SECRET).update(payload).digest('hex');
}

/**
 * Creates a signed Polar webhook request for a team subscription event.
 *
 * @param body - The event payload object.
 * @param options.signature - Override the signature (for invalid-sig tests).
 * @param options.ip - Source IP (for rate-limit tests).
 */
function createTeamWebhookRequest(
  body: Record<string, unknown>,
  options?: { signature?: string; ip?: string }
): Request {
  const payload = JSON.stringify(body);
  const signature = options?.signature ?? signPayload(payload);
  const ip = options?.ip ?? '10.0.0.1';

  // Build a bare Request — headers() is mocked separately (Next.js pattern).
  const req = new Request('http://localhost:3000/api/webhooks/polar', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-forwarded-for': ip,
    },
    body: payload,
  });

  // Mock next/headers to return our signature.
  // WHY mocked separately: Next.js `headers()` is an async server function that
  // cannot be set on the Request object directly in test environments.
  vi.mocked(headers).mockResolvedValue(
    (() => {
      const h = new Headers();
      h.set('x-polar-signature', signature);
      return h as unknown as Awaited<ReturnType<typeof headers>>;
    })()
  );

  return req;
}

/**
 * Builds a standard team subscription.updated event payload.
 *
 * @param overrides - Merge into the subscription data object.
 */
function makeTeamUpdatedEvent(overrides?: Record<string, unknown>) {
  return {
    id: 'evt_team_001',
    type: 'subscription.updated',
    data: {
      id: 'sub_team_abc123',
      status: 'active',
      quantity: 5,
      metadata: { team_id: '00000000-0000-4000-a000-000000000999' },
      prices: [{ product_id: 'prod_team_monthly' }],
      current_period_start: '2026-04-01T00:00:00Z',
      current_period_end: '2026-05-01T00:00:00Z',
      ...overrides,
    },
  };
}

/**
 * Configures the default happy-path mock chain for a team subscription.updated event:
 *
 * Call order in handleTeamSubscriptionEvent:
 * 1. from('polar_webhook_events').upsert(...).select('event_id') → [{ event_id }]
 * 2. from('teams').select(...).eq(...).single() → { seat_cap: N }
 * 3. from('teams').update({...}).eq(...) → { data: null, error: null }
 * 4. from('audit_log').insert([...]) → { data: null, error: null }
 *
 * WHY this mock structure: supabase-js chains methods, so each call must
 * return an object that has the next method in the chain. The shared mocks
 * (mockUpsert, mockSelect, mockUpdate, mockInsert) map directly to the
 * first method called after from().
 *
 * @param currentSeatCap - The seat_cap value already in the teams table (before the event).
 */
function setupDefaultTeamMocks(currentSeatCap = 3) {
  // Step 1: Idempotency — from('polar_webhook_events').upsert({...}, opts).select('event_id')
  // The upsert returns an object with its own `select` (independent of mockSelect).
  mockUpsert.mockReturnValueOnce({
    select: vi.fn().mockResolvedValueOnce({
      data: [{ event_id: 'evt_team_001' }], // non-empty → new event, proceed
      error: null,
    }),
  });

  // Step 2: Read current seat_cap — from('teams').select('seat_cap,...').eq('id', teamId).single()
  // The from() mock returns { select: mockSelect, ... }. mockSelect is called with the
  // column string and must return an object with an `eq` method.
  mockSelect.mockReturnValueOnce({
    eq: vi.fn().mockReturnValueOnce({
      single: vi.fn().mockResolvedValueOnce({
        data: { seat_cap: currentSeatCap, billing_tier: 'team', billing_status: 'active' },
        error: null,
      }),
    }),
  });

  // Step 3: Update teams — from('teams').update({...}).eq('id', teamId)
  // mockUpdate is called with the update object and must return an object with `eq`.
  mockUpdate.mockReturnValueOnce({
    eq: vi.fn().mockResolvedValueOnce({ data: null, error: null }),
  });

  // Step 4: Audit log — from('audit_log').insert([...])
  // mockInsert is called with the rows array; resolves to { data: null, error: null }.
  mockInsert.mockResolvedValueOnce({ data: null, error: null });
}

// ============================================================================
// Environment setup
// ============================================================================

beforeEach(() => {
  vi.clearAllMocks();

  // Required env vars for the webhook handler
  vi.stubEnv('POLAR_WEBHOOK_SECRET', WEBHOOK_SECRET);
  vi.stubEnv('POLAR_ACCESS_TOKEN', 'test-access-token');
  vi.stubEnv('POLAR_TEAM_MONTHLY_PRODUCT_ID', 'prod_team_monthly');
  vi.stubEnv('POLAR_TEAM_ANNUAL_PRODUCT_ID', 'prod_team_annual');
  vi.stubEnv('POLAR_BUSINESS_MONTHLY_PRODUCT_ID', 'prod_business_monthly');
  vi.stubEnv('POLAR_BUSINESS_ANNUAL_PRODUCT_ID', 'prod_business_annual');

  // Also set individual-tier vars so the existing solo handler stays happy
  vi.stubEnv('POLAR_PRO_MONTHLY_PRODUCT_ID', 'prod_pro_monthly');
  vi.stubEnv('POLAR_PRO_ANNUAL_PRODUCT_ID', 'prod_pro_annual');
  vi.stubEnv('POLAR_POWER_MONTHLY_PRODUCT_ID', 'prod_power_monthly');
  vi.stubEnv('POLAR_POWER_ANNUAL_PRODUCT_ID', 'prod_power_annual');

  // Default headers mock (overridden per test by createTeamWebhookRequest)
  vi.mocked(headers).mockResolvedValue(
    new Headers() as unknown as Awaited<ReturnType<typeof headers>>
  );
});

// ============================================================================
// Tests
// ============================================================================

describe('POST /api/webhooks/polar — team subscription events', () => {

  // --------------------------------------------------------------------------
  // Signature verification
  // --------------------------------------------------------------------------

  describe('signature verification', () => {
    it('returns 401 when polar-signature header is missing', async () => {
      const event = makeTeamUpdatedEvent();
      const payload = JSON.stringify(event);

      // Return headers with NO signature
      vi.mocked(headers).mockResolvedValue(
        new Headers() as unknown as Awaited<ReturnType<typeof headers>>
      );

      const req = new Request('http://localhost:3000/api/webhooks/polar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '10.0.0.1' },
        body: payload,
      });

      const res = await POST(req);
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe('Invalid signature');
    });

    it('returns 401 when polar-signature is present but incorrect', async () => {
      const event = makeTeamUpdatedEvent();
      const payload = JSON.stringify(event);

      // WHY 64-char sig: SHA-256 hex digest is always 64 chars. The length pre-check
      // in verifyPolarSignature short-circuits before timingSafeEqual when lengths
      // differ, but to exercise the full comparison path we match the length.
      const wrongSig = 'b'.repeat(64);
      vi.mocked(headers).mockResolvedValue(
        (() => {
          const h = new Headers();
          h.set('x-polar-signature', wrongSig);
          return h as unknown as Awaited<ReturnType<typeof headers>>;
        })()
      );

      const req = new Request('http://localhost:3000/api/webhooks/polar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '10.0.0.1' },
        body: payload,
      });

      const res = await POST(req);
      expect(res.status).toBe(401);
    });

    it('returns 200 when polar-signature is valid', async () => {
      setupDefaultTeamMocks();
      const event = makeTeamUpdatedEvent();
      const req = createTeamWebhookRequest(event);

      const res = await POST(req);
      expect(res.status).toBe(200);
    });
  });

  // --------------------------------------------------------------------------
  // Idempotency
  // --------------------------------------------------------------------------

  describe('idempotency', () => {
    it('processes the event only once when the same event_id is delivered twice', async () => {
      // WHY two separate sendSignedEvent calls: we need to verify that Polar
      // retrying the same event_id results in only one database update, not two.
      // The first call inserts into polar_webhook_events (row returned).
      // The second call hits ON CONFLICT DO NOTHING (no rows returned) → 200, no update.

      // First delivery: idempotency upsert → new row (non-empty RETURNING)
      mockUpsert.mockReturnValueOnce({
        select: vi.fn().mockResolvedValueOnce({
          data: [{ event_id: 'evt_team_001' }], // new event — proceed with processing
          error: null,
        }),
      });
      // teams.select → current seat_cap = 3
      mockSelect.mockReturnValueOnce({
        eq: vi.fn().mockReturnValueOnce({
          single: vi.fn().mockResolvedValueOnce({
            data: { seat_cap: 3, billing_tier: 'team', billing_status: 'active' },
            error: null,
          }),
        }),
      });
      // teams.update → success
      mockUpdate.mockReturnValueOnce({
        eq: vi.fn().mockResolvedValueOnce({ data: null, error: null }),
      });
      // audit_log.insert → success
      mockInsert.mockResolvedValueOnce({ data: null, error: null });

      const event = makeTeamUpdatedEvent({ quantity: 5 });
      const req1 = createTeamWebhookRequest(event);
      const res1 = await POST(req1);
      expect(res1.status).toBe(200);
      expect(mockUpdate).toHaveBeenCalledTimes(1);

      // Second delivery: idempotency upsert → empty array (ON CONFLICT DO NOTHING)
      // WHY queue this BEFORE clearing: we want the second POST to see this value.
      // We do NOT call vi.clearAllMocks() here — that would bleed into subsequent tests.
      // Instead we just queue the next return value for mockUpsert.
      mockUpsert.mockReturnValueOnce({
        select: vi.fn().mockResolvedValueOnce({
          data: [], // conflict — already processed, return 200 immediately
          error: null,
        }),
      });

      const req2 = createTeamWebhookRequest(event);
      const res2 = await POST(req2);
      expect(res2.status).toBe(200);

      // WHY toHaveBeenCalledTimes(1) not (0): the first POST called update once.
      // The second POST should NOT have called update again. The total stays at 1.
      expect(mockUpdate).toHaveBeenCalledTimes(1);
    });
  });

  // --------------------------------------------------------------------------
  // subscription.updated — seat changes
  // --------------------------------------------------------------------------

  describe('subscription.updated', () => {
    it('upgrades seat_cap from 3 to 5 and writes audit rows for increase', async () => {
      setupDefaultTeamMocks(3); // currentSeatCap = 3

      const event = makeTeamUpdatedEvent({ quantity: 5 });
      const req = createTeamWebhookRequest(event);
      const res = await POST(req);

      // Diagnose before asserting specifics — a non-200 here means the mock
      // chain is wrong; the status tells us which path was hit.
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.received).toBe(true);

      // teams.update must have been called with new seat_cap
      expect(mockUpdate).toHaveBeenCalledTimes(1);
      const updateCall = mockUpdate.mock.calls[0][0] as Record<string, unknown>;
      expect(updateCall.seat_cap).toBe(5);
      expect(updateCall.billing_tier).toBe('team');
      expect(updateCall.billing_status).toBe('active');
      expect(updateCall.billing_cycle).toBe('monthly');

      // audit_log.insert should include seat_count_increased row
      expect(mockInsert).toHaveBeenCalledTimes(1);
      const insertCall = mockInsert.mock.calls[0][0] as Array<Record<string, unknown>>;
      const actions = insertCall.map((r) => r.action);
      expect(actions).toContain('team_subscription_updated');
      expect(actions).toContain('team_seat_count_increased');
    });

    it('downgrades seat_cap from 10 to 5 and writes audit rows for decrease', async () => {
      setupDefaultTeamMocks(10); // currentSeatCap = 10

      const event = makeTeamUpdatedEvent({ quantity: 5 });
      const req = createTeamWebhookRequest(event);
      const res = await POST(req);

      expect(res.status).toBe(200);

      const updateCall = mockUpdate.mock.calls[0][0] as Record<string, unknown>;
      expect(updateCall.seat_cap).toBe(5);

      const insertCall = mockInsert.mock.calls[0][0] as Array<Record<string, unknown>>;
      const actions = insertCall.map((r) => r.action);
      expect(actions).toContain('team_subscription_updated');
      expect(actions).toContain('team_seat_count_decreased');

      // Verify metadata includes the delta
      const decreaseRow = insertCall.find((r) => r.action === 'team_seat_count_decreased') as
        | Record<string, unknown>
        | undefined;
      expect((decreaseRow?.metadata as Record<string, unknown>)?.delta).toBe(5);
    });

    it('writes only team_subscription_updated (no seat-change row) when quantity is unchanged', async () => {
      setupDefaultTeamMocks(5); // currentSeatCap already = 5

      const event = makeTeamUpdatedEvent({ quantity: 5 });
      const req = createTeamWebhookRequest(event);
      const res = await POST(req);

      expect(res.status).toBe(200);

      const insertCall = mockInsert.mock.calls[0][0] as Array<Record<string, unknown>>;
      const actions = insertCall.map((r) => r.action);
      expect(actions).toContain('team_subscription_updated');
      expect(actions).not.toContain('team_seat_count_increased');
      expect(actions).not.toContain('team_seat_count_decreased');
    });
  });

  // --------------------------------------------------------------------------
  // subscription.canceled
  // --------------------------------------------------------------------------

  describe('subscription.canceled', () => {
    it('sets billing_status to canceled and grace_period_ends_at +7 days', async () => {
      const canceledEvent = {
        id: 'evt_cancel_001',
        type: 'subscription.canceled',
        data: {
          id: 'sub_team_abc123',
          status: 'canceled',
          quantity: 5,
          metadata: { team_id: '00000000-0000-4000-a000-000000000999' },
          prices: [{ product_id: 'prod_team_monthly' }],
          canceled_at: '2026-04-22T10:00:00Z',
        },
      };

      // Idempotency upsert — new event
      mockUpsert.mockReturnValueOnce({
        select: vi.fn().mockResolvedValueOnce({
          data: [{ event_id: 'evt_cancel_001' }],
          error: null,
        }),
      });

      // teams.update → success
      mockUpdate.mockReturnValueOnce({
        eq: vi.fn().mockResolvedValueOnce({ data: null, error: null }),
      });

      // audit_log.insert → success
      mockInsert.mockResolvedValueOnce({ data: null, error: null });

      const req = createTeamWebhookRequest(canceledEvent);
      const res = await POST(req);

      expect(res.status).toBe(200);

      // Verify the update sets billing_status = 'canceled'
      const updateCall = mockUpdate.mock.calls[0][0] as Record<string, unknown>;
      expect(updateCall.billing_status).toBe('canceled');

      // Verify grace_period_ends_at is approximately NOW + 7 days
      const gracePeriodEnd = new Date(updateCall.grace_period_ends_at as string);
      const nowPlus7d = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      // Within 5 seconds — allows for test execution time
      expect(Math.abs(gracePeriodEnd.getTime() - nowPlus7d.getTime())).toBeLessThan(5000);

      // audit_log must include both cancel + grace period rows
      const insertCall = mockInsert.mock.calls[0][0] as Array<Record<string, unknown>>;
      const actions = insertCall.map((r) => r.action);
      expect(actions).toContain('team_subscription_canceled');
      expect(actions).toContain('team_billing_grace_period_entered');
    });
  });

  // --------------------------------------------------------------------------
  // subscription.past_due
  // --------------------------------------------------------------------------

  describe('subscription.past_due', () => {
    it('sets billing_status to past_due and grace_period_ends_at +3 days', async () => {
      const pastDueEvent = {
        id: 'evt_pastdue_001',
        type: 'subscription.past_due',
        data: {
          id: 'sub_team_abc123',
          status: 'past_due',
          quantity: 5,
          metadata: { team_id: '00000000-0000-4000-a000-000000000999' },
          prices: [{ product_id: 'prod_team_monthly' }],
        },
      };

      // Idempotency upsert — new event
      mockUpsert.mockReturnValueOnce({
        select: vi.fn().mockResolvedValueOnce({
          data: [{ event_id: 'evt_pastdue_001' }],
          error: null,
        }),
      });

      // teams.update → success
      mockUpdate.mockReturnValueOnce({
        eq: vi.fn().mockResolvedValueOnce({ data: null, error: null }),
      });

      // audit_log.insert → success
      mockInsert.mockResolvedValueOnce({ data: null, error: null });

      const req = createTeamWebhookRequest(pastDueEvent);
      const res = await POST(req);

      expect(res.status).toBe(200);

      const updateCall = mockUpdate.mock.calls[0][0] as Record<string, unknown>;
      expect(updateCall.billing_status).toBe('past_due');

      // Verify grace_period_ends_at is approximately NOW + 3 days
      const gracePeriodEnd = new Date(updateCall.grace_period_ends_at as string);
      const nowPlus3d = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
      expect(Math.abs(gracePeriodEnd.getTime() - nowPlus3d.getTime())).toBeLessThan(5000);

      // audit_log must include team_billing_past_due row
      const insertCall = mockInsert.mock.calls[0][0] as Record<string, unknown>;
      expect(insertCall.action).toBe('team_billing_past_due');
    });
  });

  // --------------------------------------------------------------------------
  // Malformed payload
  // --------------------------------------------------------------------------

  describe('malformed payload', () => {
    it('returns 400 (not 500) for completely invalid JSON', async () => {
      const badPayload = '{ this is not json !!!';
      const sig = signPayload(badPayload);

      vi.mocked(headers).mockResolvedValue(
        (() => {
          const h = new Headers();
          h.set('x-polar-signature', sig);
          return h as unknown as Awaited<ReturnType<typeof headers>>;
        })()
      );

      const req = new Request('http://localhost:3000/api/webhooks/polar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '10.0.0.1' },
        body: badPayload,
      });

      const res = await POST(req);
      // WHY 400 (not 500): malformed payload is a client error (Polar bug or
      // misconfiguration). Returning 500 would cause Polar to retry indefinitely,
      // filling logs with noise. 400 signals Polar to stop retrying.
      expect(res.status).toBe(400);
    });

    it('returns 400 for payload missing the top-level type field', async () => {
      const missingType = { data: { id: 'sub_abc', metadata: { team_id: '00000000-0000-4000-a000-000000000999' } } };
      const req = createTeamWebhookRequest(missingType as Record<string, unknown>);
      const res = await POST(req);
      expect(res.status).toBe(400);
    });
  });

  // --------------------------------------------------------------------------
  // Unknown product_id → 422
  // --------------------------------------------------------------------------

  describe('unknown product_id', () => {
    it('returns 422 and writes an audit_log entry when product_id is unrecognized', async () => {
      // Idempotency upsert — new event
      mockUpsert.mockReturnValueOnce({
        select: vi.fn().mockResolvedValueOnce({
          data: [{ event_id: 'evt_unknown_prod_001' }],
          error: null,
        }),
      });

      // audit_log.insert for the unknown-product error
      mockInsert.mockResolvedValueOnce({ data: null, error: null });

      const event = {
        id: 'evt_unknown_prod_001',
        type: 'subscription.updated',
        data: {
          id: 'sub_team_abc123',
          status: 'active',
          quantity: 5,
          metadata: { team_id: '00000000-0000-4000-a000-000000000999' },
          prices: [{ product_id: 'prod_COMPLETELY_UNKNOWN' }],
          current_period_start: '2026-04-01T00:00:00Z',
          current_period_end: '2026-05-01T00:00:00Z',
        },
      };

      const req = createTeamWebhookRequest(event);
      const res = await POST(req);

      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.error).toMatch(/unknown product id/i);

      // Verify audit_log was written with error context
      expect(mockInsert).toHaveBeenCalledTimes(1);
      const auditInsert = mockInsert.mock.calls[0][0] as Record<string, unknown>;
      expect(auditInsert.action).toBe('team_subscription_updated');
      expect((auditInsert.metadata as Record<string, unknown>).error).toBe('unknown_product_id');
    });
  });

  // --------------------------------------------------------------------------
  // validateSeatCount fail → 422
  // --------------------------------------------------------------------------

  describe('seat count validation', () => {
    it('returns 422 when seat count is below tier minimum (team requires >= 3)', async () => {
      // Idempotency upsert — new event
      mockUpsert.mockReturnValueOnce({
        select: vi.fn().mockResolvedValueOnce({
          data: [{ event_id: 'evt_low_seats_001' }],
          error: null,
        }),
      });

      // audit_log.insert for the invalid seat count error
      mockInsert.mockResolvedValueOnce({ data: null, error: null });

      const event = {
        id: 'evt_low_seats_001',
        type: 'subscription.updated',
        data: {
          id: 'sub_team_abc123',
          status: 'active',
          quantity: 1, // below team minimum of 3
          metadata: { team_id: '00000000-0000-4000-a000-000000000999' },
          prices: [{ product_id: 'prod_team_monthly' }],
          current_period_start: '2026-04-01T00:00:00Z',
          current_period_end: '2026-05-01T00:00:00Z',
        },
      };

      const req = createTeamWebhookRequest(event);
      const res = await POST(req);

      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.error).toMatch(/invalid seat count/i);

      // Verify audit_log was written
      expect(mockInsert).toHaveBeenCalledTimes(1);
      const auditInsert = mockInsert.mock.calls[0][0] as Record<string, unknown>;
      expect(auditInsert.action).toBe('team_subscription_updated');
      expect((auditInsert.metadata as Record<string, unknown>).error).toBe('invalid_seat_count');
    });

    it('returns 422 when seat count is below business minimum (business requires >= 10)', async () => {
      // Idempotency upsert — new event
      mockUpsert.mockReturnValueOnce({
        select: vi.fn().mockResolvedValueOnce({
          data: [{ event_id: 'evt_biz_low_seats_001' }],
          error: null,
        }),
      });

      mockInsert.mockResolvedValueOnce({ data: null, error: null });

      const event = {
        id: 'evt_biz_low_seats_001',
        type: 'subscription.updated',
        data: {
          id: 'sub_biz_abc123',
          status: 'active',
          quantity: 5, // below business minimum of 10
          metadata: { team_id: '00000000-0000-4000-b000-000000000999' },
          prices: [{ product_id: 'prod_business_monthly' }],
          current_period_start: '2026-04-01T00:00:00Z',
          current_period_end: '2026-05-01T00:00:00Z',
        },
      };

      const req = createTeamWebhookRequest(event);
      const res = await POST(req);

      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.error).toMatch(/invalid seat count/i);
    });

    it('accepts seat count at exactly the tier minimum (team = 3)', async () => {
      setupDefaultTeamMocks(3); // same as new count → no seat-change audit row

      const event = makeTeamUpdatedEvent({ quantity: 3 }); // exactly at minimum
      const req = createTeamWebhookRequest(event);
      const res = await POST(req);

      expect(res.status).toBe(200);
    });
  });

  // --------------------------------------------------------------------------
  // Product ID mapping (Deliverable 4)
  // --------------------------------------------------------------------------

  describe('product ID mapping', () => {
    it('maps prod_team_monthly to tier=team, cycle=monthly', async () => {
      setupDefaultTeamMocks(3);
      const event = makeTeamUpdatedEvent({ prices: [{ product_id: 'prod_team_monthly' }] });
      const req = createTeamWebhookRequest(event);
      await POST(req);

      const updateCall = mockUpdate.mock.calls[0][0] as Record<string, unknown>;
      expect(updateCall.billing_tier).toBe('team');
      expect(updateCall.billing_cycle).toBe('monthly');
    });

    it('maps prod_team_annual to tier=team, cycle=annual', async () => {
      setupDefaultTeamMocks(3);
      const event = makeTeamUpdatedEvent({ prices: [{ product_id: 'prod_team_annual' }] });
      const req = createTeamWebhookRequest(event);
      await POST(req);

      const updateCall = mockUpdate.mock.calls[0][0] as Record<string, unknown>;
      expect(updateCall.billing_tier).toBe('team');
      expect(updateCall.billing_cycle).toBe('annual');
    });

    it('maps prod_business_monthly to tier=business, cycle=monthly', async () => {
      // Use business-appropriate seat count (min 10)
      setupDefaultTeamMocks(10);
      const event = {
        id: 'evt_biz_mapping',
        type: 'subscription.updated',
        data: {
          id: 'sub_biz_abc',
          status: 'active',
          quantity: 10,
          metadata: { team_id: '00000000-0000-4000-b000-000000000999' },
          prices: [{ product_id: 'prod_business_monthly' }],
          current_period_start: '2026-04-01T00:00:00Z',
          current_period_end: '2026-05-01T00:00:00Z',
        },
      };
      const req = createTeamWebhookRequest(event);
      await POST(req);

      const updateCall = mockUpdate.mock.calls[0][0] as Record<string, unknown>;
      expect(updateCall.billing_tier).toBe('business');
      expect(updateCall.billing_cycle).toBe('monthly');
    });

    it('maps prod_business_annual to tier=business, cycle=annual', async () => {
      setupDefaultTeamMocks(10);
      const event = {
        id: 'evt_biz_annual_mapping',
        type: 'subscription.updated',
        data: {
          id: 'sub_biz_annual',
          status: 'active',
          quantity: 10,
          metadata: { team_id: '00000000-0000-4000-b000-000000000999' },
          prices: [{ product_id: 'prod_business_annual' }],
          current_period_start: '2026-04-01T00:00:00Z',
          current_period_end: '2026-05-01T00:00:00Z',
        },
      };
      const req = createTeamWebhookRequest(event);
      await POST(req);

      const updateCall = mockUpdate.mock.calls[0][0] as Record<string, unknown>;
      expect(updateCall.billing_tier).toBe('business');
      expect(updateCall.billing_cycle).toBe('annual');
    });
  });
});
