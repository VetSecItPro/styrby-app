/**
 * Refund Flow — End-to-End Integration Tests
 *
 * Integration seam: This file exercises the complete issueRefundAction pipeline:
 *   FormData → Zod validation → createPolarRefund (Polar API) → admin_issue_refund
 *   RPC → audit_log row.
 *
 * WHY this exists (Phase 4.3 T7):
 *   T5 unit tests verify individual branches within issueRefundAction. These
 *   integration tests verify the combined contract across the three sub-systems:
 *   Polar refund helper, the SECURITY DEFINER RPC, and the Sentry telemetry.
 *   A regression in the layering (e.g. RPC called before Polar, wrong idempotency
 *   key format, wrong RPC arg names) would survive unit tests but fail here.
 *
 * Cross-task seam verified:
 *   T3 (polar-refund.ts) ↔ T5 (actions.ts): the idempotency key format generated
 *   in issueRefundAction is passed verbatim to createPolarRefund, then the
 *   eventId/refundId returned by the helper is forwarded to the admin_issue_refund
 *   RPC. These tests confirm the data flow across that boundary without hitting
 *   the live Polar API or live Supabase.
 *
 * SOC 2 CC7.2: Audit trail completeness — every successful refund path must
 *   result in admin_issue_refund being called with both polar_event_id and
 *   polar_refund_id. Tests confirm the audit row is never skipped.
 *
 * SOC 2 CC6.1: Invalid inputs (bad amount, tampered userId) are rejected before
 *   any external call is made — Polar is never called for invalid requests.
 *
 * @module __tests__/billing-ops/refund-flow.integration.test
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

// ============================================================================
// Mocks — must be defined before any imports that use them
// ============================================================================

const mockRedirect = vi.fn((url: string) => {
  // WHY throw: Next.js redirect() throws internally to halt execution.
  // Replicating this lets callers test "redirect was reached" via rejects.toThrow.
  throw new Error(`NEXT_REDIRECT:${url}`);
});
const mockRevalidatePath = vi.fn();

vi.mock('next/navigation', () => ({
  redirect: (url: string) => mockRedirect(url),
}));

vi.mock('next/cache', () => ({
  revalidatePath: (path: string) => mockRevalidatePath(path),
}));

vi.mock('next/headers', () => ({
  headers: async () => ({ get: () => null }),
}));

// ── Sentry mock ───────────────────────────────────────────────────────────────
const mockSentryCapture = vi.fn();
const mockSentryCaptureMessage = vi.fn();
vi.mock('@sentry/nextjs', () => ({
  captureException: (...args: unknown[]) => mockSentryCapture(...args),
  captureMessage: (...args: unknown[]) => mockSentryCaptureMessage(...args),
}));

// ── Supabase mock ─────────────────────────────────────────────────────────────
const mockRpc = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  // WHY createClient (user-scoped): admin_issue_refund RPC requires auth.uid()
  // from the admin's JWT — service-role has no JWT context. See actions.ts.
  createClient: vi.fn(),
  createAdminClient: () => ({
    auth: { admin: {} },
  }),
}));

// ── Polar refund helper mock ──────────────────────────────────────────────────
// WHY mock @/lib/billing/polar-refund (not the Polar SDK directly):
//   The integration boundary we're testing is actions.ts ↔ the refund helper +
//   the Supabase RPC. We verify that actions.ts passes the correct args to the
//   helper and uses the helper's return values correctly when calling the RPC.
//   Mocking the helper avoids network calls and lets us control error codes.
const mockCreatePolarRefund = vi.fn();
const mockFindRefundableOrder = vi.fn();
vi.mock('@/lib/billing/polar-refund', () => ({
  createPolarRefund: (...args: unknown[]) => mockCreatePolarRefund(...args),
  // SEC-REFUND-001: actions.ts now resolves the real Polar order ID before
  // calling createPolarRefund. The integration test mocks the resolver too so
  // we can drive the full pipeline through both helpers without hitting Polar.
  findRefundableOrderForSubscription: (...args: unknown[]) =>
    mockFindRefundableOrder(...args),
  // WHY re-export RefundError class: issueRefundAction does `instanceof RefundError`
  // to branch on error type. The mock module must export the real class so that
  // `new RefundError(...)` constructions thrown in tests are recognized by the
  // instanceof check inside the action.
  RefundError: class RefundError extends Error {
    readonly code: string;
    readonly rawBody?: unknown;
    constructor(code: string, message: string, rawBody?: unknown) {
      super(message);
      this.name = 'RefundError';
      this.code = code;
      this.rawBody = rawBody;
    }
  },
}));

// ============================================================================
// Helpers
// ============================================================================

const ADMIN_UUID  = 'a1b2c3d4-e5f6-7890-abcd-000000000001';
const TARGET_UUID = 'b2c3d4e5-f6a7-8901-bcde-000000000002';
const SUB_ID      = 'sub_test_abc123';

/**
 * Builds a FormData object for the refund form with sensible defaults.
 * Any field can be overridden via `overrides`.
 *
 * WHY manual FormData construction: Next.js server actions receive a native
 * FormData. Building it by hand keeps the test readable and matches what the
 * real form would send.
 */
function makeRefundFormData(overrides: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set('targetUserId',   overrides.targetUserId   ?? TARGET_UUID);
  fd.set('subscriptionId', overrides.subscriptionId ?? SUB_ID);
  fd.set('amount_cents',   overrides.amount_cents   ?? '1000');
  fd.set('reason',         overrides.reason         ?? 'customer_request — service outage on 2026-04-20');
  return fd;
}

// ============================================================================
// Tests
// ============================================================================

describe('issueRefundAction — end-to-end refund flow', () => {
  let createClient: Mock;
  // WHY dynamic import: vitest hoists vi.mock calls before imports; dynamic
  // imports inside tests pick up the mocked modules correctly.
  let issueRefundAction: (targetUserId: string, formData: FormData) => Promise<unknown>;

  beforeEach(async () => {
    vi.clearAllMocks();
    // WHY restore createClient each beforeEach: clearAllMocks wipes mockResolvedValue.
    const serverModule = await import('@/lib/supabase/server');
    createClient = serverModule.createClient as Mock;
    // SEC-REFUND-001: client now needs both .rpc (audit RPC) and .from (subscription
    // owner + polar_customer_id lookup before the refund). Default the lookup to a
    // valid row owned by TARGET_UUID so happy-path tests don't re-stub the chain.
    createClient.mockResolvedValue({
      rpc: mockRpc,
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({
              data: { polar_customer_id: 'cus_integration_default', user_id: TARGET_UUID },
              error: null,
            }),
          }),
        }),
      }),
    });
    // SEC-REFUND-001: order resolver — default returns ample refundable balance
    // so amount checks don't trip on the default. Tests that want the resolver
    // to throw or return a tight balance override per-case.
    mockFindRefundableOrder.mockResolvedValue({
      orderId: 'ord_integration_default',
      refundableCents: 100_000,
    });

    const actionsModule = await import(
      '../../app/dashboard/admin/users/[userId]/billing/actions'
    );
    issueRefundAction = actionsModule.issueRefundAction;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── (1) Happy path: full end-to-end refund ────────────────────────────────

  it('(1) happy path: Polar called with correct args, RPC called with polar IDs, redirect fires', async () => {
    const fakePolarResponse = { id: 'ref_abc', eventId: 'evt_abc', rawResponse: { status: 'succeeded' } };
    mockCreatePolarRefund.mockResolvedValueOnce({
      refundId: 'ref_abc123',
      eventId:  'evt_abc123',
      rawResponse: fakePolarResponse,
    });
    // RPC returns audit_id (non-zero).
    mockRpc.mockResolvedValueOnce({ data: 42, error: null });

    await expect(
      issueRefundAction(TARGET_UUID, makeRefundFormData())
    ).rejects.toThrow(/NEXT_REDIRECT/);

    // 1a. Polar helper called with correct subscriptionId, amountCents, reason.
    expect(mockCreatePolarRefund).toHaveBeenCalledOnce();
    const polarArgs = mockCreatePolarRefund.mock.calls[0]![0] as Record<string, unknown>;
    expect(polarArgs.subscriptionId).toBe(SUB_ID);
    expect(polarArgs.amountCents).toBe(1000);
    expect(polarArgs.reason).toContain('customer_request');

    // 1b. Idempotency key format: <targetUserId>:<subscriptionId>:<amountCents>:<minuteTimestamp>
    expect(typeof polarArgs.idempotencyKey).toBe('string');
    const keyParts = (polarArgs.idempotencyKey as string).split(':');
    expect(keyParts[0]).toBe(TARGET_UUID);
    expect(keyParts[1]).toBe(SUB_ID);
    expect(keyParts[2]).toBe('1000');
    // WHY check divisibility: the key's timestamp is rounded to minute boundaries.
    expect(Number(keyParts[3]) % 60_000).toBe(0);

    // 1c. RPC called with Polar IDs from the helper response (8 params — migration 051 signature).
    expect(mockRpc).toHaveBeenCalledOnce();
    expect(mockRpc).toHaveBeenCalledWith('admin_issue_refund', {
      p_target_user_id:         TARGET_UUID,
      p_amount_cents:           1000,
      p_currency:               'usd',
      p_reason:                 expect.stringContaining('customer_request'),
      p_polar_event_id:         'evt_abc123',
      p_polar_refund_id:        'ref_abc123',
      p_polar_subscription_id:  SUB_ID,
      p_polar_response_json:    fakePolarResponse,
    });

    // 1d. Redirect to billing dossier, no Sentry fires.
    expect(mockSentryCapture).not.toHaveBeenCalled();
    expect(mockSentryCaptureMessage).not.toHaveBeenCalled();
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      `/dashboard/admin/users/${TARGET_UUID}/billing`
    );
  });

  // ── (2) Polar 'invalid' error → 400, RPC not called ─────────────────────

  it("(2) Polar 'invalid' error → { ok: false }, RPC not called", async () => {
    const { RefundError } = await import('@/lib/billing/polar-refund');
    mockCreatePolarRefund.mockRejectedValueOnce(
      new RefundError('invalid', 'amount exceeds original charge')
    );

    const result = await issueRefundAction(TARGET_UUID, makeRefundFormData()) as { ok: boolean; error: string };

    // WHY not throw: 'invalid' is a user-recoverable condition — action returns { ok: false }.
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Polar rejected');
    // RPC must NOT be called — no audit row for a failed refund.
    expect(mockRpc).not.toHaveBeenCalled();
    // WHY no Sentry: 'invalid' is a 4xx (expected failure) — not an ops alert.
    expect(mockSentryCapture).not.toHaveBeenCalled();
  });

  // ── (3) Polar 'idempotent-replay' (409 from Polar) → success, RPC proceeds ─

  it("(3) Polar 'idempotent-replay' → treats as success, RPC called with placeholder IDs, audit written", async () => {
    const { RefundError } = await import('@/lib/billing/polar-refund');
    mockCreatePolarRefund.mockRejectedValueOnce(
      new RefundError('idempotent-replay', 'refund already issued')
    );
    // RPC still succeeds — the audit row may be a duplicate INSERT (ON CONFLICT DO NOTHING)
    // but the action must still attempt it to close the audit gap.
    mockRpc.mockResolvedValueOnce({ data: 77, error: null });

    await expect(
      issueRefundAction(TARGET_UUID, makeRefundFormData())
    ).rejects.toThrow(/NEXT_REDIRECT/);

    // RPC IS called even for idempotent replays.
    expect(mockRpc).toHaveBeenCalledOnce();
    const rpcArgs = mockRpc.mock.calls[0]![1] as Record<string, unknown>;
    // WHY placeholder IDs: when polar replay occurs, we use sentinel values
    // that the webhook handler's ON CONFLICT DO NOTHING guard already handled.
    expect(rpcArgs.p_polar_event_id).toBe('idempotent-replay');
    expect(rpcArgs.p_polar_refund_id).toBe('idempotent-replay');
    // No Sentry for idempotent replay — this is an expected condition.
    expect(mockSentryCapture).not.toHaveBeenCalled();
  });

  // ── (4) Idempotent replay: second call with same sub+amount within 1 min ──

  it('(4) same sub+amount within the same minute → same idempotency key → Polar deduplicates', async () => {
    // WHY fake timers: we want to confirm both calls in the same minute window
    // produce the same idempotency key, which is how Polar deduplication works.
    vi.useFakeTimers();
    const fixedMs = 1_745_500_000_000; // 2026-04-24T10:26:40.000Z
    vi.setSystemTime(fixedMs);

    mockCreatePolarRefund.mockResolvedValue({
      refundId: 'ref_idem',
      eventId:  'evt_idem',
      rawResponse: {},
    });
    mockRpc.mockResolvedValue({ data: 50, error: null });

    // First call.
    await expect(issueRefundAction(TARGET_UUID, makeRefundFormData())).rejects.toThrow(/NEXT_REDIRECT/);
    const key1 = (mockCreatePolarRefund.mock.calls[0]![0] as Record<string, unknown>).idempotencyKey as string;

    vi.clearAllMocks();
    // Re-stub the full client shape (rpc + from) since clearAllMocks wiped it.
    createClient.mockResolvedValue({
      rpc: mockRpc,
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({
              data: { polar_customer_id: 'cus_integration_default', user_id: TARGET_UUID },
              error: null,
            }),
          }),
        }),
      }),
    });
    mockFindRefundableOrder.mockResolvedValue({
      orderId: 'ord_integration_default',
      refundableCents: 100_000,
    });
    mockCreatePolarRefund.mockResolvedValue({
      refundId: 'ref_idem',
      eventId:  'evt_idem',
      rawResponse: {},
    });
    mockRpc.mockResolvedValue({ data: 50, error: null });

    // Second call — still within the same minute window.
    await expect(issueRefundAction(TARGET_UUID, makeRefundFormData())).rejects.toThrow(/NEXT_REDIRECT/);
    const key2 = (mockCreatePolarRefund.mock.calls[0]![0] as Record<string, unknown>).idempotencyKey as string;

    expect(key1).toBe(key2);

    vi.useRealTimers();
  });

  // ── (5) RPC returns 0 (audit orphan) → Sentry warn, action returns success ─

  it('(5) RPC returns audit_id=0 → Sentry captureMessage at warning, action still succeeds', async () => {
    mockCreatePolarRefund.mockResolvedValueOnce({
      refundId: 'ref_orphan',
      eventId:  'evt_orphan',
      rawResponse: {},
    });
    // WHY auditId=0: admin_issue_refund returns 0 when the polar_refund_events
    // row already existed (ON CONFLICT DO NOTHING) and the audit row was not written.
    // This is the "audit orphan" condition — money moved but audit is missing.
    mockRpc.mockResolvedValueOnce({ data: 0, error: null });

    await expect(
      issueRefundAction(TARGET_UUID, makeRefundFormData())
    ).rejects.toThrow(/NEXT_REDIRECT/);

    // Sentry MUST fire at 'warning' level — ops needs to investigate the gap.
    expect(mockSentryCaptureMessage).toHaveBeenCalledOnce();
    const captureArgs = mockSentryCaptureMessage.mock.calls[0] as unknown[];
    expect(captureArgs[0]).toMatch(/audit orphan/i);

    // WHY action still succeeds: the refund was issued by Polar. Failing the action
    // would confuse the admin into re-submitting, which could cause a double refund.
    // The audit gap is an ops issue, not an admin-facing error.
  });

  // ── (6) Polar 'polar-error' (5xx) → Sentry capture, { ok: false } ────────

  it("(6) Polar 'polar-error' (5xx) → Sentry captured, { ok: false }, RPC not called", async () => {
    const { RefundError } = await import('@/lib/billing/polar-refund');
    mockCreatePolarRefund.mockRejectedValueOnce(
      new RefundError('polar-error', 'Polar API 503')
    );

    const result = await issueRefundAction(TARGET_UUID, makeRefundFormData()) as { ok: boolean; error: string };

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Polar temporarily unavailable');
    expect(mockRpc).not.toHaveBeenCalled();
    // WHY Sentry: polar-error is a platform issue that ops should investigate.
    expect(mockSentryCapture).toHaveBeenCalledOnce();
  });

  // ── (7) Zod validation — invalid amount_cents ─────────────────────────────

  it('(7) invalid amount_cents (zero) → Zod rejects BEFORE Polar call', async () => {
    const result = await issueRefundAction(
      TARGET_UUID,
      makeRefundFormData({ amount_cents: '0' })
    ) as { ok: boolean; error: string };

    expect(result.ok).toBe(false);
    // Neither Polar nor RPC should be called for invalid input.
    expect(mockCreatePolarRefund).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  // ── (8) targetUserId mismatch → rejected before Polar call ───────────────

  it('(8) targetUserId URL/FormData mismatch → { ok: false }, no Polar call, Sentry warns', async () => {
    const DIFFERENT_UUID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

    const result = await issueRefundAction(
      TARGET_UUID,
      makeRefundFormData({ targetUserId: DIFFERENT_UUID })
    ) as { ok: boolean; error: string };

    expect(result.ok).toBe(false);
    expect(result.error).toContain('mismatch');
    expect(mockCreatePolarRefund).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockSentryCaptureMessage).toHaveBeenCalledOnce();
  });

  // ── (9) RPC returns SQLSTATE 42501 → "Not authorized" ────────────────────

  it('(9) RPC returns 42501 (non-admin) → { ok: false, error: "Not authorized" }', async () => {
    mockCreatePolarRefund.mockResolvedValueOnce({
      refundId: 'ref_unauth',
      eventId:  'evt_unauth',
      rawResponse: {},
    });
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: '42501' } });

    const result = await issueRefundAction(TARGET_UUID, makeRefundFormData()) as { ok: boolean; error: string };

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Not authorized');
  });

  // ── (10) Polar 'network' error → Sentry capture, { ok: false } ───────────

  it("(10) Polar 'network' timeout → Sentry captured, { ok: false }, RPC not called", async () => {
    const { RefundError } = await import('@/lib/billing/polar-refund');
    mockCreatePolarRefund.mockRejectedValueOnce(
      new RefundError('network', 'AbortSignal timeout')
    );

    const result = await issueRefundAction(TARGET_UUID, makeRefundFormData()) as { ok: boolean; error: string };

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Internal error');
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockSentryCapture).toHaveBeenCalledOnce();
  });
});
