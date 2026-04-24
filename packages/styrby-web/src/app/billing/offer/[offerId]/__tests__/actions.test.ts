/**
 * Tests for acceptOfferAction — /billing/offer/[offerId]/actions.ts
 *
 * Phase 4.3 — Billing Ops T6
 *
 * Coverage:
 *   (a) Validation — invalid offerId (0, negative, NaN) returns { ok: false }
 *       without calling the RPC
 *   (b) SQLSTATE mapping:
 *         42501 → 403 "not authorized"
 *         22023 → 400 "Offer is no longer available (already accepted, revoked, or expired)"
 *         unknown → 500 "unexpected error" + Sentry capture
 *   (c) Happy path — calls correct RPC with offerId; revalidatePath + redirect
 *   (d) URL-binding integrity — offerId from .bind() reaches the RPC (not FormData)
 *   (e) Sentry extras never contain sensitive user data
 *
 * Testing strategy:
 *   - Mock next/cache, next/navigation
 *   - Mock @/lib/supabase/server createClient
 *   - Mock @sentry/nextjs
 *   - Call action directly (no FormData — action takes a bound offerId number)
 *
 * WHY redirect is mocked as throwing:
 *   In production, Next.js redirect() throws a special error to interrupt the
 *   current render. We replicate this so tests can assert "redirect was called"
 *   without needing a full Next.js render context.
 *
 * SOC 2 CC6.1 / CC7.2: user-facing offer acceptance contract is fully covered
 * so compliance reviews can reference test output.
 *
 * @module __tests__/actions
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockRedirect = vi.fn((url: string) => {
  // WHY throw: Next.js redirect() throws internally to abort the function.
  // Replicating this allows tests to assert redirect was called without a full
  // render context, using .rejects.toThrow(/NEXT_REDIRECT/).
  throw new Error(`NEXT_REDIRECT:${url}`);
});

const mockRevalidatePath = vi.fn();

vi.mock('next/navigation', () => ({
  redirect: (url: string) => mockRedirect(url),
}));

vi.mock('next/cache', () => ({
  revalidatePath: (path: string) => mockRevalidatePath(path),
}));

// ─── Sentry mock ──────────────────────────────────────────────────────────────

const mockSentryCaptureException = vi.fn();

vi.mock('@sentry/nextjs', () => ({
  captureException: (...args: unknown[]) => mockSentryCaptureException(...args),
  captureMessage: (...args: unknown[]) => void 0,
}));

// ─── Supabase mock ────────────────────────────────────────────────────────────

const mockRpc = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}));

import { createClient } from '@/lib/supabase/server';
import type { Mock } from 'vitest';

// ─── Constants ────────────────────────────────────────────────────────────────

const VALID_OFFER_ID = 7;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Expected redirect URL for a given offerId. */
function expectedRedirectUrl(offerId: number) {
  return `/billing/offer/${offerId}`;
}

// ─── Test suites ──────────────────────────────────────────────────────────────

describe('acceptOfferAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default happy-path: RPC returns no error.
    (createClient as Mock).mockResolvedValue({ rpc: mockRpc });
    mockRpc.mockResolvedValue({ data: null, error: null });
  });

  // ── (a) Validation ────────────────────────────────────────────────────────

  it('(a) rejects offerId = 0 (non-positive)', async () => {
    const { acceptOfferAction } = await import('../actions');
    const result = await acceptOfferAction(0);
    expect(result).toMatchObject({ ok: false, statusCode: 400 });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('(a) rejects negative offerId', async () => {
    const { acceptOfferAction } = await import('../actions');
    const result = await acceptOfferAction(-1);
    expect(result).toMatchObject({ ok: false, statusCode: 400 });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('(a) rejects NaN as offerId', async () => {
    const { acceptOfferAction } = await import('../actions');
    const result = await acceptOfferAction(NaN);
    expect(result).toMatchObject({ ok: false, statusCode: 400 });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('(a) rejects Infinity as offerId', async () => {
    const { acceptOfferAction } = await import('../actions');
    const result = await acceptOfferAction(Infinity);
    expect(result).toMatchObject({ ok: false, statusCode: 400 });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('(a) accepts a valid positive integer offerId', async () => {
    const { acceptOfferAction } = await import('../actions');
    await expect(acceptOfferAction(VALID_OFFER_ID)).rejects.toThrow(/NEXT_REDIRECT/);
    expect(mockRpc).toHaveBeenCalledOnce();
  });

  // ── (b) SQLSTATE mapping ───────────────────────────────────────────────────

  it('(b) maps SQLSTATE 42501 to 403 "not authorized"', async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { code: '42501', message: 'insufficient privilege' },
    });
    const { acceptOfferAction } = await import('../actions');
    const result = await acceptOfferAction(VALID_OFFER_ID);
    expect(result).toMatchObject({ ok: false, statusCode: 403 });
    expect((result as { ok: false; error: string }).error).toMatch(/not authorized/i);
  });

  it('(b) maps SQLSTATE 22023 to 400 with "Offer is no longer available" message', async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { code: '22023', message: 'offer already accepted' },
    });
    const { acceptOfferAction } = await import('../actions');
    const result = await acceptOfferAction(VALID_OFFER_ID);
    expect(result).toMatchObject({ ok: false, statusCode: 400 });
    expect((result as { ok: false; error: string }).error).toContain(
      'Offer is no longer available'
    );
    // Verify the full message matches spec §4.4 exactly
    expect((result as { ok: false; error: string }).error).toContain(
      'already accepted, revoked, or expired'
    );
  });

  it('(b) maps unknown SQLSTATE to 500 and captures Sentry', async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { code: 'P0001', message: 'unexpected internal error' },
    });
    const { acceptOfferAction } = await import('../actions');
    const result = await acceptOfferAction(VALID_OFFER_ID);
    expect(result).toMatchObject({ ok: false, statusCode: 500 });
    expect(mockSentryCaptureException).toHaveBeenCalledOnce();

    // Verify the Sentry event tags the correct action name.
    const [, sentryCtx] = mockSentryCaptureException.mock.calls[0];
    expect(sentryCtx?.tags?.user_action).toBe('accept_churn_save_offer');
  });

  it('(b) maps unknown SQLSTATE to 500 with generic user message', async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { code: 'XX000', message: 'internal db error' },
    });
    const { acceptOfferAction } = await import('../actions');
    const result = await acceptOfferAction(VALID_OFFER_ID);
    expect((result as { ok: false; error: string }).error).toMatch(/unexpected error/i);
  });

  // ── (c) Happy path ─────────────────────────────────────────────────────────

  it('(c) calls user_accept_churn_save_offer RPC with correct offerId', async () => {
    const { acceptOfferAction } = await import('../actions');
    await expect(acceptOfferAction(VALID_OFFER_ID)).rejects.toThrow(/NEXT_REDIRECT/);
    expect(mockRpc).toHaveBeenCalledWith('user_accept_churn_save_offer', {
      p_offer_id: VALID_OFFER_ID,
    });
  });

  it('(c) revalidates the offer page path on success', async () => {
    const { acceptOfferAction } = await import('../actions');
    await expect(acceptOfferAction(VALID_OFFER_ID)).rejects.toThrow(/NEXT_REDIRECT/);
    expect(mockRevalidatePath).toHaveBeenCalledWith(`/billing/offer/${VALID_OFFER_ID}`);
  });

  it('(c) redirects to /billing/offer/[offerId] on success', async () => {
    const { acceptOfferAction } = await import('../actions');
    await expect(acceptOfferAction(VALID_OFFER_ID)).rejects.toThrow(/NEXT_REDIRECT/);
    expect(mockRedirect).toHaveBeenCalledWith(expectedRedirectUrl(VALID_OFFER_ID));
  });

  // ── (d) URL-binding integrity ──────────────────────────────────────────────

  it('(d) passes the bound offerId to the RPC — not any other value', async () => {
    // WHY: the .bind(null, offerId) pattern on the page means the offerId
    // is fixed server-side. We verify the RPC receives the exact offerId passed
    // to the action, not a manipulated value.
    const ANOTHER_OFFER_ID = 99;
    const { acceptOfferAction } = await import('../actions');
    await expect(acceptOfferAction(ANOTHER_OFFER_ID)).rejects.toThrow(/NEXT_REDIRECT/);
    expect(mockRpc).toHaveBeenCalledWith(
      'user_accept_churn_save_offer',
      expect.objectContaining({ p_offer_id: ANOTHER_OFFER_ID })
    );
  });

  // ── (e) Sentry extras safety ───────────────────────────────────────────────

  it('(e) does not include any sensitive user or token data in Sentry extras on error', async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { code: 'P0001', message: 'unexpected error' },
    });
    const { acceptOfferAction } = await import('../actions');
    await acceptOfferAction(VALID_OFFER_ID);

    // The extras may contain rpc_message but NEVER a raw token or sensitive secret.
    const sentryExtra = mockSentryCaptureException.mock.calls[0]?.[1]?.extra ?? {};
    const sentryStr = JSON.stringify(sentryExtra);
    // Assert no base64url-looking string that might be a token or API key.
    expect(sentryStr).not.toMatch(/[A-Za-z0-9_-]{40,}/);
  });

  it('(e) records the SQLSTATE code in Sentry tags for ops triage', async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { code: 'P0002', message: 'no data found' },
    });
    const { acceptOfferAction } = await import('../actions');
    await acceptOfferAction(VALID_OFFER_ID);

    const [, sentryCtx] = mockSentryCaptureException.mock.calls[0];
    expect(sentryCtx?.tags?.sqlstate).toBe('P0002');
  });
});
