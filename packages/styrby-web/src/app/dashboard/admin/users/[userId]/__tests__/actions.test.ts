/**
 * Tests for admin server actions — actions.ts
 *
 * Covers for each action (overrideTierAction, resetPasswordAction, toggleConsentAction):
 *   (a) Zod validation — invalid input returns { ok: false, field } without calling RPC
 *   (b) SQLSTATE mapping — 42501 → "Not authorized", 22023 → "Invalid input value",
 *       23514 → "Reason is required", unknown → "Internal error"
 *   (c) Happy path — calls RPC with correct args including IP + UA from headers
 *   (d) resetPassword-specific — audit-first then magic link; magic-link failure returns
 *       { ok: true, warning } and calls Sentry
 *   (e) C1 tamper resistance — resetPasswordAction ignores any targetEmail in FormData;
 *       generateLink is called with the Auth Admin API email, not the FormData value
 *   (f) Fix B URL cross-check — for each action: trustedUserId vs FormData mismatch
 *       → { ok: false, error: 'targetUserId mismatch with URL context' } without RPC call
 *   (g) Fix A banned/deleted guard — resetPasswordAction: banned user → { ok: true, warning }
 *       with no generateLink call; deleted user → same pattern
 *
 * Testing strategy:
 *   - Mock next/headers, next/cache, next/navigation
 *   - Mock @/lib/supabase/server createAdminClient
 *   - Mock @sentry/nextjs
 *   - Call actions directly with a FormData object
 *   - Assert mock calls and return values
 *
 * WHY we mock redirect() to throw:
 *   In production, redirect() throws a special Next.js error to interrupt the
 *   current render. We replicate that to verify actions call redirect on success
 *   without the test hanging on a missing render context.
 *
 * SOC 2 CC6.1 / CC7.2: every mutation path (happy + error) is tested so we can
 * assert the audit trail contract (RPC always called before magic link, etc.).
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

// WHY static header values: tests need deterministic IP + UA assertions.
const MOCK_XFF = '203.0.113.1, 10.0.0.1';
const MOCK_UA = 'Mozilla/5.0 test-agent';

const mockHeadersGet = vi.fn((name: string) => {
  if (name === 'x-forwarded-for') return MOCK_XFF;
  if (name === 'user-agent') return MOCK_UA;
  return null;
});

vi.mock('next/headers', () => ({
  headers: async () => ({
    get: mockHeadersGet,
  }),
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
 * Configurable mocks for the Supabase clients.
 *
 * Fix P0 client routing:
 *   - createClient() (user-scoped) is now used for ALL admin_* RPC calls
 *     (admin_override_tier, admin_toggle_consent, admin_record_password_reset).
 *     The RPC's SECURITY DEFINER body calls is_site_admin(auth.uid()). With
 *     service-role there is no JWT context → auth.uid() = NULL → 42501.
 *     User-scoped client forwards the session cookie so auth.uid() resolves.
 *   - createAdminClient() (service-role) is still used for:
 *       - auth.admin.getUserById() — requires service-role privilege
 *       - auth.admin.generateLink() — requires service-role privilege
 *
 * WHY mockGetUserById (C1):
 *   resetPasswordAction now fetches the target email server-side via getUserById()
 *   instead of reading it from FormData. We mock this so we can verify the email
 *   passed to generateLink() comes from the API response, not FormData.
 */
const mockRpc = vi.fn();
const mockGenerateLink = vi.fn();
const mockGetUserById = vi.fn();

// WHY mock mfa-gate (H42 Layer 1): every admin action now calls
// `assertAdminMfa(actingAdmin.id)` before running its RPC. Without this mock
// the gate would call createAdminClient → site_admins lookup, which is not
// stubbed at unit-test layer. Mirrors src/__tests__/admin/actions.integration.test.ts.
// MFA gate behavior itself is covered in src/lib/admin/__tests__/mfa-gate.test.ts;
// these unit tests assert each action wires the gate correctly via dedicated
// `(MFA)` test cases below. OWASP A07:2021, SOC 2 CC6.1.
vi.mock('@/lib/admin/mfa-gate', () => ({
  assertAdminMfa: vi.fn().mockResolvedValue(undefined),
  AdminMfaRequiredError: class AdminMfaRequiredError extends Error {
    statusCode = 403 as const;
    code = 'ADMIN_MFA_REQUIRED' as const;
    constructor() {
      super('Admin MFA required');
      this.name = 'AdminMfaRequiredError';
    }
  },
}));

vi.mock('@/lib/supabase/server', () => ({
  // WHY createClient is plain vi.fn() here (not .mockResolvedValue):
  //   vi.mock factories are hoisted to the top of the file by Vitest. At hoist
  //   time, mockRpc/mockGenerateLink/mockGetUserById are not yet initialized —
  //   referencing them inside the factory body causes "Cannot access before
  //   initialization". We set the resolved value in beforeEach() instead, after
  //   all const declarations are live. Fix P0.
  createClient: vi.fn(),
  // WHY createAdminClient retains auth.admin methods: getUserById and
  // generateLink require service-role privilege; they stay on admin client.
  // mockGetUserById/mockGenerateLink are referenced via closure and are always
  // initialized by the time the factory executes (they're const declarations
  // outside the factory, not inside it).
  createAdminClient: () => ({
    auth: {
      admin: {
        generateLink: mockGenerateLink,
        getUserById: mockGetUserById,
      },
    },
  }),
}));

// Import mocked modules so tests can assert on them.
// WHY import after vi.mock: Vitest hoists vi.mock calls to the top, so these
// imports get the mocked versions regardless of declaration order in the file.
import { createClient, createAdminClient } from '@/lib/supabase/server';
import { assertAdminMfa, AdminMfaRequiredError } from '@/lib/admin/mfa-gate';
import type { Mock } from 'vitest';

const ACTING_ADMIN_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Builds an `auth.getUser()` stub for the mocked Supabase client.
 * WHY: H42 Layer 1 added `supabase.auth.getUser()` calls inside every admin action
 * to capture the acting admin for the MFA gate. Returning a real admin user
 * (rather than null) means the gate is genuinely exercised on every test path —
 * `assertAdminMfa` (mocked at module level) runs and resolves by default,
 * proving the gate is wired correctly. Per-case overrides simulate gate failure
 * via `(assertAdminMfa as Mock).mockRejectedValueOnce(new AdminMfaRequiredError())`.
 */
function makeAuthMock() {
  return {
    getUser: vi.fn().mockResolvedValue({
      data: { user: { id: ACTING_ADMIN_ID, email: 'admin@styrby.test' } },
    }),
  };
}

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

// ─── overrideTierAction ──────────────────────────────────────────────────────

describe('overrideTierAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // WHY restore after clearAllMocks: clearAllMocks wipes mockResolvedValue.
    // createClient must return an object with rpc so actions can call it.
    // Fix P0: createClient (user-scoped) is now the RPC client for all admin_* calls.
    (createClient as Mock).mockResolvedValue({ rpc: mockRpc, auth: makeAuthMock() });
  });

  // ── (a) Zod validation ────────────────────────────────────────────────────

  it('(a) returns error with field when targetUserId is not a UUID', async () => {
    const { overrideTierAction } = await import('../actions');

    const result = await overrideTierAction(
      VALID_UUID,
      makeFormData({ targetUserId: 'not-a-uuid', newTier: 'pro', reason: 'test' })
    );

    expect(result).toMatchObject({ ok: false });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('(a) returns error with field when newTier is invalid', async () => {
    const { overrideTierAction } = await import('../actions');

    const result = await overrideTierAction(
      VALID_UUID,
      makeFormData({ targetUserId: VALID_UUID, newTier: 'invalid_tier', reason: 'test' })
    );

    expect(result).toMatchObject({ ok: false, field: 'newTier' });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('(a) returns error with field when reason is empty', async () => {
    const { overrideTierAction } = await import('../actions');

    const result = await overrideTierAction(
      VALID_UUID,
      makeFormData({ targetUserId: VALID_UUID, newTier: 'pro', reason: '' })
    );

    expect(result).toMatchObject({ ok: false, field: 'reason' });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('(a) returns error when reason exceeds 500 chars', async () => {
    const { overrideTierAction } = await import('../actions');

    const result = await overrideTierAction(
      VALID_UUID,
      makeFormData({ targetUserId: VALID_UUID, newTier: 'pro', reason: 'x'.repeat(501) })
    );

    expect(result).toMatchObject({ ok: false, field: 'reason' });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  // ── (b) SQLSTATE mapping ──────────────────────────────────────────────────

  it('(b) maps SQLSTATE 42501 to "Not authorized"', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'permission denied' } });

    const { overrideTierAction } = await import('../actions');
    const result = await overrideTierAction(
      VALID_UUID,
      makeFormData({ targetUserId: VALID_UUID, newTier: 'enterprise', reason: 'test reason' })
    );

    expect(result).toEqual({ ok: false, error: 'Not authorized' });
    expect(mockSentryCapture).not.toHaveBeenCalled();
  });

  it('(b) maps SQLSTATE 22023 to "Invalid input value"', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: '22023', message: 'invalid value' } });

    const { overrideTierAction } = await import('../actions');
    const result = await overrideTierAction(
      VALID_UUID,
      makeFormData({ targetUserId: VALID_UUID, newTier: 'free', reason: 'test reason' })
    );

    expect(result).toEqual({ ok: false, error: 'Invalid input value' });
  });

  it('(b) maps SQLSTATE 23514 to "Reason is required"', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: '23514', message: 'check violation' } });

    const { overrideTierAction } = await import('../actions');
    const result = await overrideTierAction(
      VALID_UUID,
      makeFormData({ targetUserId: VALID_UUID, newTier: 'free', reason: 'test reason' })
    );

    expect(result).toEqual({ ok: false, error: 'Reason is required' });
  });

  it('(b) maps unknown SQLSTATE to "Internal error" and captures Sentry', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: 'XX000', message: 'something went wrong' } });

    const { overrideTierAction } = await import('../actions');
    const result = await overrideTierAction(
      VALID_UUID,
      makeFormData({ targetUserId: VALID_UUID, newTier: 'team', reason: 'test reason' })
    );

    expect(result).toMatchObject({ ok: false, error: 'Internal error — check Sentry' });
    expect(mockSentryCapture).toHaveBeenCalledOnce();
    // Sentry call must tag admin_action correctly.
    const [, sentryCtx] = mockSentryCapture.mock.calls[0];
    expect(sentryCtx.tags.admin_action).toBe('override_tier');
    expect(sentryCtx.tags.sqlstate).toBe('XX000');
  });

  // ── (c) Happy path ────────────────────────────────────────────────────────

  it('(c) calls RPC with correct args including IP + UA from headers', async () => {
    const auditId = 42;
    mockRpc.mockResolvedValueOnce({ data: auditId, error: null });

    const { overrideTierAction } = await import('../actions');

    await expect(
      overrideTierAction(
        VALID_UUID,
        makeFormData({
          targetUserId: VALID_UUID,
          newTier: 'power',
          expiresAt: '2027-01-01T00:00:00.000Z',
          reason: 'sales deal',
        })
      )
    ).rejects.toThrow(/NEXT_REDIRECT/);

    expect(mockRpc).toHaveBeenCalledWith('admin_override_tier', {
      p_target_user_id: VALID_UUID,
      p_new_tier: 'power',
      p_expires_at: '2027-01-01T00:00:00.000Z',
      p_reason: 'sales deal',
      // WHY check first IP only: extractIP() takes the first entry in x-forwarded-for.
      p_ip: '203.0.113.1',
      p_ua: MOCK_UA,
    });

    expect(mockRevalidatePath).toHaveBeenCalledWith(`/dashboard/admin/users/${VALID_UUID}`);
    expect(mockRedirect).toHaveBeenCalledWith(`/dashboard/admin/users/${VALID_UUID}`);
  });

  it('(c) passes null expiresAt when field is empty', async () => {
    mockRpc.mockResolvedValueOnce({ data: 1, error: null });

    const { overrideTierAction } = await import('../actions');

    // No expiresAt in the FormData = treated as permanent
    await expect(
      overrideTierAction(
        VALID_UUID,
        makeFormData({ targetUserId: VALID_UUID, newTier: 'enterprise', reason: 'perm override' })
      )
    ).rejects.toThrow(/NEXT_REDIRECT/);

    const rpcArgs = mockRpc.mock.calls[0][1];
    expect(rpcArgs.p_expires_at).toBeNull();
  });

  it('(c) passes null IP when x-forwarded-for header is missing', async () => {
    mockHeadersGet.mockImplementation((name: string) => {
      if (name === 'user-agent') return MOCK_UA;
      return null; // no x-forwarded-for
    });

    mockRpc.mockResolvedValueOnce({ data: 1, error: null });

    const { overrideTierAction } = await import('../actions');

    await expect(
      overrideTierAction(
        VALID_UUID,
        makeFormData({ targetUserId: VALID_UUID, newTier: 'free', reason: 'test reason' })
      )
    ).rejects.toThrow(/NEXT_REDIRECT/);

    const rpcArgs = mockRpc.mock.calls[0][1];
    expect(rpcArgs.p_ip).toBeNull();
  });

  // ── (f) Fix B: URL vs FormData cross-check ────────────────────────────────

  it('(f) returns mismatch error and skips RPC when FormData.targetUserId differs from trustedUserId', async () => {
    // WHY: an admin visiting /users/<VALID_UUID>/override-tier whose form was
    // tampered to send VALID_UUID_2 should get a hard error, not a silent mutation
    // on the wrong user. Fix B, threat review round 2.
    const { overrideTierAction } = await import('../actions');

    const result = await overrideTierAction(
      VALID_UUID,
      makeFormData({ targetUserId: VALID_UUID_2, newTier: 'pro', reason: 'tampered' })
    );

    expect(result).toEqual({ ok: false, error: 'targetUserId mismatch with URL context' });
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockSentryCaptureMessage).toHaveBeenCalledOnce();
    const [, sentryCtx] = mockSentryCaptureMessage.mock.calls[0];
    expect(sentryCtx.tags.admin_action).toBe('override_tier');
  });

  // ── (P0 regression guard) Client routing ─────────────────────────────────

  it('(P0) RPC is called on user-scoped createClient, NOT via createAdminClient', async () => {
    // WHY this test: guards against regression back to service-role for RPC calls.
    // The SECURITY DEFINER RPC calls is_site_admin(auth.uid()). Service-role has
    // no JWT context → auth.uid() = NULL → 42501 in prod. User-scoped client
    // forwards the admin session cookie so auth.uid() resolves correctly.
    // Fix P0 — we verify (a) createClient was awaited for the RPC, and (b) the
    // RPC was invoked on the client returned by createClient (i.e. mockRpc).
    const auditId = 99;
    mockRpc.mockResolvedValueOnce({ data: auditId, error: null });

    const { overrideTierAction } = await import('../actions');

    await expect(
      overrideTierAction(
        VALID_UUID,
        makeFormData({ targetUserId: VALID_UUID, newTier: 'power', reason: 'P0 guard test' })
      )
    ).rejects.toThrow(/NEXT_REDIRECT/);

    // (a) createClient must have been called — user-scoped client was used.
    expect(createClient).toHaveBeenCalled();
    // (b) The RPC was invoked on the mock returned by createClient (mockRpc).
    //     If the code regresses to createAdminClient, mockRpc would not be called
    //     (createAdminClient has no rpc property in the mock setup).
    expect(mockRpc).toHaveBeenCalledWith('admin_override_tier', expect.any(Object));
  });

  // ── (MFA gate) H42 Layer 1 wiring proof ───────────────────────────────────
  // WHY this test exists: the action calls assertAdminMfa(actingAdmin.id) before
  // running the RPC. If a future refactor moves the gate or skips it, this test
  // catches it — the RPC must NOT execute when the gate throws.
  it('(MFA gate) returns ADMIN_MFA_REQUIRED and skips RPC when assertAdminMfa throws', async () => {
    (assertAdminMfa as Mock).mockRejectedValueOnce(new AdminMfaRequiredError());

    const { overrideTierAction } = await import('../actions');
    const result = await overrideTierAction(
      VALID_UUID,
      makeFormData({ targetUserId: VALID_UUID, newTier: 'pro', reason: 'test reason' })
    );

    expect(result).toEqual({ ok: false, error: 'ADMIN_MFA_REQUIRED' });
    expect(assertAdminMfa).toHaveBeenCalledWith(ACTING_ADMIN_ID);
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

// ─── resetPasswordAction ─────────────────────────────────────────────────────

describe('resetPasswordAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // WHY restore after clearAllMocks: createClient must return {rpc} for RPC calls.
    // Fix P0: user-scoped client is now the RPC client for admin_record_password_reset.
    (createClient as Mock).mockResolvedValue({ rpc: mockRpc, auth: makeAuthMock() });
    // Restore header mock to return valid values by default.
    mockHeadersGet.mockImplementation((name: string) => {
      if (name === 'x-forwarded-for') return MOCK_XFF;
      if (name === 'user-agent') return MOCK_UA;
      return null;
    });
    // Default getUserById returns a user with a specific email. Tests that need
    // to simulate different emails or errors override this per-test.
    mockGetUserById.mockResolvedValue({
      data: { user: { id: VALID_UUID, email: 'trusted@example.com' } },
      error: null,
    });
  });

  // ── (a) Zod validation ────────────────────────────────────────────────────

  it('(a) returns error when targetUserId is not a UUID', async () => {
    const { resetPasswordAction } = await import('../actions');

    const result = await resetPasswordAction(
      VALID_UUID,
      makeFormData({ targetUserId: 'bad-id', reason: 'test' })
    );

    expect(result).toMatchObject({ ok: false });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('(a) returns error when reason is missing', async () => {
    const { resetPasswordAction } = await import('../actions');

    const result = await resetPasswordAction(
      VALID_UUID,
      makeFormData({ targetUserId: VALID_UUID, reason: '' })
    );

    expect(result).toMatchObject({ ok: false, field: 'reason' });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('(a) returns error when getUserById fails (user not found)', async () => {
    mockGetUserById.mockResolvedValueOnce({
      data: null,
      error: new Error('user not found'),
    });

    const { resetPasswordAction } = await import('../actions');
    const result = await resetPasswordAction(
      VALID_UUID,
      makeFormData({ targetUserId: VALID_UUID, reason: 'test' })
    );

    expect(result).toEqual({ ok: false, error: 'Target user not found' });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  // ── (b) SQLSTATE mapping ──────────────────────────────────────────────────

  it('(b) maps SQLSTATE 42501 from RPC to "Not authorized"', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: '42501' } });

    const { resetPasswordAction } = await import('../actions');
    const result = await resetPasswordAction(
      VALID_UUID,
      makeFormData({ targetUserId: VALID_UUID, reason: 'test' })
    );

    expect(result).toEqual({ ok: false, error: 'Not authorized' });
    // Magic link must NOT be called if RPC failed.
    expect(mockGenerateLink).not.toHaveBeenCalled();
  });

  it('(b) maps SQLSTATE 22023 from RPC to "Invalid input value"', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: '22023', message: 'invalid param' } });

    const { resetPasswordAction } = await import('../actions');
    const result = await resetPasswordAction(
      VALID_UUID,
      makeFormData({ targetUserId: VALID_UUID, reason: 'test' })
    );

    expect(result).toEqual({ ok: false, error: 'Invalid input value' });
    expect(mockGenerateLink).not.toHaveBeenCalled();
  });

  it('(b) maps SQLSTATE 23514 from RPC to "Reason is required"', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: '23514', message: 'check violation' } });

    const { resetPasswordAction } = await import('../actions');
    const result = await resetPasswordAction(
      VALID_UUID,
      makeFormData({ targetUserId: VALID_UUID, reason: 'test' })
    );

    expect(result).toEqual({ ok: false, error: 'Reason is required' });
    expect(mockGenerateLink).not.toHaveBeenCalled();
  });

  // ── (c) Happy path ────────────────────────────────────────────────────────

  it('(c) calls getUserById, then RPC, then generateLink in order', async () => {
    const auditId = 99;
    mockRpc.mockResolvedValueOnce({ data: auditId, error: null });
    mockGenerateLink.mockResolvedValueOnce({ data: {}, error: null });

    const { resetPasswordAction } = await import('../actions');

    await expect(
      resetPasswordAction(
        VALID_UUID,
        makeFormData({ targetUserId: VALID_UUID, reason: 'locked out' })
      )
    ).rejects.toThrow(/NEXT_REDIRECT/);

    // WHY audit-first assertion: The audit row must be written BEFORE the
    // magic link is sent. SOC 2 CC7.2 requires the intent to be recorded
    // even if delivery fails. We verify the call ORDER here.
    const rpcCallOrder = mockRpc.mock.invocationCallOrder[0];
    const linkCallOrder = mockGenerateLink.mock.invocationCallOrder[0];
    expect(rpcCallOrder).toBeLessThan(linkCallOrder);

    expect(mockRpc).toHaveBeenCalledWith('admin_record_password_reset', {
      p_target_user_id: VALID_UUID,
      p_reason: 'locked out',
      p_ip: '203.0.113.1',
      p_ua: MOCK_UA,
    });

    // WHY trusted@example.com (not a FormData email): the mock getUserById returns
    // { email: 'trusted@example.com' }. This email — not any FormData value — must
    // be passed to generateLink. C1 fix. T6 quality review #C1.
    expect(mockGenerateLink).toHaveBeenCalledWith({
      type: 'recovery',
      email: 'trusted@example.com',
    });
  });

  // ── (d) magic-link failure after successful audit ─────────────────────────

  it('(d) returns { ok: true, warning } and captures Sentry when magic link fails after audit', async () => {
    const auditId = 77;
    mockRpc.mockResolvedValueOnce({ data: auditId, error: null });
    mockGenerateLink.mockResolvedValueOnce({
      data: null,
      error: new Error('SMTP failure'),
    });

    const { resetPasswordAction } = await import('../actions');
    const result = await resetPasswordAction(
      VALID_UUID,
      makeFormData({ targetUserId: VALID_UUID, reason: 'reset needed' })
    );

    // WHY ok: true with warning: audit is preserved; admin must NOT retry
    // (would create duplicate audit rows). SOC 2 CC7.2.
    expect(result).toMatchObject({
      ok: true,
      warning: expect.stringContaining(String(auditId)),
    });

    // Sentry must be called with the audit_id tag for reconciliation.
    expect(mockSentryCapture).toHaveBeenCalledOnce();
    const [, sentryCtx] = mockSentryCapture.mock.calls[0];
    expect(sentryCtx.tags.admin_action).toBe('reset_password');
    expect(sentryCtx.tags.audit_id).toBe(String(auditId));

    // No redirect (admin needs to see the warning).
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  // ── (e) C1 tamper-resistance ───────────────────────────────────────────────

  it('(e) C1: ignores tampered targetEmail in FormData — uses Auth Admin API email', async () => {
    // Simulate a tampered FormData where an attacker appended their own email.
    // The mock getUserById returns a DIFFERENT trusted email ('trusted@example.com').
    // We assert that generateLink is called with the trusted email, not the tampered one.
    const auditId = 200;
    mockRpc.mockResolvedValueOnce({ data: auditId, error: null });
    mockGenerateLink.mockResolvedValueOnce({ data: {}, error: null });

    const { resetPasswordAction } = await import('../actions');

    // Attacker appends their email alongside the legitimate targetUserId.
    await expect(
      resetPasswordAction(
        VALID_UUID,
        makeFormData({
          targetUserId: VALID_UUID,
          targetEmail: 'attacker@evil.com',  // tampered — should be ignored
          reason: 'legitimate reason',
        })
      )
    ).rejects.toThrow(/NEXT_REDIRECT/);

    // CRITICAL: generateLink must be called with the Auth Admin API email,
    // not the tampered FormData value. T6 quality review #C1.
    expect(mockGetUserById).toHaveBeenCalledWith(VALID_UUID);
    expect(mockGenerateLink).toHaveBeenCalledWith({
      type: 'recovery',
      email: 'trusted@example.com',  // from getUserById mock, not FormData
    });
    // The tampered email must never reach generateLink.
    const linkCall = mockGenerateLink.mock.calls[0][0];
    expect(linkCall.email).not.toBe('attacker@evil.com');
  });

  // ── (f) Fix B: URL vs FormData cross-check ────────────────────────────────

  it('(f) returns mismatch error and skips all downstream calls when trustedUserId differs from FormData', async () => {
    // WHY: an admin visiting /users/<VALID_UUID>/reset-password whose form was
    // tampered to send VALID_UUID_2 gets a hard error — no audit row, no magic link.
    // Fix B, threat review round 2.
    const { resetPasswordAction } = await import('../actions');

    const result = await resetPasswordAction(
      VALID_UUID,
      makeFormData({ targetUserId: VALID_UUID_2, reason: 'tampered' })
    );

    expect(result).toEqual({ ok: false, error: 'targetUserId mismatch with URL context' });
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockGenerateLink).not.toHaveBeenCalled();
    expect(mockSentryCaptureMessage).toHaveBeenCalledOnce();
    const [, sentryCtx] = mockSentryCaptureMessage.mock.calls[0];
    expect(sentryCtx.tags.admin_action).toBe('reset_password');
  });

  // ── (g) Fix A: banned/deleted guard ──────────────────────────────────────

  it('(g) Fix A: banned user — writes audit row, returns { ok: true, warning }, skips generateLink', async () => {
    // WHY: a banned user should have their intent audited (admin's action is
    // recorded) but the recovery email MUST NOT be sent. Sending a magic link
    // to a banned user would let them regain access through the backdoor.
    // Threat review round 2, Fix A.
    const auditId = 301;
    // Mock getUserById to return a user with a future banned_until timestamp.
    mockGetUserById.mockResolvedValueOnce({
      data: {
        user: {
          id: VALID_UUID,
          email: 'banned@example.com',
          banned_until: '2099-12-31T00:00:00.000Z',  // future date = still banned
        },
      },
      error: null,
    });
    mockRpc.mockResolvedValueOnce({ data: auditId, error: null });

    const { resetPasswordAction } = await import('../actions');
    const result = await resetPasswordAction(
      VALID_UUID,
      makeFormData({ targetUserId: VALID_UUID, reason: 'test reset for banned user' })
    );

    // Audit row must have been written first (intent preserved). SOC 2 CC7.2.
    expect(mockRpc).toHaveBeenCalledWith('admin_record_password_reset', expect.objectContaining({
      p_target_user_id: VALID_UUID,
    }));
    // Recovery link must NOT be sent to a banned user.
    expect(mockGenerateLink).not.toHaveBeenCalled();
    // Warning returned with audit ID so admin can reconcile.
    expect(result).toMatchObject({
      ok: true,
      warning: expect.stringContaining(String(auditId)),
    });
    expect((result as { ok: true; warning?: string }).warning).toMatch(/banned/);
    // Sentry must be notified so ops can triage the blocked attempt.
    expect(mockSentryCaptureMessage).toHaveBeenCalledOnce();
    const [, sentryCtx] = mockSentryCaptureMessage.mock.calls[0];
    expect(sentryCtx.tags.target_status).toBe('banned');
  });

  it('(g) Fix A: soft-deleted user — writes audit row, returns { ok: true, warning }, skips generateLink', async () => {
    // WHY: same reasoning as banned — a deleted user account should not receive
    // a recovery email that could be used to re-access a closed account.
    // Threat review round 2, Fix A.
    const auditId = 302;
    mockGetUserById.mockResolvedValueOnce({
      data: {
        user: {
          id: VALID_UUID,
          email: 'deleted@example.com',
          deleted_at: '2025-01-01T00:00:00.000Z',  // soft-deleted
        },
      },
      error: null,
    });
    mockRpc.mockResolvedValueOnce({ data: auditId, error: null });

    const { resetPasswordAction } = await import('../actions');
    const result = await resetPasswordAction(
      VALID_UUID,
      makeFormData({ targetUserId: VALID_UUID, reason: 'test reset for deleted user' })
    );

    expect(mockRpc).toHaveBeenCalledWith('admin_record_password_reset', expect.objectContaining({
      p_target_user_id: VALID_UUID,
    }));
    expect(mockGenerateLink).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: true,
      warning: expect.stringContaining(String(auditId)),
    });
    expect((result as { ok: true; warning?: string }).warning).toMatch(/deleted/);
    expect(mockSentryCaptureMessage).toHaveBeenCalledOnce();
    const [, sentryCtx] = mockSentryCaptureMessage.mock.calls[0];
    expect(sentryCtx.tags.target_status).toBe('deleted');
  });

  // ── (MFA gate) H42 Layer 1 wiring proof ───────────────────────────────────
  it('(MFA gate) returns ADMIN_MFA_REQUIRED and skips RPC + generateLink when assertAdminMfa throws', async () => {
    (assertAdminMfa as Mock).mockRejectedValueOnce(new AdminMfaRequiredError());

    const { resetPasswordAction } = await import('../actions');
    const result = await resetPasswordAction(
      VALID_UUID,
      makeFormData({ targetUserId: VALID_UUID, reason: 'forgot password' })
    );

    expect(result).toEqual({ ok: false, error: 'ADMIN_MFA_REQUIRED' });
    expect(assertAdminMfa).toHaveBeenCalledWith(ACTING_ADMIN_ID);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockGenerateLink).not.toHaveBeenCalled();
  });
});

// ─── toggleConsentAction ─────────────────────────────────────────────────────

describe('toggleConsentAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // WHY restore after clearAllMocks: createClient must return {rpc} for RPC calls.
    // Fix P0: user-scoped client is now the RPC client for admin_toggle_consent.
    (createClient as Mock).mockResolvedValue({ rpc: mockRpc, auth: makeAuthMock() });
    mockHeadersGet.mockImplementation((name: string) => {
      if (name === 'x-forwarded-for') return MOCK_XFF;
      if (name === 'user-agent') return MOCK_UA;
      return null;
    });
  });

  // ── (a) Zod validation ────────────────────────────────────────────────────

  it('(a) returns error when targetUserId is not a UUID', async () => {
    const { toggleConsentAction } = await import('../actions');

    const result = await toggleConsentAction(
      VALID_UUID,
      makeFormData({
        targetUserId: 'not-uuid',
        purpose: 'support_read_metadata',
        grant: 'true',
        reason: 'test',
      })
    );

    // WHY ok: false but no field check on targetUserId: the mismatch guard fires
    // first (not-uuid !== VALID_UUID), returning mismatch error before Zod runs.
    expect(result).toMatchObject({ ok: false });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('(a) returns error when purpose is invalid', async () => {
    const { toggleConsentAction } = await import('../actions');

    const result = await toggleConsentAction(
      VALID_UUID,
      makeFormData({
        targetUserId: VALID_UUID,
        purpose: 'nonexistent_purpose',
        grant: 'true',
        reason: 'test',
      })
    );

    expect(result).toMatchObject({ ok: false, field: 'purpose' });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('(a) returns error when reason is empty', async () => {
    const { toggleConsentAction } = await import('../actions');

    const result = await toggleConsentAction(
      VALID_UUID,
      makeFormData({
        targetUserId: VALID_UUID,
        purpose: 'support_read_metadata',
        grant: 'true',
        reason: '',
      })
    );

    expect(result).toMatchObject({ ok: false, field: 'reason' });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  // ── (b) SQLSTATE mapping ──────────────────────────────────────────────────

  it('(b) maps SQLSTATE 42501 to "Not authorized"', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: '42501' } });

    const { toggleConsentAction } = await import('../actions');
    const result = await toggleConsentAction(
      VALID_UUID,
      makeFormData({
        targetUserId: VALID_UUID,
        purpose: 'support_read_metadata',
        grant: 'false',
        reason: 'test reason',
      })
    );

    expect(result).toEqual({ ok: false, error: 'Not authorized' });
  });

  it('(b) maps SQLSTATE 22023 to "Invalid input value"', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: '22023', message: 'invalid param' } });

    const { toggleConsentAction } = await import('../actions');
    const result = await toggleConsentAction(
      VALID_UUID,
      makeFormData({
        targetUserId: VALID_UUID,
        purpose: 'support_read_metadata',
        grant: 'true',
        reason: 'test reason',
      })
    );

    expect(result).toEqual({ ok: false, error: 'Invalid input value' });
  });

  it('(b) maps SQLSTATE 23514 to "Reason is required"', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: '23514', message: 'check violation' } });

    const { toggleConsentAction } = await import('../actions');
    const result = await toggleConsentAction(
      VALID_UUID,
      makeFormData({
        targetUserId: VALID_UUID,
        purpose: 'support_read_metadata',
        grant: 'true',
        reason: 'test reason',
      })
    );

    expect(result).toEqual({ ok: false, error: 'Reason is required' });
  });

  it('(b) maps unknown SQLSTATE to "Internal error" and captures Sentry', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: 'P0001', message: 'unexpected' } });

    const { toggleConsentAction } = await import('../actions');
    const result = await toggleConsentAction(
      VALID_UUID,
      makeFormData({
        targetUserId: VALID_UUID,
        purpose: 'support_read_metadata',
        grant: 'true',
        reason: 'test reason',
      })
    );

    expect(result).toMatchObject({ ok: false, error: 'Internal error — check Sentry' });
    expect(mockSentryCapture).toHaveBeenCalledOnce();
    const [, sentryCtx] = mockSentryCapture.mock.calls[0];
    expect(sentryCtx.tags.admin_action).toBe('toggle_consent');
  });

  // ── (c) Happy path ────────────────────────────────────────────────────────

  it('(c) calls RPC with correct args for grant=true', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: null });

    const { toggleConsentAction } = await import('../actions');

    await expect(
      toggleConsentAction(
        VALID_UUID,
        makeFormData({
          targetUserId: VALID_UUID,
          purpose: 'support_read_metadata',
          grant: 'true',
          reason: 'user consented',
        })
      )
    ).rejects.toThrow(/NEXT_REDIRECT/);

    expect(mockRpc).toHaveBeenCalledWith('admin_toggle_consent', {
      p_target_user_id: VALID_UUID,
      p_purpose: 'support_read_metadata',
      p_grant: true,
      p_reason: 'user consented',
      p_ip: '203.0.113.1',
      p_ua: MOCK_UA,
    });

    expect(mockRevalidatePath).toHaveBeenCalledWith(`/dashboard/admin/users/${VALID_UUID}`);
    expect(mockRedirect).toHaveBeenCalledWith(`/dashboard/admin/users/${VALID_UUID}`);
  });

  it('(c) calls RPC with p_grant=false for grant="false"', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: null });

    const { toggleConsentAction } = await import('../actions');

    await expect(
      toggleConsentAction(
        VALID_UUID,
        makeFormData({
          targetUserId: VALID_UUID,
          purpose: 'support_read_metadata',
          grant: 'false',
          reason: 'user revoked consent',
        })
      )
    ).rejects.toThrow(/NEXT_REDIRECT/);

    const rpcArgs = mockRpc.mock.calls[0][1];
    expect(rpcArgs.p_grant).toBe(false);
  });

  // ── (f) Fix B: URL vs FormData cross-check ────────────────────────────────

  it('(f) returns mismatch error and skips RPC when FormData.targetUserId differs from trustedUserId', async () => {
    // WHY: an admin visiting /users/<VALID_UUID>/toggle-consent whose form was
    // tampered to send VALID_UUID_2 gets a hard error with no RPC call.
    // Fix B, threat review round 2.
    const { toggleConsentAction } = await import('../actions');

    const result = await toggleConsentAction(
      VALID_UUID,
      makeFormData({
        targetUserId: VALID_UUID_2,
        purpose: 'support_read_metadata',
        grant: 'true',
        reason: 'tampered',
      })
    );

    expect(result).toEqual({ ok: false, error: 'targetUserId mismatch with URL context' });
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockSentryCaptureMessage).toHaveBeenCalledOnce();
    const [, sentryCtx] = mockSentryCaptureMessage.mock.calls[0];
    expect(sentryCtx.tags.admin_action).toBe('toggle_consent');
  });

  // ── (MFA gate) H42 Layer 1 wiring proof ───────────────────────────────────
  it('(MFA gate) returns ADMIN_MFA_REQUIRED and skips RPC when assertAdminMfa throws', async () => {
    (assertAdminMfa as Mock).mockRejectedValueOnce(new AdminMfaRequiredError());

    const { toggleConsentAction } = await import('../actions');
    const result = await toggleConsentAction(
      VALID_UUID,
      makeFormData({
        targetUserId: VALID_UUID,
        purpose: 'support_read_metadata',
        grant: 'true',
        reason: 'support request',
      })
    );

    expect(result).toEqual({ ok: false, error: 'ADMIN_MFA_REQUIRED' });
    expect(assertAdminMfa).toHaveBeenCalledWith(ACTING_ADMIN_ID);
    expect(mockRpc).not.toHaveBeenCalled();
  });
});
