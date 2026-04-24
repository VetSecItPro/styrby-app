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

// WHY mock redirect as throwing: Next.js redirect() throws a special error
// internally to abort the current function. We replicate this so tests can
// assert "redirect was called" without needing a full Next.js render context.
const mockRedirect = vi.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`);
});
const mockRevalidatePath = vi.fn();

vi.mock('next/navigation', () => ({
  redirect: (url: string) => mockRedirect(url),
}));

vi.mock('next/cache', () => ({
  revalidatePath: (path: string) => mockRevalidatePath(path),
}));

// ─── Sentry mock ─────────────────────────────────────────────────────────────

const mockSentryCapture = vi.fn();
const mockSentryCaptureMessage = vi.fn();
vi.mock('@sentry/nextjs', () => ({
  captureException: (...args: unknown[]) => mockSentryCapture(...args),
  captureMessage: (...args: unknown[]) => mockSentryCaptureMessage(...args),
}));

// ─── Supabase mock ───────────────────────────────────────────────────────────

/**
 * Configurable mock for Supabase clients.
 *
 * WHY createClient is plain vi.fn() (not .mockResolvedValue in factory):
 *   vi.mock factories are hoisted to the top of the file by Vitest. At hoist
 *   time, mockRpc is not yet initialized — referencing it inside the factory
 *   body causes "Cannot access before initialization". We set the resolved
 *   value in beforeEach() instead, after all const declarations are live.
 */
const mockRpc = vi.fn();

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
const mockCreatePolarRefund = vi.fn();

vi.mock('@/lib/billing/polar-refund', () => {
  // WHY define RefundError in the factory: the action imports and instanceof-
  // checks RefundError. If we mock the module, the imported class must match
  // what the action's import resolves to. Defining it in the factory ensures
  // both the action and the test see the same class reference.
  class RefundError extends Error {
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
    createPolarRefund: (...args: unknown[]) => mockCreatePolarRefund(...args),
    RefundError,
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
    // createClient must return an object with rpc so actions can call it.
    (createClient as Mock).mockResolvedValue({ rpc: mockRpc });
    // Default Polar success
    mockCreatePolarRefund.mockResolvedValue(DEFAULT_POLAR_RESPONSE);
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

  it('(r2) Polar invalid: returns { ok: false, error: Polar rejected: ... }, no Sentry', async () => {
    // WHY no Sentry: 'invalid' is a 4xx — the request was malformed. Expected
    // failure condition, not an infrastructure issue.
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
    expect((result as { ok: false; error: string }).error).toMatch(/Polar rejected/);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockSentryCapture).not.toHaveBeenCalled();
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
