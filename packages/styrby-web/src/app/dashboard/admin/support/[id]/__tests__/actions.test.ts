/**
 * Tests for requestSupportAccessAction — actions.ts
 *
 * Phase 4.2 — Support Tooling T4
 *
 * Coverage:
 *   (a) Zod validation — invalid inputs return { ok: false, field } without calling the RPC
 *   (b) SQLSTATE mapping — 42501 → "Not authorized", 22023 → "Invalid session…",
 *       23514 → "Reason is required", unknown → "Internal error" + Sentry
 *   (c) Happy path — calls RPC with correct args; sets cookie; redirects to success URL
 *   (d) Cross-user session rejection — 22023 from RPC for session belonging to different user
 *   (e) Bad ticket ID mismatch via URL binding — trustedTicketId !== URL context
 *       NOTE: the action trusts trustedTicketId from .bind() — there is no
 *       FormData ticket_id field (unlike Phase 4.1's userId cross-check), so
 *       the "bad ticket ID" test validates that the trustedTicketId bound at
 *       page render time is what reaches the RPC (not a tampered value).
 *   (f) raw token is NEVER included in the returned action result or Sentry extras
 *   (g) expires_in_hours bounds — 0 and 169 rejected; 1 and 168 accepted
 *   (h) reason bounds — < 10 chars rejected; 10 chars accepted; > 500 chars rejected
 *
 * Testing strategy:
 *   - Mock next/headers, next/cache, next/navigation, next/headers (cookies)
 *   - Mock @/lib/supabase/server createClient
 *   - Mock @/lib/support/token generateSupportToken
 *   - Mock @sentry/nextjs
 *   - Call action directly with FormData objects
 *
 * SOC 2 CC6.1 / CC7.2: admin action contract (auth check, audit, token safety)
 * is fully covered so compliance reviews can reference test output.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ────────────────────────────────────────────────────────────────────

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

// Static header values for deterministic IP + UA assertions.
const MOCK_XFF = '203.0.113.5, 10.0.0.1';
const MOCK_UA = 'Mozilla/5.0 test-support-agent';

const mockHeadersGet = vi.fn((name: string) => {
  if (name === 'x-forwarded-for') return MOCK_XFF;
  if (name === 'user-agent') return MOCK_UA;
  return null;
});

// WHY separate cookiesSet mock: we need to assert that the raw token was
// written to the cookie without having access to the raw token value (since
// we also mock generateSupportToken). We assert the cookie NAME and that
// the value is the raw token returned by the mock.
const mockCookiesSet = vi.fn();

vi.mock('next/headers', () => ({
  headers: async () => ({ get: mockHeadersGet }),
  cookies: async () => ({ set: mockCookiesSet }),
}));

// ─── Sentry mock ──────────────────────────────────────────────────────────────

const mockSentryCaptureException = vi.fn();
const mockSentryCaptureMessage = vi.fn();
vi.mock('@sentry/nextjs', () => ({
  captureException: (...args: unknown[]) => mockSentryCaptureException(...args),
  captureMessage: (...args: unknown[]) => mockSentryCaptureMessage(...args),
}));

// ─── Token mock ────────────────────────────────────────────────────────────────

const MOCK_RAW_TOKEN = 'mock-raw-token-aabbccdd-1122-3344-5566-778899aabbcc';
const MOCK_HASH = 'mock-sha256-hash-hex-64chars-aaaaaaaaaaaaaaaaaaaaaaaaaaaa0000';

vi.mock('@/lib/support/token', () => ({
  generateSupportToken: vi.fn(() => ({ raw: MOCK_RAW_TOKEN, hash: MOCK_HASH })),
}));

// ─── Supabase mock ────────────────────────────────────────────────────────────

// WHY mockRpc is separate: tests need to configure return values per-test.
// The factory cannot reference it directly (hoisting issue), so we set
// the resolved value in beforeEach after all consts are live (Fix P0 pattern).
const mockRpc = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}));

import { createClient } from '@/lib/supabase/server';
import type { Mock } from 'vitest';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Builds a FormData from a plain record.
 * WHY: FormData is the contract for Next.js server actions.
 *
 * @param entries - Key-value pairs to append.
 * @returns Populated FormData.
 */
function makeFormData(entries: Record<string, string | null | undefined>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    if (value != null) fd.append(key, value);
  }
  return fd;
}

const VALID_TICKET_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const VALID_SESSION_ID = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
const VALID_GRANT_ID = '42';

/** Minimal valid form data for happy-path tests. */
function validFormData(overrides: Record<string, string> = {}): FormData {
  return makeFormData({
    session_id: VALID_SESSION_ID,
    reason: 'User reported cost spike — investigating session tool call pattern.',
    expires_in_hours: '24',
    ...overrides,
  });
}

// ─── Test suites ──────────────────────────────────────────────────────────────

describe('requestSupportAccessAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // WHY set here (not in factory): see Fix P0 note above.
    (createClient as Mock).mockResolvedValue({ rpc: mockRpc });
    // Default happy-path RPC response.
    mockRpc.mockResolvedValue({ data: VALID_GRANT_ID, error: null });
  });

  // ── (a) Zod validation ─────────────────────────────────────────────────────

  it('(a) rejects invalid session_id UUID', async () => {
    const { requestSupportAccessAction } = await import('../actions');

    const result = await requestSupportAccessAction(
      VALID_TICKET_ID,
      makeFormData({
        session_id: 'not-a-uuid',
        reason: 'Valid reason with enough characters.',
        expires_in_hours: '24',
      })
    );

    expect(result).toMatchObject({ ok: false, field: 'session_id' });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('(a) rejects reason shorter than 10 chars', async () => {
    const { requestSupportAccessAction } = await import('../actions');

    const result = await requestSupportAccessAction(
      VALID_TICKET_ID,
      makeFormData({
        session_id: VALID_SESSION_ID,
        reason: 'Short',
        expires_in_hours: '24',
      })
    );

    expect(result).toMatchObject({ ok: false, field: 'reason' });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('(h) accepts reason of exactly 10 chars', async () => {
    const { requestSupportAccessAction } = await import('../actions');

    await expect(
      requestSupportAccessAction(
        VALID_TICKET_ID,
        makeFormData({
          session_id: VALID_SESSION_ID,
          reason: '1234567890',
          expires_in_hours: '24',
        })
      )
    ).rejects.toThrow(/NEXT_REDIRECT/);

    expect(mockRpc).toHaveBeenCalledOnce();
  });

  it('(h) rejects reason longer than 500 chars', async () => {
    const { requestSupportAccessAction } = await import('../actions');

    const result = await requestSupportAccessAction(
      VALID_TICKET_ID,
      makeFormData({
        session_id: VALID_SESSION_ID,
        reason: 'A'.repeat(501),
        expires_in_hours: '24',
      })
    );

    expect(result).toMatchObject({ ok: false, field: 'reason' });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('(g) rejects expires_in_hours = 0', async () => {
    const { requestSupportAccessAction } = await import('../actions');

    const result = await requestSupportAccessAction(
      VALID_TICKET_ID,
      makeFormData({
        session_id: VALID_SESSION_ID,
        reason: 'Valid reason with enough characters.',
        expires_in_hours: '0',
      })
    );

    expect(result).toMatchObject({ ok: false, field: 'expires_in_hours' });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('(g) rejects expires_in_hours = 169', async () => {
    const { requestSupportAccessAction } = await import('../actions');

    const result = await requestSupportAccessAction(
      VALID_TICKET_ID,
      makeFormData({
        session_id: VALID_SESSION_ID,
        reason: 'Valid reason with enough characters.',
        expires_in_hours: '169',
      })
    );

    expect(result).toMatchObject({ ok: false, field: 'expires_in_hours' });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('(g) accepts expires_in_hours = 1 (boundary)', async () => {
    const { requestSupportAccessAction } = await import('../actions');

    await expect(
      requestSupportAccessAction(VALID_TICKET_ID, validFormData({ expires_in_hours: '1' }))
    ).rejects.toThrow(/NEXT_REDIRECT/);

    expect(mockRpc).toHaveBeenCalledOnce();
  });

  it('(g) accepts expires_in_hours = 168 (boundary)', async () => {
    const { requestSupportAccessAction } = await import('../actions');

    await expect(
      requestSupportAccessAction(VALID_TICKET_ID, validFormData({ expires_in_hours: '168' }))
    ).rejects.toThrow(/NEXT_REDIRECT/);

    expect(mockRpc).toHaveBeenCalledOnce();
  });

  // ── (b) SQLSTATE mapping ───────────────────────────────────────────────────

  it('(b) maps SQLSTATE 42501 to "Not authorized"', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: '42501' } });
    const { requestSupportAccessAction } = await import('../actions');

    const result = await requestSupportAccessAction(VALID_TICKET_ID, validFormData());

    expect(result).toEqual({ ok: false, error: 'Not authorized' });
  });

  it('(b) maps SQLSTATE 22023 to invalid-session message', async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { code: '22023', message: 'session does not belong to ticket user' },
    });
    const { requestSupportAccessAction } = await import('../actions');

    const result = await requestSupportAccessAction(VALID_TICKET_ID, validFormData());

    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toContain('Invalid session');
  });

  it('(b) maps SQLSTATE 23514 to "Reason is required"', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: '23514' } });
    const { requestSupportAccessAction } = await import('../actions');

    const result = await requestSupportAccessAction(VALID_TICKET_ID, validFormData());

    expect(result).toEqual({ ok: false, error: 'Reason is required' });
  });

  it('(b) maps unknown SQLSTATE to "Internal error" and captures Sentry', async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { code: 'P0001', message: 'unexpected rpc error' },
    });
    const { requestSupportAccessAction } = await import('../actions');

    const result = await requestSupportAccessAction(VALID_TICKET_ID, validFormData());

    expect(result).toMatchObject({ ok: false, error: 'Internal error — check Sentry' });
    expect(mockSentryCaptureException).toHaveBeenCalledOnce();
    const [, sentryCtx] = mockSentryCaptureException.mock.calls[0];
    expect(sentryCtx.tags.admin_action).toBe('request_support_access');
  });

  // ── (c) Happy path ─────────────────────────────────────────────────────────

  it('(c) calls RPC with correct args including IP, UA, token hash, and expiry', async () => {
    const { requestSupportAccessAction } = await import('../actions');

    await expect(
      requestSupportAccessAction(VALID_TICKET_ID, validFormData())
    ).rejects.toThrow(/NEXT_REDIRECT/);

    expect(mockRpc).toHaveBeenCalledWith('admin_request_support_access', {
      p_ticket_id: VALID_TICKET_ID,
      p_session_id: VALID_SESSION_ID,
      p_reason: 'User reported cost spike — investigating session tool call pattern.',
      p_expires_in_hours: 24,
      p_token_hash: MOCK_HASH,
      p_ip: '203.0.113.5',
      p_ua: MOCK_UA,
    });
  });

  it('(c) sets the one-time cookie with the raw token on success', async () => {
    const { requestSupportAccessAction } = await import('../actions');

    await expect(
      requestSupportAccessAction(VALID_TICKET_ID, validFormData())
    ).rejects.toThrow(/NEXT_REDIRECT/);

    expect(mockCookiesSet).toHaveBeenCalledOnce();
    const [cookieName, cookieValue, cookieOptions] = mockCookiesSet.mock.calls[0];
    expect(cookieName).toBe('support_grant_token_once');
    expect(cookieValue).toBe(MOCK_RAW_TOKEN);
    // WHY verify maxAge: short-lived cookie is critical for security — the
    // token self-destructs within 60 seconds even if the admin doesn't navigate.
    expect(cookieOptions.maxAge).toBe(60);
    expect(cookieOptions.httpOnly).toBe(false);
  });

  it('(c) redirects to success page with grant ID', async () => {
    const { requestSupportAccessAction } = await import('../actions');

    await expect(
      requestSupportAccessAction(VALID_TICKET_ID, validFormData())
    ).rejects.toThrow(/NEXT_REDIRECT/);

    expect(mockRedirect).toHaveBeenCalledWith(
      `/dashboard/admin/support/${VALID_TICKET_ID}/request-access/success?grant=${VALID_GRANT_ID}`
    );
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      `/dashboard/admin/support/${VALID_TICKET_ID}`
    );
  });

  // ── (d) Cross-user session rejection via RPC ───────────────────────────────

  it('(d) returns invalid-session error when RPC raises 22023 (cross-user session)', async () => {
    // WHY: the RPC enforces session.user_id === ticket.user_id. A 22023 from
    // the RPC means the admin tried to cross-wire a session to a different
    // user's ticket. This must surface as a safe user-facing error.
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { code: '22023', message: 'session user_id does not match ticket user_id' },
    });
    const { requestSupportAccessAction } = await import('../actions');

    const result = await requestSupportAccessAction(VALID_TICKET_ID, validFormData());

    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toContain('Invalid session');
    expect(mockCookiesSet).not.toHaveBeenCalled();
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  // ── (e) Ticket ID binding integrity ───────────────────────────────────────

  it('(e) passes the trustedTicketId from .bind() to the RPC — not any FormData value', async () => {
    // WHY: the ticket ID flows only from the bound argument (trustedTicketId),
    // never from FormData. FormData has no ticket_id field, so a tampered form
    // cannot change which ticket the grant is created for. We verify the RPC
    // receives the trustedTicketId passed to the action.
    const ANOTHER_TICKET = 'ffffffff-1111-2222-3333-444444444444';
    const { requestSupportAccessAction } = await import('../actions');

    await expect(
      requestSupportAccessAction(ANOTHER_TICKET, validFormData())
    ).rejects.toThrow(/NEXT_REDIRECT/);

    expect(mockRpc).toHaveBeenCalledWith(
      'admin_request_support_access',
      expect.objectContaining({ p_ticket_id: ANOTHER_TICKET })
    );
  });

  // ── (f) Raw token never in result or Sentry extras ────────────────────────

  it('(f) does not include raw token in the Sentry extras on RPC error', async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { code: 'P0001', message: 'unexpected' },
    });
    const { requestSupportAccessAction } = await import('../actions');

    await requestSupportAccessAction(VALID_TICKET_ID, validFormData());

    // The Sentry call must not include the raw token in any field.
    const sentryExtra = mockSentryCaptureException.mock.calls[0]?.[1]?.extra ?? {};
    const sentryStr = JSON.stringify(sentryExtra);
    expect(sentryStr).not.toContain(MOCK_RAW_TOKEN);
  });

  it('(f) does not include raw token in the action return value on error', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: '42501' } });
    const { requestSupportAccessAction } = await import('../actions');

    const result = await requestSupportAccessAction(VALID_TICKET_ID, validFormData());

    // Serialize result and check raw token is absent.
    const resultStr = JSON.stringify(result);
    expect(resultStr).not.toContain(MOCK_RAW_TOKEN);
  });
});
