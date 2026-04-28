/**
 * Admin Console — Server Actions Integration Tests
 *
 * Integration seam: This file exercises the full server-action pipeline —
 * FormData → Zod validation → RPC call → response — for all three admin
 * mutations (overrideTierAction, resetPasswordAction, toggleConsentAction).
 * Each action is tested at the "form submits, what does the whole flow do?"
 * level, not just individual sub-functions.
 *
 * WHY this exists (Phase 4.1 T9):
 *   The existing actions.test.ts covers unit-level branching within each action.
 *   These integration tests verify the combined Zod → RPC contract: specifically
 *   that invalid inputs are caught BEFORE the RPC is called, that SQLSTATE 42501
 *   surfaces as 403-equivalent (not 500), and that URL cross-check mismatch is
 *   enforced pre-RPC. A regression in the layering could let bad input reach the
 *   DB or let the DB error leak raw messages to the client.
 *
 * What phase it tests: Phase 4.1 (Admin Console — T4 server actions + T9
 * integration coverage).
 *
 * SOC 2 CC6.1: Admin mutations require three layers of defence. These tests
 * confirm all three fire in the correct order (URL-check → Zod → RPC).
 * SOC 2 CC7.2: Audit trail integrity — RPC is called only after all app-layer
 * guards pass, so the audit row is never written for an invalid/tampered form.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// ============================================================================
// Mocks
// ============================================================================

const mockRedirect = vi.fn((url: string) => {
  // WHY throw: Next.js redirect() throws internally to abort the function.
  // We replicate this so assertions on "redirect was called" work correctly.
  throw new Error(`NEXT_REDIRECT:${url}`);
});
const mockRevalidatePath = vi.fn();

vi.mock('next/navigation', () => ({
  redirect: (url: string) => mockRedirect(url),
}));

vi.mock('next/cache', () => ({
  revalidatePath: (path: string) => mockRevalidatePath(path),
}));

const MOCK_XFF = '10.10.0.1, 172.16.0.1';
const MOCK_UA  = 'Mozilla/5.0 integration-test-agent';

const mockHeadersGet = vi.fn((name: string) => {
  if (name === 'x-forwarded-for') return MOCK_XFF;
  if (name === 'user-agent') return MOCK_UA;
  return null;
});

vi.mock('next/headers', () => ({
  headers: async () => ({ get: mockHeadersGet }),
}));

const mockSentryCapture = vi.fn();
const mockSentryCaptureMessage = vi.fn();
vi.mock('@sentry/nextjs', () => ({
  captureException: (...args: unknown[]) => mockSentryCapture(...args),
  captureMessage: (...args: unknown[]) => mockSentryCaptureMessage(...args),
}));

// WHY mock mfa-gate: the actions.integration tests mock createClient to return
// only the rpc mock (for the user-scoped client). assertAdminMfa calls
// createAdminClient to query site_admins + passkeys. Without this mock, the
// MFA gate would fail-closed on every action test. MFA behavior is covered
// in __tests__/admin/mfa-gate.test.ts. OWASP A07:2021, SOC 2 CC6.1.
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

// ── Supabase mock ─────────────────────────────────────────────────────────────
const mockRpc = vi.fn();
const mockGenerateLink = vi.fn();
const mockGetUserById = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  // WHY createClient returns rpc (Fix P0): admin_* RPCs are now called on the
  // user-scoped client so auth.uid() resolves inside SECURITY DEFINER functions.
  // Service-role has no JWT context → auth.uid() = NULL → 42501 in prod.
  // createClient factory is plain vi.fn() here to avoid hoisting issues — the
  // resolved value with {rpc: mockRpc} is set in each beforeEach() below.
  createClient: vi.fn(),
  // WHY createAdminClient retains only auth.admin methods: getUserById and
  // generateLink require service-role privilege; they stay on the admin client.
  createAdminClient: () => ({
    auth: {
      admin: {
        generateLink: mockGenerateLink,
        getUserById: mockGetUserById,
      },
    },
  }),
}));

// ============================================================================
// Helpers
// ============================================================================

const VALID_UUID   = 'c1d2e3f4-a5b6-7890-cdef-123456789abc';
const VALID_UUID_2 = 'd2e3f4a5-b6c7-8901-defa-234567890bcd';

// Import mocked module so beforeEach can restore createClient's resolved value.
// WHY import after vi.mock: Vitest hoists vi.mock to top of file; this import
// receives the mocked version. Fix P0: createClient is now the RPC client.
import { createClient } from '@/lib/supabase/server';

/**
 * Builds a FormData object from a plain record.
 *
 * @param entries - Key-value pairs to add to the FormData.
 * @returns FormData instance.
 */
function makeFormData(entries: Record<string, string | null | undefined>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    if (value != null) fd.append(key, value);
  }
  return fd;
}

// ============================================================================
// overrideTierAction — integration tests
// ============================================================================

describe('overrideTierAction — integration (form → Zod → RPC)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // WHY restore createClient: clearAllMocks wipes mockResolvedValue.
    // Fix P0: createClient (user-scoped) is the RPC client for admin_* RPCs.
    (createClient as Mock).mockResolvedValue({
      rpc: mockRpc,
      // WHY auth.getUser stub: the MFA gate block in each action calls
      // supabase.auth.getUser() to resolve the acting admin's ID before calling
      // assertAdminMfa(). assertAdminMfa is mocked to return undefined (see
      // vi.mock('@/lib/admin/mfa-gate') above), so the gate itself is bypassed.
      // But the auth.getUser() call still happens — without this stub the mock
      // returns undefined for .auth, causing a TypeError. OWASP A07:2021.
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: { id: 'admin-uuid-001' } },
          error: null,
        }),
      },
    });
    mockHeadersGet.mockImplementation((name: string) => {
      if (name === 'x-forwarded-for') return MOCK_XFF;
      if (name === 'user-agent') return MOCK_UA;
      return null;
    });
  });

  // ── (a) Happy path with mocked RPC return ─────────────────────────────────

  it('(a) happy path: calls RPC with correct params and redirects', async () => {
    const auditId = 55;
    mockRpc.mockResolvedValueOnce({ data: auditId, error: null });

    const { overrideTierAction } = await import(
      '../../app/dashboard/admin/users/[userId]/actions'
    );

    await expect(
      overrideTierAction(
        VALID_UUID,
        makeFormData({
          targetUserId: VALID_UUID,
          newTier: 'power',
          reason: 'annual deal signed',
        })
      )
    ).rejects.toThrow(/NEXT_REDIRECT/);

    // RPC was called with the correct parameters.
    expect(mockRpc).toHaveBeenCalledOnce();
    expect(mockRpc).toHaveBeenCalledWith('admin_override_tier', {
      p_target_user_id: VALID_UUID,
      p_new_tier:       'power',
      p_expires_at:     null,
      p_reason:         'annual deal signed',
      p_ip:             '10.10.0.1', // first entry in MOCK_XFF
      p_ua:             MOCK_UA,
    });

    // Redirect and revalidate run after the RPC succeeds.
    expect(mockRevalidatePath).toHaveBeenCalledWith(`/dashboard/admin/users/${VALID_UUID}`);
    expect(mockRedirect).toHaveBeenCalledWith(`/dashboard/admin/users/${VALID_UUID}`);
  });

  // ── (b) Non-admin rejected via SQLSTATE 42501 → 403 ──────────────────────

  it('(b) SQLSTATE 42501 from RPC → { ok: false, error: "Not authorized" } — 403 equivalent', async () => {
    // WHY: SQLSTATE 42501 = INSUFFICIENT_PRIVILEGE. The SECURITY DEFINER RPC
    // detected the caller is not a site admin at the DB layer. This must
    // surface as "Not authorized" — never as a raw SQL error.
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { code: '42501', message: 'permission denied for function admin_override_tier' },
    });

    const { overrideTierAction } = await import(
      '../../app/dashboard/admin/users/[userId]/actions'
    );

    const result = await overrideTierAction(
      VALID_UUID,
      makeFormData({ targetUserId: VALID_UUID, newTier: 'enterprise', reason: 'bypass attempt' })
    );

    expect(result).toEqual({ ok: false, error: 'Not authorized' });
    // Sentry must NOT be called for 42501 — it is an expected auth failure,
    // not an unexpected server error.
    expect(mockSentryCapture).not.toHaveBeenCalled();
    // No redirect on failure.
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  // ── (c) Invalid input rejected by Zod BEFORE RPC call ────────────────────

  it('(c) Zod rejects invalid newTier BEFORE calling RPC', async () => {
    const { overrideTierAction } = await import(
      '../../app/dashboard/admin/users/[userId]/actions'
    );

    const result = await overrideTierAction(
      VALID_UUID,
      makeFormData({ targetUserId: VALID_UUID, newTier: 'superadmin', reason: 'test' })
    );

    // Zod caught the invalid tier — RPC was never called.
    expect(result).toMatchObject({ ok: false, field: 'newTier' });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('(c) Zod rejects empty reason BEFORE calling RPC', async () => {
    const { overrideTierAction } = await import(
      '../../app/dashboard/admin/users/[userId]/actions'
    );

    const result = await overrideTierAction(
      VALID_UUID,
      makeFormData({ targetUserId: VALID_UUID, newTier: 'pro', reason: '' })
    );

    expect(result).toMatchObject({ ok: false, field: 'reason' });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  // ── (d) URL cross-check mismatch rejected before RPC ──────────────────────

  it('(d) URL cross-check: mismatch between trustedUserId and FormData.targetUserId → no RPC', async () => {
    // WHY: trustedUserId is bound from the URL server-side (unforgeable). If
    // FormData.targetUserId differs, the admin is being tricked into acting on
    // the wrong user. We reject before any RPC, Zod, or DB contact. Fix B.
    const { overrideTierAction } = await import(
      '../../app/dashboard/admin/users/[userId]/actions'
    );

    const result = await overrideTierAction(
      VALID_UUID,
      makeFormData({ targetUserId: VALID_UUID_2, newTier: 'pro', reason: 'tampered form' })
    );

    expect(result).toEqual({ ok: false, error: 'targetUserId mismatch with URL context' });
    expect(mockRpc).not.toHaveBeenCalled();
    // Sentry captures the attempted mismatch as a warning.
    expect(mockSentryCaptureMessage).toHaveBeenCalledOnce();
  });
});

// ============================================================================
// resetPasswordAction — integration tests
// ============================================================================

describe('resetPasswordAction — integration (form → Zod → RPC → generateLink)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // WHY restore createClient: clearAllMocks wipes mockResolvedValue.
    // Fix P0: admin_record_password_reset RPC uses user-scoped client.
    (createClient as Mock).mockResolvedValue({
      rpc: mockRpc,
      // WHY auth.getUser stub: the MFA gate block in each action calls
      // supabase.auth.getUser() to resolve the acting admin's ID before calling
      // assertAdminMfa(). assertAdminMfa is mocked to return undefined (see
      // vi.mock('@/lib/admin/mfa-gate') above), so the gate itself is bypassed.
      // But the auth.getUser() call still happens — without this stub the mock
      // returns undefined for .auth, causing a TypeError. OWASP A07:2021.
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: { id: 'admin-uuid-001' } },
          error: null,
        }),
      },
    });
    mockHeadersGet.mockImplementation((name: string) => {
      if (name === 'x-forwarded-for') return MOCK_XFF;
      if (name === 'user-agent') return MOCK_UA;
      return null;
    });
    // Default: getUserById returns a valid user.
    mockGetUserById.mockResolvedValue({
      data: { user: { id: VALID_UUID, email: 'user@example.com' } },
      error: null,
    });
  });

  // ── (a) Happy path ────────────────────────────────────────────────────────

  it('(a) happy path: getUserById → RPC (audit) → generateLink → redirect', async () => {
    const auditId = 99;
    mockRpc.mockResolvedValueOnce({ data: auditId, error: null });
    mockGenerateLink.mockResolvedValueOnce({ data: {}, error: null });

    const { resetPasswordAction } = await import(
      '../../app/dashboard/admin/users/[userId]/actions'
    );

    await expect(
      resetPasswordAction(
        VALID_UUID,
        makeFormData({ targetUserId: VALID_UUID, reason: 'user locked out' })
      )
    ).rejects.toThrow(/NEXT_REDIRECT/);

    // Order: getUserById first, then RPC (audit), then generateLink.
    const rpcOrder    = mockRpc.mock.invocationCallOrder[0];
    const linkOrder   = mockGenerateLink.mock.invocationCallOrder[0];
    const userOrder   = mockGetUserById.mock.invocationCallOrder[0];

    // getUserById runs before RPC (email resolution before audit write).
    expect(userOrder).toBeLessThan(rpcOrder);
    // RPC (audit row) is written before the magic link is sent. SOC 2 CC7.2.
    expect(rpcOrder).toBeLessThan(linkOrder);

    // generateLink receives the trusted email (from getUserById, not FormData).
    expect(mockGenerateLink).toHaveBeenCalledWith({
      type:  'recovery',
      email: 'user@example.com',
    });
  });

  // ── (b) SQLSTATE 42501 → "Not authorized" ────────────────────────────────

  it('(b) SQLSTATE 42501 from RPC → { ok: false, error: "Not authorized" }, no generateLink', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: '42501' } });

    const { resetPasswordAction } = await import(
      '../../app/dashboard/admin/users/[userId]/actions'
    );

    const result = await resetPasswordAction(
      VALID_UUID,
      makeFormData({ targetUserId: VALID_UUID, reason: 'locked out' })
    );

    expect(result).toEqual({ ok: false, error: 'Not authorized' });
    // generateLink must NOT be called when the audit RPC failed.
    // WHY: sending a magic link without an audit row breaks SOC 2 CC7.2.
    expect(mockGenerateLink).not.toHaveBeenCalled();
  });

  // ── (c) Zod rejects invalid input BEFORE RPC ─────────────────────────────

  it('(c) Zod rejects invalid targetUserId BEFORE RPC and generateLink', async () => {
    const { resetPasswordAction } = await import(
      '../../app/dashboard/admin/users/[userId]/actions'
    );

    const result = await resetPasswordAction(
      VALID_UUID,
      makeFormData({ targetUserId: 'not-a-uuid', reason: 'test' })
    );

    // The UUID is also the trustedUserId mismatch check, so it fires first.
    // Either way RPC must not be called.
    expect(result).toMatchObject({ ok: false });
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockGenerateLink).not.toHaveBeenCalled();
  });

  it('(c) Zod rejects empty reason BEFORE calling RPC', async () => {
    const { resetPasswordAction } = await import(
      '../../app/dashboard/admin/users/[userId]/actions'
    );

    const result = await resetPasswordAction(
      VALID_UUID,
      makeFormData({ targetUserId: VALID_UUID, reason: '' })
    );

    expect(result).toMatchObject({ ok: false, field: 'reason' });
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockGenerateLink).not.toHaveBeenCalled();
  });

  // ── (d) URL cross-check mismatch rejected before RPC ──────────────────────

  it('(d) URL cross-check mismatch → no audit write, no generateLink', async () => {
    const { resetPasswordAction } = await import(
      '../../app/dashboard/admin/users/[userId]/actions'
    );

    const result = await resetPasswordAction(
      VALID_UUID,
      makeFormData({ targetUserId: VALID_UUID_2, reason: 'tampered' })
    );

    expect(result).toEqual({ ok: false, error: 'targetUserId mismatch with URL context' });
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockGenerateLink).not.toHaveBeenCalled();
    // Sentry records the tamper attempt.
    expect(mockSentryCaptureMessage).toHaveBeenCalledOnce();
  });
});

// ============================================================================
// toggleConsentAction — integration tests
// ============================================================================

describe('toggleConsentAction — integration (form → Zod → RPC)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // WHY restore createClient: clearAllMocks wipes mockResolvedValue.
    // Fix P0: admin_toggle_consent RPC uses user-scoped client.
    (createClient as Mock).mockResolvedValue({
      rpc: mockRpc,
      // WHY auth.getUser stub: the MFA gate block in each action calls
      // supabase.auth.getUser() to resolve the acting admin's ID before calling
      // assertAdminMfa(). assertAdminMfa is mocked to return undefined (see
      // vi.mock('@/lib/admin/mfa-gate') above), so the gate itself is bypassed.
      // But the auth.getUser() call still happens — without this stub the mock
      // returns undefined for .auth, causing a TypeError. OWASP A07:2021.
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: { id: 'admin-uuid-001' } },
          error: null,
        }),
      },
    });
    mockHeadersGet.mockImplementation((name: string) => {
      if (name === 'x-forwarded-for') return MOCK_XFF;
      if (name === 'user-agent') return MOCK_UA;
      return null;
    });
  });

  // ── (a) Happy path ────────────────────────────────────────────────────────

  it('(a) happy path: valid form → RPC called → redirect', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: null });

    const { toggleConsentAction } = await import(
      '../../app/dashboard/admin/users/[userId]/actions'
    );

    await expect(
      toggleConsentAction(
        VALID_UUID,
        makeFormData({
          targetUserId: VALID_UUID,
          purpose:      'support_read_metadata',
          grant:        'true',
          reason:       'support ticket open',
        })
      )
    ).rejects.toThrow(/NEXT_REDIRECT/);

    expect(mockRpc).toHaveBeenCalledOnce();
    expect(mockRpc).toHaveBeenCalledWith('admin_toggle_consent', {
      p_target_user_id: VALID_UUID,
      p_purpose:        'support_read_metadata',
      p_grant:          true,
      p_reason:         'support ticket open',
      p_ip:             '10.10.0.1',
      p_ua:             MOCK_UA,
    });
  });

  // ── (b) SQLSTATE 42501 → "Not authorized" ────────────────────────────────

  it('(b) SQLSTATE 42501 from RPC → { ok: false, error: "Not authorized" }', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: '42501' } });

    const { toggleConsentAction } = await import(
      '../../app/dashboard/admin/users/[userId]/actions'
    );

    const result = await toggleConsentAction(
      VALID_UUID,
      makeFormData({
        targetUserId: VALID_UUID,
        purpose:      'support_read_metadata',
        grant:        'true',
        reason:       'test',
      })
    );

    expect(result).toEqual({ ok: false, error: 'Not authorized' });
  });

  // ── (c) Zod rejects invalid input BEFORE RPC ─────────────────────────────

  it('(c) Zod rejects invalid purpose BEFORE calling RPC', async () => {
    const { toggleConsentAction } = await import(
      '../../app/dashboard/admin/users/[userId]/actions'
    );

    const result = await toggleConsentAction(
      VALID_UUID,
      makeFormData({
        targetUserId: VALID_UUID,
        purpose:      'nonexistent_purpose',
        grant:        'true',
        reason:       'test',
      })
    );

    expect(result).toMatchObject({ ok: false, field: 'purpose' });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('(c) Zod rejects invalid grant value BEFORE calling RPC', async () => {
    const { toggleConsentAction } = await import(
      '../../app/dashboard/admin/users/[userId]/actions'
    );

    const result = await toggleConsentAction(
      VALID_UUID,
      makeFormData({
        targetUserId: VALID_UUID,
        purpose:      'support_read_metadata',
        grant:        'yes_please', // invalid — must be "true" or "false"
        reason:       'test',
      })
    );

    expect(result).toMatchObject({ ok: false, field: 'grant' });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  // ── (d) URL cross-check mismatch rejected before RPC ──────────────────────

  it('(d) URL cross-check mismatch → no RPC call', async () => {
    const { toggleConsentAction } = await import(
      '../../app/dashboard/admin/users/[userId]/actions'
    );

    const result = await toggleConsentAction(
      VALID_UUID,
      makeFormData({
        targetUserId: VALID_UUID_2, // mismatch
        purpose:      'support_read_metadata',
        grant:        'true',
        reason:       'tampered',
      })
    );

    expect(result).toEqual({ ok: false, error: 'targetUserId mismatch with URL context' });
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockSentryCaptureMessage).toHaveBeenCalledOnce();
  });
});
