/**
 * Tests for billing server actions — billing/actions.ts
 *
 * Covers for each action (issueRefundAction, issueCreditAction, sendChurnSaveOfferAction):
 *   (a) Happy path — calls RPC (and Polar for refund) with correct args; revalidates + redirects
 *   (b) URL cross-check mismatch — FormData.targetUserId !== trustedUserId → { ok: false } + Sentry
 *   (c) Zod validation failure — invalid fields → { ok: false, field } without calling RPC/Polar
 *   (d) SQLSTATE 42501 → { ok: false, error: 'Not authorized' }
 *   (e) SQLSTATE 22023 → { ok: false, error: 'Invalid input value' }
 *       (sendChurnSaveOfferAction 22023 → 'Active offer already exists...')
 *   (f) Unexpected SQLSTATE → { ok: false, error: 'Internal error' } + Sentry.captureException
 *
 * Refund-specific (issueRefundAction):
 *   (r1) Polar 'idempotent-replay' → treated as success, RPC still called
 *   (r2) Polar 'invalid' → { ok: false, error: 'Polar rejected: ...' }, no Sentry
 *   (r3) Polar 'polar-error' → { ok: false, error: 'Polar temporarily unavailable' } + Sentry
 *   (r4) Polar 'network'/'config' → { ok: false, error: 'Internal error' } + Sentry
 *   (r5) audit-orphan: RPC returns 0 → Sentry.captureMessage at 'warning', still redirects
 *
 * Testing strategy:
 *   - Mock next/cache, next/navigation
 *   - Mock @/lib/supabase/server (createClient, createAdminClient)
 *   - Mock @/lib/billing/polar-refund (createPolarRefund, RefundError)
 *   - Mock @sentry/nextjs
 *   - Call actions directly with FormData objects
 *   - Assert mock calls and return values
 *
 * WHY we mock redirect() to throw:
 *   In production, redirect() throws a special Next.js error to interrupt the
 *   current render. We replicate that to verify actions call redirect on success
 *   without the test hanging on a missing render context.
 *
 * SOC 2 CC6.1 / CC7.2: every mutation path (happy + error) is tested so we can
 * assert the audit trail contract (Polar before RPC for refunds, etc.).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ───────────────────────────────────────────────────────────────────

// WHY vi.hoisted: vi.mock() factories are hoisted to the top of the file by
// Vitest. Any top-level `const mockX = vi.fn()` referenced inside a factory
// body is therefore not yet initialized at hoist-time, which under vite ≥7.3's
// stricter mock-validation throws "Cannot access '__vi_import_X__' before
// initialization". vi.hoisted() lifts the mock-fn declarations to run BEFORE
// the vi.mock() factories, which makes the references safe.
const mocks = vi.hoisted(() => ({
  // WHY mock redirect as throwing: Next.js redirect() throws a special error
  // internally to abort the current function. We replicate this so tests can
  // assert "redirect was called" without needing a full Next.js render context.
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
  revalidatePath: vi.fn(),
  sentryCapture: vi.fn(),
  sentryCaptureMessage: vi.fn(),
  rpc: vi.fn(),
  createPolarRefund: vi.fn(),
  findRefundableOrder: vi.fn(),
}));

// Convenience aliases preserved so the existing test bodies keep referencing
// `mockRedirect`, `mockRpc`, etc. without churn. These point at the same
// vi.fn() instances created inside vi.hoisted() above.
const mockRedirect = mocks.redirect;
const mockRevalidatePath = mocks.revalidatePath;
const mockSentryCapture = mocks.sentryCapture;
const mockSentryCaptureMessage = mocks.sentryCaptureMessage;
const mockRpc = mocks.rpc;
const mockCreatePolarRefund = mocks.createPolarRefund;
const mockFindRefundableOrder = mocks.findRefundableOrder;

vi.mock('next/navigation', () => ({
  redirect: (url: string) => mocks.redirect(url),
}));

vi.mock('next/cache', () => ({
  revalidatePath: (path: string) => mocks.revalidatePath(path),
}));

// ─── Sentry mock ─────────────────────────────────────────────────────────────

vi.mock('@sentry/nextjs', () => ({
  captureException: (...args: unknown[]) => mocks.sentryCapture(...args),
  captureMessage: (...args: unknown[]) => mocks.sentryCaptureMessage(...args),
}));

// ─── Supabase mock ───────────────────────────────────────────────────────────

/**
 * Configurable mock for Supabase clients.
 *
 * WHY createClient is plain vi.fn() (not .mockResolvedValue in factory):
 *   The mock state for .rpc / .from is per-test-case and we set
 *   mockResolvedValue in beforeEach(). The createClient/createAdminClient
 *   stubs are created locally in the factory because they are not referenced
 *   elsewhere — only the returned object's .rpc/.from need to be reachable
 *   from tests, and that comes via mockRpc (hoisted above).
 */
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createAdminClient: vi.fn(),
}));

// ─── Polar refund mock ───────────────────────────────────────────────────────

/**
 * Mock createPolarRefund and a real-ish RefundError class.
 *
 * WHY mock polar-refund module: tests must be able to simulate all Polar
 * failure paths (idempotent-replay, invalid, polar-error, network, config)
 * without making real HTTP calls. The mock class preserves the `code` and
 * `rawBody` properties that the action inspects.
 */
vi.mock('@/lib/billing/polar-refund', () => {
  // WHY define MockRefundError (renamed from RefundError) in the factory:
  // the action imports and instanceof-checks RefundError, and the test file
  // also imports the symbol `RefundError` for use in test bodies. Vite ≥7.3's
  // stricter SSR transform aliases identifiers that match a hoisted import
  // name, even inside a vi.mock factory body — so a class literally named
  // `RefundError` inside this factory got rewritten to reference the (not-yet-
  // initialized) `__vi_import_1__.RefundError`, throwing TDZ. Renaming the
  // local class breaks the collision; we map it to the public name in the
  // returned module shape so the action's import still resolves to this class.
  class MockRefundError extends Error {
    readonly code: string;
    readonly rawBody?: unknown;
    constructor(code: string, message: string, rawBody?: unknown) {
      super(message);
      this.name = 'RefundError';
      this.code = code;
      this.rawBody = rawBody;
    }
  }
  return {
    createPolarRefund: (...args: unknown[]) => mocks.createPolarRefund(...args),
    findRefundableOrderForSubscription: (...args: unknown[]) =>
      mocks.findRefundableOrder(...args),
    RefundError: MockRefundError,
  };
});

// Import mocked modules so tests can assert on them.
import { createClient, createAdminClient } from '@/lib/supabase/server';
import { RefundError } from '@/lib/billing/polar-refund';
import type { Mock } from 'vitest';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Builds a FormData object from a plain record.
 * WHY: FormData is the contract for Next.js server actions.
 */
function makeFormData(entries: Record<string, string | null | undefined>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    if (value != null) {
      fd.append(key, value);
    }
  }
  return fd;
}

const VALID_UUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const VALID_UUID_2 = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';

/** Default successful Polar refund response. */
const DEFAULT_POLAR_RESPONSE = {
  refundId: 'pol_refund_abc123',
  eventId: 'pol_evt_xyz789',
  rawResponse: { id: 'pol_refund_abc123', status: 'succeeded' },
};

// ─── issueRefundAction ───────────────────────────────────────────────────────

describe('issueRefundAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // WHY restore after clearAllMocks: clearAllMocks wipes mockResolvedValue.
    // createClient must return an object with .rpc and .from so the action can:
    //   1. .from('subscriptions').select(...).eq(...).maybeSingle() for the
    //      polar_customer_id + user_id lookup added in SEC-REFUND-001.
    //   2. .rpc('admin_issue_refund', ...) to write the audit row.
    // The .from() chain default resolves to a valid subscription row owned by
    // the URL-bound test user; tests that need to override (no row, wrong owner,
    // DB error) reassign the maybeSingle resolver per-case.
    (createClient as Mock).mockResolvedValue({
      rpc: mockRpc,
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({
              data: { polar_customer_id: 'cus_test_default', user_id: VALID_UUID },
              error: null,
            }),
          }),
        }),
      }),
    });
    // Default Polar success
    mockCreatePolarRefund.mockResolvedValue(DEFAULT_POLAR_RESPONSE);
    // Default Polar order resolver — returns a real-ish orderId with ample
    // refundable balance so amount-checks don't trip on the default path.
    mockFindRefundableOrder.mockResolvedValue({
      orderId: 'ord_test_default',
      refundableCents: 100_000,
    });
    // Default RPC success — returns a non-zero audit ID
    mockRpc.mockResolvedValue({ data: 42, error: null });
  });

  // ── (a) Happy path ────────────────────────────────────────────────────────

  it('(a) happy path: calls createPolarRefund then RPC with correct args, revalidates + redirects', async () => {
    const { issueRefundAction } = await import('../actions');

    await expect(
      issueRefundAction(
        VALID_UUID,
        makeFormData({
          targetUserId: VALID_UUID,
          subscriptionId: 'sub_polar_123',
          amount_cents: '4900',
          reason: 'Customer requested refund for billing error',
        }),
      ),
    ).rejects.toThrow(/NEXT_REDIRECT/);

    // Polar must be called before the RPC (money-move before audit).
    const polarCallOrder = mockCreatePolarRefund.mock.invocationCallOrder[0];
    const rpcCallOrder = mockRpc.mock.invocationCallOrder[0];
    expect(polarCallOrder).toBeLessThan(rpcCallOrder);

    // Polar called with correct fields
    expect(mockCreatePolarRefund).toHaveBeenCalledWith(
      expect.objectContaining({
        subscriptionId: 'sub_polar_123',
        amountCents: 4900,
        reason: 'Customer requested refund for billing error',
      }),
    );

    // RPC called with correct params (8 params — migration 051 signature)
    expect(mockRpc).toHaveBeenCalledWith('admin_issue_refund', {
      p_target_user_id: VALID_UUID,
      p_amount_cents: 4900,
      p_currency: 'usd',
      p_reason: 'Customer requested refund for billing error',
      p_polar_event_id: DEFAULT_POLAR_RESPONSE.eventId,
      p_polar_refund_id: DEFAULT_POLAR_RESPONSE.refundId,
      p_polar_subscription_id: 'sub_polar_123',
      p_polar_response_json: DEFAULT_POLAR_RESPONSE.rawResponse,
    });

    expect(mockRevalidatePath).toHaveBeenCalledWith(
      `/dashboard/admin/users/${VALID_UUID}/billing`,
    );
    expect(mockRedirect).toHaveBeenCalledWith(
      `/dashboard/admin/users/${VALID_UUID}/billing`,
    );
  });

  // ── (b) URL cross-check mismatch ──────────────────────────────────────────

  it('(b) returns mismatch error and skips Polar + RPC when FormData.targetUserId differs from trustedUserId', async () => {
    const { issueRefundAction } = await import('../actions');

    const result = await issueRefundAction(
      VALID_UUID,
      makeFormData({
        targetUserId: VALID_UUID_2,
        subscriptionId: 'sub_polar_123',
        amount_cents: '4900',
        reason: 'Tampered form data for wrong user',
      }),
    );

    expect(result).toEqual({ ok: false, error: 'targetUserId mismatch with URL context' });
    expect(mockCreatePolarRefund).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockSentryCaptureMessage).toHaveBeenCalledOnce();
    const [, sentryCtx] = mockSentryCaptureMessage.mock.calls[0];
    expect(sentryCtx.tags.admin_action).toBe('issue_refund');
  });

  // ── (c) Zod validation failures ──────────────────────────────────────────

  it('(c) returns error when amount_cents is 0', async () => {
    const { issueRefundAction } = await import('../actions');

    const result = await issueRefundAction(
      VALID_UUID,
      makeFormData({
        targetUserId: VALID_UUID,
        subscriptionId: 'sub_123',
        amount_cents: '0',
        reason: 'Valid reason here, 10+ chars',
      }),
    );

    expect(result).toMatchObject({ ok: false });
    expect(mockCreatePolarRefund).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('(c) returns error when amount_cents exceeds 500000', async () => {
    const { issueRefundAction } = await import('../actions');

    const result = await issueRefundAction(
      VALID_UUID,
      makeFormData({
        targetUserId: VALID_UUID,
        subscriptionId: 'sub_123',
        amount_cents: '500001',
        reason: 'Valid reason here, 10+ chars',
      }),
    );

    expect(result).toMatchObject({ ok: false, field: 'amount_cents' });
    expect(mockCreatePolarRefund).not.toHaveBeenCalled();
  });

  it('(c) returns error when reason is fewer than 10 chars', async () => {
    const { issueRefundAction } = await import('../actions');

    const result = await issueRefundAction(
      VALID_UUID,
      makeFormData({
        targetUserId: VALID_UUID,
        subscriptionId: 'sub_123',
        amount_cents: '1000',
        reason: 'short',
      }),
    );

    expect(result).toMatchObject({ ok: false, field: 'reason' });
    expect(mockCreatePolarRefund).not.toHaveBeenCalled();
  });

  it('(c) returns error when subscriptionId is missing', async () => {
    const { issueRefundAction } = await import('../actions');

    const result = await issueRefundAction(
      VALID_UUID,
      makeFormData({
        targetUserId: VALID_UUID,
        amount_cents: '1000',
        reason: 'Valid reason here, 10+ chars',
      }),
    );

    expect(result).toMatchObject({ ok: false });
    expect(mockCreatePolarRefund).not.toHaveBeenCalled();
  });

  // ── (d) SQLSTATE 42501 ────────────────────────────────────────────────────

  it('(d) maps SQLSTATE 42501 from RPC to "Not authorized"', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'permission denied' } });

    const { issueRefundAction } = await import('../actions');

    const result = await issueRefundAction(
      VALID_UUID,
      makeFormData({
        targetUserId: VALID_UUID,
        subscriptionId: 'sub_123',
        amount_cents: '1000',
        reason: 'Valid reason here, 10+ chars',
      }),
    );

    expect(result).toEqual({ ok: false, error: 'Not authorized' });
    // Polar was still called (RPC is the gate, not Polar).
    expect(mockCreatePolarRefund).toHaveBeenCalled();
  });

  // ── (e) SQLSTATE 22023 ────────────────────────────────────────────────────

  it('(e) maps SQLSTATE 22023 from RPC to "Invalid input value"', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: '22023', message: 'invalid param' } });

    const { issueRefundAction } = await import('../actions');

    const result = await issueRefundAction(
      VALID_UUID,
      makeFormData({
        targetUserId: VALID_UUID,
        subscriptionId: 'sub_123',
        amount_cents: '1000',
        reason: 'Valid reason here, 10+ chars',
      }),
    );

    expect(result).toEqual({ ok: false, error: 'Invalid input value' });
  });

  // ── (f) Unexpected SQLSTATE ───────────────────────────────────────────────

  it('(f) maps unexpected SQLSTATE to "Internal error" and captures Sentry', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: 'XX000', message: 'internal db error' } });

    const { issueRefundAction } = await import('../actions');

    const result = await issueRefundAction(
      VALID_UUID,
      makeFormData({
        targetUserId: VALID_UUID,
        subscriptionId: 'sub_123',
        amount_cents: '1000',
        reason: 'Valid reason here, 10+ chars',
      }),
    );

    expect(result).toMatchObject({ ok: false, error: 'Internal error — check Sentry' });
    expect(mockSentryCapture).toHaveBeenCalledOnce();
    const [, sentryCtx] = mockSentryCapture.mock.calls[0];
    expect(sentryCtx.tags.admin_action).toBe('issue_refund');
    expect(sentryCtx.tags.sqlstate).toBe('XX000');
  });

  // ── (r1) Polar idempotent-replay ──────────────────────────────────────────

  it('(r1) Polar idempotent-replay: treats as success and still calls RPC', async () => {
    // WHY: if Polar says the refund already exists, the money has been moved.
    // We still write the audit row so the trail is complete. SOC 2 CC7.2.
    mockCreatePolarRefund.mockRejectedValueOnce(
      new RefundError('idempotent-replay', 'Already refunded'),
    );
    mockRpc.mockResolvedValueOnce({ data: 55, error: null });

    const { issueRefundAction } = await import('../actions');

    await expect(
      issueRefundAction(
        VALID_UUID,
        makeFormData({
          targetUserId: VALID_UUID,
          subscriptionId: 'sub_123',
          amount_cents: '1000',
          reason: 'Valid reason here, 10+ chars',
        }),
      ),
    ).rejects.toThrow(/NEXT_REDIRECT/);

    // RPC must still be called (audit trail for the replay).
    expect(mockRpc).toHaveBeenCalledWith('admin_issue_refund', expect.any(Object));
    // No Sentry on idempotent-replay (expected condition).
    expect(mockSentryCapture).not.toHaveBeenCalled();
    expect(mockSentryCaptureMessage).not.toHaveBeenCalled();
  });

  // ── (r2) Polar invalid ────────────────────────────────────────────────────

  it('(r2) Polar invalid: returns static error + captures Sentry at info level (SEC-R2-S2-002)', async () => {
    // SEC-R2-S2-002: 'invalid' previously surfaced `Polar rejected: ${err.message}`
    // verbatim, leaking Polar SDK internal field names and validation context.
    // The fix replaces the dynamic message with a static one and captures the
    // full error in Sentry at 'info' level (expected-failure, not server error).
    mockCreatePolarRefund.mockRejectedValueOnce(
      new RefundError('invalid', 'Amount exceeds original charge'),
    );

    const { issueRefundAction } = await import('../actions');

    const result = await issueRefundAction(
      VALID_UUID,
      makeFormData({
        targetUserId: VALID_UUID,
        subscriptionId: 'sub_123',
        amount_cents: '1000',
        reason: 'Valid reason here, 10+ chars',
      }),
    );

    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toBe(
      'Polar rejected the refund request. Verify the order, amount, and subscription status.',
    );
    // Should NOT leak the SDK error message:
    expect((result as { ok: false; error: string }).error).not.toMatch(/Amount exceeds/);
    expect(mockRpc).not.toHaveBeenCalled();
    // Now expects ONE Sentry call at 'info' severity (was previously asserted absent).
    expect(mockSentryCapture).toHaveBeenCalledOnce();
    const [, ctx] = mockSentryCapture.mock.calls[0];
    expect(ctx.level).toBe('info');
    expect(ctx.tags.refund_error_code).toBe('invalid');
  });

  // ── (r3) Polar polar-error ────────────────────────────────────────────────

  it('(r3) Polar polar-error: returns { ok: false, error: Polar temporarily unavailable } + Sentry', async () => {
    mockCreatePolarRefund.mockRejectedValueOnce(
      new RefundError('polar-error', 'Polar internal server error'),
    );

    const { issueRefundAction } = await import('../actions');

    const result = await issueRefundAction(
      VALID_UUID,
      makeFormData({
        targetUserId: VALID_UUID,
        subscriptionId: 'sub_123',
        amount_cents: '1000',
        reason: 'Valid reason here, 10+ chars',
      }),
    );

    expect(result).toEqual({ ok: false, error: 'Polar temporarily unavailable — retry' });
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockSentryCapture).toHaveBeenCalledOnce();
    const [, sentryCtx] = mockSentryCapture.mock.calls[0];
    expect(sentryCtx.tags.admin_action).toBe('issue_refund');
    expect(sentryCtx.tags.refund_error_code).toBe('polar-error');
  });

  // ── (r4) Polar network + config ───────────────────────────────────────────

  it('(r4a) Polar network error: returns { ok: false, error: Internal error } + Sentry', async () => {
    mockCreatePolarRefund.mockRejectedValueOnce(
      new RefundError('network', 'Request timed out'),
    );

    const { issueRefundAction } = await import('../actions');

    const result = await issueRefundAction(
      VALID_UUID,
      makeFormData({
        targetUserId: VALID_UUID,
        subscriptionId: 'sub_123',
        amount_cents: '1000',
        reason: 'Valid reason here, 10+ chars',
      }),
    );

    expect(result).toEqual({ ok: false, error: 'Internal error' });
    expect(mockSentryCapture).toHaveBeenCalledOnce();
  });

  it('(r4b) Polar config error: returns { ok: false, error: Internal error } + Sentry', async () => {
    mockCreatePolarRefund.mockRejectedValueOnce(
      new RefundError('config', 'POLAR_ACCESS_TOKEN is unset'),
    );

    const { issueRefundAction } = await import('../actions');

    const result = await issueRefundAction(
      VALID_UUID,
      makeFormData({
        targetUserId: VALID_UUID,
        subscriptionId: 'sub_123',
        amount_cents: '1000',
        reason: 'Valid reason here, 10+ chars',
      }),
    );

    expect(result).toEqual({ ok: false, error: 'Internal error' });
    expect(mockSentryCapture).toHaveBeenCalledOnce();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  // ── (r5) Audit-orphan: RPC returns 0 ─────────────────────────────────────

  it('(r5) audit-orphan: RPC returns 0 → Sentry.captureMessage at warning level, still redirects', async () => {
    // WHY: RPC returns 0 means the refund event already existed (ON CONFLICT DO
    // NOTHING) and no audit row was written. This is an inconsistency — the money
    // moved but the audit trail has a gap. We log to Sentry and continue.
    // The admin still gets redirected (the refund was processed).
    mockRpc.mockResolvedValueOnce({ data: 0, error: null });

    const { issueRefundAction } = await import('../actions');

    await expect(
      issueRefundAction(
        VALID_UUID,
        makeFormData({
          targetUserId: VALID_UUID,
          subscriptionId: 'sub_123',
          amount_cents: '1000',
          reason: 'Valid reason here, 10+ chars',
        }),
      ),
    ).rejects.toThrow(/NEXT_REDIRECT/);

    // Sentry must be called at 'warning' level with the orphan message.
    expect(mockSentryCaptureMessage).toHaveBeenCalledOnce();
    const [message, sentryCtx] = mockSentryCaptureMessage.mock.calls[0];
    expect(message).toMatch(/audit orphan/);
    expect(sentryCtx.level).toBe('warning');
    expect(sentryCtx.tags.target_user_id).toBe(VALID_UUID);

    // Despite the orphan, redirect must still happen.
    expect(mockRedirect).toHaveBeenCalledWith(`/dashboard/admin/users/${VALID_UUID}/billing`);
  });

  // ── (h) SEC-REFUND-001: Polar order resolution ───────────────────────────

  describe('(h) SEC-REFUND-001 — order resolution', () => {
    /**
     * Helper to override the maybeSingle resolver for the subscription lookup
     * without rebuilding the entire from() chain. Each test case can stage
     * one custom resolver value.
     */
    function setSubscriptionLookup(value: { data: unknown; error: unknown }) {
      (createClient as Mock).mockResolvedValue({
        rpc: mockRpc,
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue(value),
            }),
          }),
        }),
      });
    }

    it('returns clear error when no subscription is found for the polar_subscription_id', async () => {
      setSubscriptionLookup({ data: null, error: null });
      const { issueRefundAction } = await import('../actions');

      const result = await issueRefundAction(
        VALID_UUID,
        makeFormData({
          targetUserId: VALID_UUID,
          subscriptionId: 'sub_does_not_exist',
          amount_cents: '4900',
          reason: 'No subscription found',
        }),
      );

      expect(result).toEqual({
        ok: false,
        error: expect.stringContaining('No subscription found'),
        field: 'subscription_id',
      });
      expect(mockFindRefundableOrder).not.toHaveBeenCalled();
      expect(mockCreatePolarRefund).not.toHaveBeenCalled();
      expect(mockRpc).not.toHaveBeenCalled();
    });

    it('rejects (IDOR defense) when subscription belongs to a different user than the URL-bound target', async () => {
      setSubscriptionLookup({
        data: { polar_customer_id: 'cus_other', user_id: VALID_UUID_2 },
        error: null,
      });
      const { issueRefundAction } = await import('../actions');

      const result = await issueRefundAction(
        VALID_UUID,
        makeFormData({
          targetUserId: VALID_UUID,
          subscriptionId: 'sub_belongs_to_other',
          amount_cents: '4900',
          reason: 'Cross-user subscription tampering attempt',
        }),
      );

      expect(result).toEqual({
        ok: false,
        error: 'Subscription does not belong to this user.',
      });
      expect(mockFindRefundableOrder).not.toHaveBeenCalled();
      expect(mockCreatePolarRefund).not.toHaveBeenCalled();
      expect(mockRpc).not.toHaveBeenCalled();
    });

    it('returns clear error when amount_cents exceeds the resolved order refundable balance', async () => {
      mockFindRefundableOrder.mockResolvedValueOnce({
        orderId: 'ord_partial',
        refundableCents: 1000,
      });
      const { issueRefundAction } = await import('../actions');

      const result = await issueRefundAction(
        VALID_UUID,
        makeFormData({
          targetUserId: VALID_UUID,
          subscriptionId: 'sub_polar_123',
          amount_cents: '4900',
          reason: 'Refund exceeds remaining',
        }),
      );

      expect(result).toEqual({
        ok: false,
        error: expect.stringMatching(/exceeds the 1000 cents remaining/),
        field: 'amount_cents',
      });
      expect(mockCreatePolarRefund).not.toHaveBeenCalled();
      expect(mockRpc).not.toHaveBeenCalled();
    });

    it('passes the resolved orderId (not the subscription_id) into createPolarRefund', async () => {
      mockFindRefundableOrder.mockResolvedValueOnce({
        orderId: 'ord_resolved_abc',
        refundableCents: 100_000,
      });
      const { issueRefundAction } = await import('../actions');

      await expect(
        issueRefundAction(
          VALID_UUID,
          makeFormData({
            targetUserId: VALID_UUID,
            subscriptionId: 'sub_polar_xyz',
            amount_cents: '4900',
            reason: 'Verifies orderId is forwarded, not subscription id',
          }),
        ),
      ).rejects.toThrow(/NEXT_REDIRECT/);

      expect(mockCreatePolarRefund).toHaveBeenCalledOnce();
      const [refundCall] = mockCreatePolarRefund.mock.calls[0] as [
        { orderId: string; subscriptionId: string },
      ];
      expect(refundCall.orderId).toBe('ord_resolved_abc');
      expect(refundCall.subscriptionId).toBe('sub_polar_xyz');
    });

    it('propagates RefundError from findRefundableOrderForSubscription as Polar-rejected', async () => {
      // Order resolver throws 'invalid' — should surface as user-facing error,
      // skip createPolarRefund and the audit RPC.
      mockFindRefundableOrder.mockRejectedValueOnce(
        new RefundError('invalid', 'No refundable orders found for sub_polar_123'),
      );
      const { issueRefundAction } = await import('../actions');

      const result = await issueRefundAction(
        VALID_UUID,
        makeFormData({
          targetUserId: VALID_UUID,
          subscriptionId: 'sub_polar_123',
          amount_cents: '4900',
          reason: 'No refundable orders path',
        }),
      );

      // SEC-R2-S2-002: error message is now static, not dynamic. Just assert
      // it contains the stable prefix, since "Polar rejected" appears at the
      // start of the static message.
      expect(result).toEqual({
        ok: false,
        error: expect.stringContaining('Polar rejected the refund request'),
      });
      expect(mockCreatePolarRefund).not.toHaveBeenCalled();
      expect(mockRpc).not.toHaveBeenCalled();
    });
  });
});

// ─── issueCreditAction ────────────────────────────────────────────────────────

describe('issueCreditAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (createClient as Mock).mockResolvedValue({ rpc: mockRpc });
    mockRpc.mockResolvedValue({ data: { audit_id: 10, credit_id: 99 }, error: null });
  });

  // ── (a) Happy path ────────────────────────────────────────────────────────

  it('(a) happy path: calls RPC with correct args, revalidates + redirects', async () => {
    const { issueCreditAction } = await import('../actions');

    await expect(
      issueCreditAction(
        VALID_UUID,
        makeFormData({
          targetUserId: VALID_UUID,
          amount_cents: '5000',
          reason: 'Compensation for service disruption',
        }),
      ),
    ).rejects.toThrow(/NEXT_REDIRECT/);

    expect(mockRpc).toHaveBeenCalledWith('admin_issue_credit', {
      p_target_user_id: VALID_UUID,
      p_amount_cents: 5000,
      p_currency: 'usd',
      p_reason: 'Compensation for service disruption',
      p_expires_at: null,
    });

    expect(mockRevalidatePath).toHaveBeenCalledWith(
      `/dashboard/admin/users/${VALID_UUID}/billing`,
    );
    expect(mockRedirect).toHaveBeenCalledWith(`/dashboard/admin/users/${VALID_UUID}/billing`);
  });

  it('(a) passes normalized ISO string when expires_at is provided', async () => {
    const { issueCreditAction } = await import('../actions');

    await expect(
      issueCreditAction(
        VALID_UUID,
        makeFormData({
          targetUserId: VALID_UUID,
          amount_cents: '2000',
          reason: 'Compensation for service disruption here',
          expires_at: '2027-06-30T00:00:00.000Z',
        }),
      ),
    ).rejects.toThrow(/NEXT_REDIRECT/);

    const rpcArgs = mockRpc.mock.calls[0][1];
    expect(rpcArgs.p_expires_at).toBe('2027-06-30T00:00:00.000Z');
  });

  it('(a) passes null when expires_at is empty string', async () => {
    const { issueCreditAction } = await import('../actions');

    await expect(
      issueCreditAction(
        VALID_UUID,
        makeFormData({
          targetUserId: VALID_UUID,
          amount_cents: '2000',
          reason: 'Compensation for service disruption here',
          expires_at: '',
        }),
      ),
    ).rejects.toThrow(/NEXT_REDIRECT/);

    const rpcArgs = mockRpc.mock.calls[0][1];
    expect(rpcArgs.p_expires_at).toBeNull();
  });

  // ── (b) URL cross-check mismatch ──────────────────────────────────────────

  it('(b) returns mismatch error and skips RPC when FormData.targetUserId differs from trustedUserId', async () => {
    const { issueCreditAction } = await import('../actions');

    const result = await issueCreditAction(
      VALID_UUID,
      makeFormData({
        targetUserId: VALID_UUID_2,
        amount_cents: '5000',
        reason: 'Tampered form data for wrong user',
      }),
    );

    expect(result).toEqual({ ok: false, error: 'targetUserId mismatch with URL context' });
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockSentryCaptureMessage).toHaveBeenCalledOnce();
    const [, sentryCtx] = mockSentryCaptureMessage.mock.calls[0];
    expect(sentryCtx.tags.admin_action).toBe('issue_credit');
  });

  // ── (c) Zod validation failures ──────────────────────────────────────────

  it('(c) returns error when amount_cents is 0', async () => {
    const { issueCreditAction } = await import('../actions');

    const result = await issueCreditAction(
      VALID_UUID,
      makeFormData({
        targetUserId: VALID_UUID,
        amount_cents: '0',
        reason: 'Valid reason here, 10+ chars',
      }),
    );

    expect(result).toMatchObject({ ok: false, field: 'amount_cents' });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('(c) returns error when amount_cents exceeds 100000', async () => {
    const { issueCreditAction } = await import('../actions');

    const result = await issueCreditAction(
      VALID_UUID,
      makeFormData({
        targetUserId: VALID_UUID,
        amount_cents: '100001',
        reason: 'Valid reason here, 10+ chars',
      }),
    );

    expect(result).toMatchObject({ ok: false, field: 'amount_cents' });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('(c) returns error when reason is fewer than 10 chars', async () => {
    const { issueCreditAction } = await import('../actions');

    const result = await issueCreditAction(
      VALID_UUID,
      makeFormData({
        targetUserId: VALID_UUID,
        amount_cents: '1000',
        reason: 'short',
      }),
    );

    expect(result).toMatchObject({ ok: false, field: 'reason' });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('(c) returns 400-equivalent when expires_at is an invalid date string', async () => {
    const { issueCreditAction } = await import('../actions');

    const result = await issueCreditAction(
      VALID_UUID,
      makeFormData({
        targetUserId: VALID_UUID,
        amount_cents: '1000',
        reason: 'Valid reason here, 10+ chars',
        expires_at: 'not-a-date',
      }),
    );

    expect(result).toMatchObject({ ok: false, field: 'expires_at' });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  // ── (d) SQLSTATE 42501 ────────────────────────────────────────────────────

  it('(d) maps SQLSTATE 42501 to "Not authorized"', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'permission denied' } });

    const { issueCreditAction } = await import('../actions');

    const result = await issueCreditAction(
      VALID_UUID,
      makeFormData({
        targetUserId: VALID_UUID,
        amount_cents: '1000',
        reason: 'Valid reason here, 10+ chars',
      }),
    );

    expect(result).toEqual({ ok: false, error: 'Not authorized' });
    expect(mockSentryCapture).not.toHaveBeenCalled();
  });

  // ── (e) SQLSTATE 22023 ────────────────────────────────────────────────────

  it('(e) maps SQLSTATE 22023 to "Invalid input value"', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: '22023', message: 'invalid param' } });

    const { issueCreditAction } = await import('../actions');

    const result = await issueCreditAction(
      VALID_UUID,
      makeFormData({
        targetUserId: VALID_UUID,
        amount_cents: '1000',
        reason: 'Valid reason here, 10+ chars',
      }),
    );

    expect(result).toEqual({ ok: false, error: 'Invalid input value' });
  });

  // ── (f) Unexpected SQLSTATE ───────────────────────────────────────────────

  it('(f) maps unexpected SQLSTATE to "Internal error" and captures Sentry', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: 'P0001', message: 'unexpected' } });

    const { issueCreditAction } = await import('../actions');

    const result = await issueCreditAction(
      VALID_UUID,
      makeFormData({
        targetUserId: VALID_UUID,
        amount_cents: '1000',
        reason: 'Valid reason here, 10+ chars',
      }),
    );

    expect(result).toMatchObject({ ok: false, error: 'Internal error — check Sentry' });
    expect(mockSentryCapture).toHaveBeenCalledOnce();
    const [, sentryCtx] = mockSentryCapture.mock.calls[0];
    expect(sentryCtx.tags.admin_action).toBe('issue_credit');
    expect(sentryCtx.tags.sqlstate).toBe('P0001');
  });
});

// ─── sendChurnSaveOfferAction ─────────────────────────────────────────────────

describe('sendChurnSaveOfferAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (createClient as Mock).mockResolvedValue({ rpc: mockRpc });
    mockRpc.mockResolvedValue({
      data: { audit_id: 20, offer_id: 88 },
      error: null,
    });
  });

  // ── (a) Happy path ────────────────────────────────────────────────────────

  it('(a) happy path: calls RPC with correct args for annual_3mo_25pct kind', async () => {
    const { sendChurnSaveOfferAction } = await import('../actions');

    await expect(
      sendChurnSaveOfferAction(
        VALID_UUID,
        makeFormData({
          targetUserId: VALID_UUID,
          kind: 'annual_3mo_25pct',
          reason: 'User expressed intent to cancel subscription',
          polar_discount_code: 'SAVE25',
        }),
      ),
    ).rejects.toThrow(/NEXT_REDIRECT/);

    expect(mockRpc).toHaveBeenCalledWith('admin_send_churn_save_offer', {
      p_target_user_id: VALID_UUID,
      p_kind: 'annual_3mo_25pct',
      p_reason: 'User expressed intent to cancel subscription',
      p_polar_discount_code: 'SAVE25',
    });

    expect(mockRevalidatePath).toHaveBeenCalledWith(
      `/dashboard/admin/users/${VALID_UUID}/billing`,
    );
    expect(mockRedirect).toHaveBeenCalledWith(`/dashboard/admin/users/${VALID_UUID}/billing`);
  });

  it('(a) passes null for polar_discount_code when field is empty', async () => {
    const { sendChurnSaveOfferAction } = await import('../actions');

    await expect(
      sendChurnSaveOfferAction(
        VALID_UUID,
        makeFormData({
          targetUserId: VALID_UUID,
          kind: 'monthly_1mo_50pct',
          reason: 'User expressed intent to cancel subscription',
          polar_discount_code: '',
        }),
      ),
    ).rejects.toThrow(/NEXT_REDIRECT/);

    const rpcArgs = mockRpc.mock.calls[0][1];
    expect(rpcArgs.p_polar_discount_code).toBeNull();
  });

  // ── (b) URL cross-check mismatch ──────────────────────────────────────────

  it('(b) returns mismatch error and skips RPC when FormData.targetUserId differs from trustedUserId', async () => {
    const { sendChurnSaveOfferAction } = await import('../actions');

    const result = await sendChurnSaveOfferAction(
      VALID_UUID,
      makeFormData({
        targetUserId: VALID_UUID_2,
        kind: 'annual_3mo_25pct',
        reason: 'Tampered form data for wrong user',
      }),
    );

    expect(result).toEqual({ ok: false, error: 'targetUserId mismatch with URL context' });
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockSentryCaptureMessage).toHaveBeenCalledOnce();
    const [, sentryCtx] = mockSentryCaptureMessage.mock.calls[0];
    expect(sentryCtx.tags.admin_action).toBe('send_churn_save_offer');
  });

  // ── (c) Zod validation failures ──────────────────────────────────────────

  it('(c) returns error when kind is invalid', async () => {
    const { sendChurnSaveOfferAction } = await import('../actions');

    const result = await sendChurnSaveOfferAction(
      VALID_UUID,
      makeFormData({
        targetUserId: VALID_UUID,
        kind: 'invalid_offer_kind',
        reason: 'Valid reason here, 10+ chars',
      }),
    );

    expect(result).toMatchObject({ ok: false, field: 'kind' });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('(c) returns error when reason is fewer than 10 chars', async () => {
    const { sendChurnSaveOfferAction } = await import('../actions');

    const result = await sendChurnSaveOfferAction(
      VALID_UUID,
      makeFormData({
        targetUserId: VALID_UUID,
        kind: 'monthly_1mo_50pct',
        reason: 'too short',
      }),
    );

    expect(result).toMatchObject({ ok: false, field: 'reason' });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  // ── (d) SQLSTATE 42501 ────────────────────────────────────────────────────

  it('(d) maps SQLSTATE 42501 to "Not authorized"', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'permission denied' } });

    const { sendChurnSaveOfferAction } = await import('../actions');

    const result = await sendChurnSaveOfferAction(
      VALID_UUID,
      makeFormData({
        targetUserId: VALID_UUID,
        kind: 'annual_3mo_25pct',
        reason: 'Valid reason here, 10+ chars',
      }),
    );

    expect(result).toEqual({ ok: false, error: 'Not authorized' });
    expect(mockSentryCapture).not.toHaveBeenCalled();
  });

  // ── (e) SQLSTATE 22023 → active offer exists ──────────────────────────────

  it('(e) SQLSTATE 22023: returns specific active-offer error (not generic "Invalid input value")', async () => {
    // WHY special-case: 22023 from this RPC specifically means an active offer
    // already exists for this user + kind (partial unique index constraint).
    // The generic mapRpcError message ("Invalid input value") is misleading here;
    // we surface the domain-specific error instead. Carryover spec note.
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: '22023', message: 'active offer exists' } });

    const { sendChurnSaveOfferAction } = await import('../actions');

    const result = await sendChurnSaveOfferAction(
      VALID_UUID,
      makeFormData({
        targetUserId: VALID_UUID,
        kind: 'annual_3mo_25pct',
        reason: 'User wants to cancel, sending offer',
      }),
    );

    expect(result).toEqual({
      ok: false,
      error: 'Active offer already exists for this user + kind',
    });
  });

  // ── (f) Unexpected SQLSTATE ───────────────────────────────────────────────

  it('(f) maps unexpected SQLSTATE to "Internal error" and captures Sentry', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: 'XX999', message: 'unknown' } });

    const { sendChurnSaveOfferAction } = await import('../actions');

    const result = await sendChurnSaveOfferAction(
      VALID_UUID,
      makeFormData({
        targetUserId: VALID_UUID,
        kind: 'monthly_1mo_50pct',
        reason: 'Valid reason here, 10+ chars',
      }),
    );

    expect(result).toMatchObject({ ok: false, error: 'Internal error — check Sentry' });
    expect(mockSentryCapture).toHaveBeenCalledOnce();
    const [, sentryCtx] = mockSentryCapture.mock.calls[0];
    expect(sentryCtx.tags.admin_action).toBe('send_churn_save_offer');
    expect(sentryCtx.tags.sqlstate).toBe('XX999');
  });
});
