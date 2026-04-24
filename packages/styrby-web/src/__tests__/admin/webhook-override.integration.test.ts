/**
 * Admin Console — Webhook Override Honor Flow Integration Tests
 *
 * Integration seam: This file exercises the Polar webhook route's manual
 * tier-override decision logic end-to-end. The seam is the
 * `shouldHonorManualOverride` function boundary (backed by the atomic
 * `apply_polar_subscription_with_override_check` RPC in production). We mock
 * the RPC response to simulate each decision branch and assert the full route
 * behaviour — including the structured log emitted and the HTTP response code.
 *
 * WHY this exists (Phase 4.1 T8 + T9):
 *   The manual override honour logic is the last enforcement point before a
 *   Polar webhook can overwrite an admin-set tier. A regression here —
 *   e.g., `shouldHonorManualOverride` not being called, or the `honor: true`
 *   branch falling through — would silently overwrite an admin override and
 *   break SOC 2 CC6.1 (admin-set controls must survive webhook replays).
 *   These integration tests verify the full route → decision → response chain.
 *
 * What phase it tests: Phase 4.1 (Admin Console — T8 webhook override + T9
 * integration coverage).
 *
 * SOC 2 CC6.1: Admin-set overrides must survive Polar webhook deliveries.
 * SOC 2 CC7.2: Expired overrides must be atomically reset with an audit row.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';

// ============================================================================
// Mocks — declared before any import of the module under test
// ============================================================================

/**
 * WHY vi.hoisted(): vi.mock() factories run before variable declarations.
 * mockShouldHonorManualOverride must be initialised in the same hoisting phase
 * so it is defined when @styrby/shared/billing's factory runs.
 */
const { mockShouldHonorManualOverride } = vi.hoisted(() => ({
  mockShouldHonorManualOverride: vi.fn(),
}));

vi.mock('@styrby/shared/billing', async (importOriginal) => {
  const original = await importOriginal<typeof import('@styrby/shared/billing')>();
  return {
    ...original,
    shouldHonorManualOverride: mockShouldHonorManualOverride,
  };
});

// ── Supabase mock chain ───────────────────────────────────────────────────────

// WHY separate mockUpsertSelectFn: the route calls .upsert(...).select('event_id')
// for Polar webhook dedup. The chained .select() requires the upsert mock to
// return an object with a select method, not a plain resolved value.
const mockUpsertSelectFn = vi.fn();
const mockSelect  = vi.fn().mockReturnThis();
const mockEq      = vi.fn().mockReturnThis();
const mockSingle  = vi.fn();
const mockUpsert  = vi.fn();
const mockUpdate  = vi.fn().mockReturnThis();
const mockInsert  = vi.fn().mockResolvedValue({ data: null, error: null });

const mockFrom = vi.fn().mockReturnValue({
  select:  mockSelect,
  eq:      mockEq,
  single:  mockSingle,
  upsert:  mockUpsert,
  update:  mockUpdate,
  insert:  mockInsert,
});

vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: vi.fn(() => ({
    from: mockFrom,
    rpc:  vi.fn().mockResolvedValue({ data: null, error: null }),
  })),
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(),
}));

import { POST } from '../../app/api/webhooks/polar/route';
import { headers } from 'next/headers';

// ============================================================================
// Helpers
// ============================================================================

const WEBHOOK_SECRET = 'integration-test-secret-xyz';

/**
 * Signs a payload with the webhook secret.
 *
 * @param payload - Raw JSON string to sign.
 * @returns HMAC-SHA256 hex digest.
 */
function signPayload(payload: string): string {
  return crypto.createHmac('sha256', WEBHOOK_SECRET).update(payload).digest('hex');
}

/**
 * Creates a mock Polar webhook Request with a valid HMAC signature.
 *
 * @param body - Event payload object.
 * @param overrideSignature - If provided, use this signature instead of a valid one.
 */
function createWebhookRequest(
  body: Record<string, unknown>,
  overrideSignature?: string,
): Request {
  const payload   = JSON.stringify(body);
  const signature = overrideSignature ?? signPayload(payload);

  const headersMock = new Headers();
  headersMock.set('polar-signature', signature);
  headersMock.set('x-forwarded-for', '1.2.3.4');

  return new Request('http://localhost:3000/api/webhooks/polar', {
    method: 'POST',
    headers: {
      'Content-Type':    'application/json',
      'x-forwarded-for': '1.2.3.4',
    },
    body: payload,
  });
}

/**
 * Standard subscription.created/updated event payload.
 *
 * @param overrides - Fields to merge into the data object.
 */
function subscriptionEvent(
  type: 'subscription.created' | 'subscription.updated',
  overrides: Record<string, unknown> = {},
) {
  return {
    id:   'evt-integration-001',
    type,
    data: {
      id:                   'sub_integration_123',
      customer_id:          'cust_integration_456',
      product_id:           'prod_pro_monthly',
      user_id:              'user-uuid-integration',
      status:               'active',
      current_period_start: '2026-04-01T00:00:00Z',
      current_period_end:   '2026-05-01T00:00:00Z',
      cancel_at_period_end: false,
      ...overrides,
    },
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('POST /api/webhooks/polar — manual override honor flow', () => {
  beforeEach(() => {
    // WHY resetAllMocks not clearAllMocks: clearAllMocks clears call counts but
    // leaves mockReturnValueOnce queues intact. If a test sets a Once override
    // on mockUpsert, subsequent tests consume it unexpectedly. resetAllMocks
    // wipes the queue so every test starts from the defaults below.
    vi.resetAllMocks();

    // Re-establish mockFrom return value after reset wipes it.
    mockFrom.mockReturnValue({
      select:  mockSelect,
      eq:      mockEq,
      single:  mockSingle,
      upsert:  mockUpsert,
      update:  mockUpdate,
      insert:  mockInsert,
    });

    // Re-establish chainable mocks wiped by resetAllMocks.
    mockSelect.mockReturnThis();
    mockEq.mockReturnThis();
    mockUpdate.mockReturnThis();

    // Default upsert: the dedup SELECT chain resolves as "new event" (non-empty RETURNING).
    mockUpsertSelectFn.mockResolvedValue({ data: [{ event_id: 'evt_default_new' }], error: null });
    mockUpsert.mockReturnValue({ select: mockUpsertSelectFn });

    // Default insert resolves cleanly.
    mockInsert.mockResolvedValue({ data: null, error: null });

    // Inject required env vars for product resolution and signature.
    vi.stubEnv('POLAR_WEBHOOK_SECRET',          WEBHOOK_SECRET);
    vi.stubEnv('POLAR_PRO_MONTHLY_PRODUCT_ID',  'prod_pro_monthly');
    vi.stubEnv('POLAR_PRO_ANNUAL_PRODUCT_ID',   'prod_pro_annual');
    vi.stubEnv('POLAR_POWER_MONTHLY_PRODUCT_ID','prod_power_monthly');
    vi.stubEnv('POLAR_POWER_ANNUAL_PRODUCT_ID', 'prod_power_annual');

    // Mock next/headers to return a headers object with our signature.
    vi.mocked(headers).mockImplementation(async () => new Headers() as unknown as Awaited<ReturnType<typeof headers>>);

    // Default DB responses.
    mockSingle.mockResolvedValue({
      data:  { id: 'user-uuid-integration' },
      error: null,
    });

    // Default override decision: polar_source (apply normally).
    mockShouldHonorManualOverride.mockResolvedValue({
      honor:  false,
      reason: 'polar_source',
    });
  });

  // --------------------------------------------------------------------------
  // (a) Polar source → applies (no active override)
  // --------------------------------------------------------------------------

  it('(a) polar_source: tier update is applied and returns 200 { received: true }', async () => {
    // shouldHonorManualOverride returns polar_source → proceed with upsert.
    mockShouldHonorManualOverride.mockResolvedValue({
      honor:  false,
      reason: 'polar_source',
    });

    const event   = subscriptionEvent('subscription.updated');
    const payload = JSON.stringify(event);
    const sig     = signPayload(payload);

    const headersMock = new Headers();
    headersMock.set('polar-signature', sig);
    vi.mocked(headers).mockResolvedValue(
      headersMock as unknown as Awaited<ReturnType<typeof headers>>
    );

    const req = new Request('http://localhost:3000/api/webhooks/polar', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '1.2.3.4' },
      body:    payload,
    });

    const response = await POST(req);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toEqual({ received: true });

    // shouldHonorManualOverride must be called exactly once for the user.
    expect(mockShouldHonorManualOverride).toHaveBeenCalledOnce();
    const [userId] = mockShouldHonorManualOverride.mock.calls[0];
    expect(userId).toBe('user-uuid-integration');
  });

  // --------------------------------------------------------------------------
  // (b) Manual active → skipped + structured log emitted
  // --------------------------------------------------------------------------

  it('(b) manual_override_active: tier update is skipped, returns 200 { received: true }', async () => {
    // WHY honor: true: admin set an override for this user. The webhook must
    // NOT overwrite the admin-set tier. SOC 2 CC6.1.
    mockShouldHonorManualOverride.mockResolvedValue({
      honor:      true,
      reason:     'manual_override_active',
      expiresAt:  '2027-01-01T00:00:00.000Z',
    });

    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    const event   = subscriptionEvent('subscription.updated');
    const payload = JSON.stringify(event);
    const sig     = signPayload(payload);

    const headersMock = new Headers();
    headersMock.set('polar-signature', sig);
    vi.mocked(headers).mockResolvedValue(
      headersMock as unknown as Awaited<ReturnType<typeof headers>>
    );

    const req = new Request('http://localhost:3000/api/webhooks/polar', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '1.2.3.4' },
      body:    payload,
    });

    const response = await POST(req);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toEqual({ received: true });

    // WHY exactly 1 upsert call: the dedup check runs first (call #1 to
    // polar_webhook_events). The honour logic then intercepts before the
    // subscription upsert, so the subscriptions upsert (call #2) never runs.
    // Only the dedup upsert fires — the admin-set tier is preserved. SOC 2 CC6.1.
    expect(mockUpsert).toHaveBeenCalledTimes(1);

    // WHY structured log check: the webhook must emit a structured JSON log
    // so ops can trace "why didn't the tier change?" from Sentry/Datadog
    // without grep. SOC 2 CC7.2.
    const infoLogs = consoleSpy.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(infoLogs).toMatch(/honoring manual override/);

    consoleSpy.mockRestore();
  });

  // --------------------------------------------------------------------------
  // (c) Expired override → atomic reset with audit row
  // --------------------------------------------------------------------------

  it('(c) override_expired: atomic RPC already applied update + audit; route only logs', async () => {
    // WHY: The atomic RPC (migration 045) handles the expired override:
    //   1. Applied the tier update in the same transaction.
    //   2. Reset override_source='polar', override_expires_at=NULL.
    //   3. Inserted the admin_audit_log row.
    // The webhook route must NOT do additional DB writes — only log structurally.
    const auditId = 512;
    mockShouldHonorManualOverride.mockResolvedValue({
      honor:         false,
      reason:        'override_expired',
      expiredAt:     '2026-04-20T00:00:00.000Z',
      previousActor: 'founder-uuid-001',
      auditId,
    });

    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    const event   = subscriptionEvent('subscription.updated');
    const payload = JSON.stringify(event);
    const sig     = signPayload(payload);

    const headersMock = new Headers();
    headersMock.set('polar-signature', sig);
    vi.mocked(headers).mockResolvedValue(
      headersMock as unknown as Awaited<ReturnType<typeof headers>>
    );

    const req = new Request('http://localhost:3000/api/webhooks/polar', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '1.2.3.4' },
      body:    payload,
    });

    const response = await POST(req);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toEqual({ received: true });

    // WHY verify structured log contains audit_id: ops need the audit_id to
    // find the audit row the RPC wrote. SOC 2 CC7.2.
    const infoLogs = consoleSpy.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(infoLogs).toMatch(/override expired/i);
    expect(infoLogs).toContain(String(auditId));

    consoleSpy.mockRestore();
  });

  // --------------------------------------------------------------------------
  // (d) Concurrent delivery — second wave sees polar_source
  // --------------------------------------------------------------------------

  it('(d) concurrent delivery: second polar_source delivery proceeds to upsert', async () => {
    // WHY: In a concurrent delivery scenario, the second delivery arrives after
    // the first has already cleared the override (the RPC committed). The second
    // delivery sees override_source='polar' (reset by the first delivery's
    // atomic RPC) and proceeds normally.
    mockShouldHonorManualOverride.mockResolvedValue({
      honor:  false,
      reason: 'polar_source',
    });

    // Second delivery: different event ID, same subscription.
    const event   = { ...subscriptionEvent('subscription.updated'), id: 'evt-second-wave' };
    const payload = JSON.stringify(event);
    const sig     = signPayload(payload);

    const headersMock = new Headers();
    headersMock.set('polar-signature', sig);
    vi.mocked(headers).mockResolvedValue(
      headersMock as unknown as Awaited<ReturnType<typeof headers>>
    );

    const req = new Request('http://localhost:3000/api/webhooks/polar', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '1.2.3.4' },
      body:    payload,
    });

    const response = await POST(req);
    expect(response.status).toBe(200);

    // shouldHonorManualOverride is called for the second delivery too.
    expect(mockShouldHonorManualOverride).toHaveBeenCalledOnce();

    // WHY 2 upsert calls: dedup upsert (polar_webhook_events, call #1) runs
    // first, then the subscription upsert (subscriptions table, call #2) runs
    // because the dedup returned a non-empty RETURNING row (new event).
    expect(mockUpsert).toHaveBeenCalledTimes(2);
  });

  // --------------------------------------------------------------------------
  // (e) Invalid tier raises 22023 → route returns 500
  // --------------------------------------------------------------------------

  it('(e) invalid tier (ERRCODE 22023) raises error in shouldHonorManualOverride → route returns 500', async () => {
    // WHY: SQLSTATE 22023 means the RPC rejected p_new_tier as invalid.
    // shouldHonorManualOverride re-throws in this case (not fail-open) so the
    // webhook route catches it and returns 500, prompting Polar to retry.
    // WHY NOT fail-open: proceeding with an invalid tier would corrupt
    // subscription state. 500 + Polar retry is the safer option.
    // (OWASP A09:2021: anomalies must surface, not be silently swallowed.)
    mockShouldHonorManualOverride.mockRejectedValue(
      new Error("shouldHonorManualOverride: invalid tier value '' rejected by RPC allowlist (ERRCODE 22023)")
    );

    const event   = subscriptionEvent('subscription.updated');
    const payload = JSON.stringify(event);
    const sig     = signPayload(payload);

    const headersMock = new Headers();
    headersMock.set('polar-signature', sig);
    vi.mocked(headers).mockResolvedValue(
      headersMock as unknown as Awaited<ReturnType<typeof headers>>
    );

    const req = new Request('http://localhost:3000/api/webhooks/polar', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '1.2.3.4' },
      body:    payload,
    });

    const response = await POST(req);
    // 500: Polar will retry — the route must not return 200 and silently drop
    // a billing event that contains an invalid tier.
    expect(response.status).toBe(500);

    const body = await response.json();
    expect(body).toHaveProperty('error');
    // The error message must NOT leak internal details (e.g., raw SQL error).
    expect(body.error).not.toMatch(/ERRCODE|SQLSTATE|pg_/i);
  });
});
