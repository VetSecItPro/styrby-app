/**
 * Tests for approveAction + revokeAction — /support/access/[grantId]/actions.ts
 *
 * Phase 4.2 — Support Tooling T5
 *
 * Coverage:
 *   (a) Zod validation — non-positive / non-integer grantId returns { ok: false }
 *       without calling the RPC
 *   (b) SQLSTATE mapping:
 *         42501 → 403 "not authorized"
 *         22023 → 400 "cannot be modified in its current state"
 *         unknown → 500 "unexpected error" + Sentry capture
 *   (c) Happy path — calls correct RPC with grantId; revalidatePath + redirect
 *   (d) URL-binding integrity — grantId from .bind() reaches the RPC (not FormData)
 *   (e) Idempotent revoke — 0-row update (no error) still redirects cleanly
 *   (f) Sentry extras never contain the token hash (it is never in scope here)
 *
 * Testing strategy:
 *   - Mock next/cache, next/navigation
 *   - Mock @/lib/supabase/server createClient
 *   - Mock @sentry/nextjs
 *   - Call actions directly (no FormData — actions take a bound grantId number)
 *
 * WHY redirect is mocked as throwing:
 *   In production, Next.js redirect() throws a special error to interrupt the
 *   current render. We replicate this so tests can assert "redirect was called"
 *   without needing a full Next.js render context.
 *
 * SOC 2 CC6.1 / CC7.2: user-facing grant approval contract is fully covered
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

// WHY mockRpc is separate: tests configure return values per-test in beforeEach.
// The factory cannot reference it directly (hoisting issue), so we set the
// resolved value after all consts are live (same pattern as T4 actions tests).
const mockRpc = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}));

import { createClient } from '@/lib/supabase/server';
import type { Mock } from 'vitest';

// ─── Constants ────────────────────────────────────────────────────────────────

const VALID_GRANT_ID = 42;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Expected redirect URL for a given grantId. */
function expectedRedirectUrl(grantId: number) {
  return `/support/access/${grantId}`;
}

// ─── Test suites ──────────────────────────────────────────────────────────────

describe('approveAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default happy-path: RPC returns no error (void return from RPC).
    (createClient as Mock).mockResolvedValue({ rpc: mockRpc });
    mockRpc.mockResolvedValue({ data: null, error: null });
  });

  // ── (a) Zod validation ─────────────────────────────────────────────────────

  it('(a) rejects grantId = 0 (non-positive)', async () => {
    const { approveAction } = await import('../actions');
    const result = await approveAction(0);
    expect(result).toMatchObject({ ok: false, statusCode: 400 });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('(a) rejects negative grantId', async () => {
    const { approveAction } = await import('../actions');
    const result = await approveAction(-1);
    expect(result).toMatchObject({ ok: false, statusCode: 400 });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('(a) rejects NaN as grantId', async () => {
    const { approveAction } = await import('../actions');
    const result = await approveAction(NaN);
    expect(result).toMatchObject({ ok: false, statusCode: 400 });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('(a) accepts a valid positive integer grantId', async () => {
    const { approveAction } = await import('../actions');
    await expect(approveAction(VALID_GRANT_ID)).rejects.toThrow(/NEXT_REDIRECT/);
    expect(mockRpc).toHaveBeenCalledOnce();
  });

  // ── (b) SQLSTATE mapping ───────────────────────────────────────────────────

  it('(b) maps SQLSTATE 42501 to 403 "not authorized"', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'insufficient privilege' } });
    const { approveAction } = await import('../actions');
    const result = await approveAction(VALID_GRANT_ID);
    expect(result).toMatchObject({ ok: false, statusCode: 403 });
    expect((result as { ok: false; error: string }).error).toMatch(/not authorized/i);
  });

  it('(b) maps SQLSTATE 22023 to 400 "cannot be modified in its current state"', async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { code: '22023', message: 'invalid parameter: grant already approved' },
    });
    const { approveAction } = await import('../actions');
    const result = await approveAction(VALID_GRANT_ID);
    expect(result).toMatchObject({ ok: false, statusCode: 400 });
    expect((result as { ok: false; error: string }).error).toContain('cannot be modified');
  });

  it('(b) maps unknown SQLSTATE to 500 and captures Sentry', async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { code: 'P0001', message: 'unexpected internal error' },
    });
    const { approveAction } = await import('../actions');
    const result = await approveAction(VALID_GRANT_ID);
    expect(result).toMatchObject({ ok: false, statusCode: 500 });
    expect(mockSentryCaptureException).toHaveBeenCalledOnce();

    // Verify the Sentry event tags the correct action name.
    const [, sentryCtx] = mockSentryCaptureException.mock.calls[0];
    expect(sentryCtx?.tags?.user_action).toBe('approve');
  });

  // ── (c) Happy path ─────────────────────────────────────────────────────────

  it('(c) calls user_approve_support_access RPC with correct grantId', async () => {
    const { approveAction } = await import('../actions');
    await expect(approveAction(VALID_GRANT_ID)).rejects.toThrow(/NEXT_REDIRECT/);
    expect(mockRpc).toHaveBeenCalledWith('user_approve_support_access', {
      p_grant_id: VALID_GRANT_ID,
    });
  });

  it('(c) revalidates the grant page path on success', async () => {
    const { approveAction } = await import('../actions');
    await expect(approveAction(VALID_GRANT_ID)).rejects.toThrow(/NEXT_REDIRECT/);
    expect(mockRevalidatePath).toHaveBeenCalledWith(`/support/access/${VALID_GRANT_ID}`);
  });

  it('(c) redirects to /support/access/[grantId] on success', async () => {
    const { approveAction } = await import('../actions');
    await expect(approveAction(VALID_GRANT_ID)).rejects.toThrow(/NEXT_REDIRECT/);
    expect(mockRedirect).toHaveBeenCalledWith(expectedRedirectUrl(VALID_GRANT_ID));
  });

  // ── (d) URL-binding integrity ──────────────────────────────────────────────

  it('(d) passes the bound grantId to the RPC — not any other value', async () => {
    // WHY: the .bind(null, grantId) pattern on the page means the grantId
    // is fixed server-side. We verify the RPC receives the exact grantId passed
    // to the action, not a manipulated value.
    const ANOTHER_GRANT_ID = 99;
    const { approveAction } = await import('../actions');
    await expect(approveAction(ANOTHER_GRANT_ID)).rejects.toThrow(/NEXT_REDIRECT/);
    expect(mockRpc).toHaveBeenCalledWith(
      'user_approve_support_access',
      expect.objectContaining({ p_grant_id: ANOTHER_GRANT_ID })
    );
  });

  // ── (f) Sentry extras safety ───────────────────────────────────────────────

  it('(f) does not include any token value in Sentry extras on error', async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { code: 'P0001', message: 'unexpected error' },
    });
    const { approveAction } = await import('../actions');
    await approveAction(VALID_GRANT_ID);

    // The extras may contain rpc_message but NEVER a raw token or hash.
    // Tokens are not in scope in this action (never generated here), so this
    // is a belt-and-suspenders assertion to catch regressions if code is refactored.
    const sentryExtra = mockSentryCaptureException.mock.calls[0]?.[1]?.extra ?? {};
    const sentryStr = JSON.stringify(sentryExtra);
    // Assert no base64url-looking string that might be a token.
    expect(sentryStr).not.toMatch(/[A-Za-z0-9_-]{40,}/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('revokeAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (createClient as Mock).mockResolvedValue({ rpc: mockRpc });
    mockRpc.mockResolvedValue({ data: null, error: null });
  });

  // ── (a) Zod validation ─────────────────────────────────────────────────────

  it('(a) rejects grantId = 0', async () => {
    const { revokeAction } = await import('../actions');
    const result = await revokeAction(0);
    expect(result).toMatchObject({ ok: false, statusCode: 400 });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('(a) accepts a valid positive integer grantId', async () => {
    const { revokeAction } = await import('../actions');
    await expect(revokeAction(VALID_GRANT_ID)).rejects.toThrow(/NEXT_REDIRECT/);
    expect(mockRpc).toHaveBeenCalledOnce();
  });

  // ── (b) SQLSTATE mapping ───────────────────────────────────────────────────

  it('(b) maps SQLSTATE 42501 to 403', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: '42501' } });
    const { revokeAction } = await import('../actions');
    const result = await revokeAction(VALID_GRANT_ID);
    expect(result).toMatchObject({ ok: false, statusCode: 403 });
  });

  it('(b) maps SQLSTATE 22023 to 400', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: '22023' } });
    const { revokeAction } = await import('../actions');
    const result = await revokeAction(VALID_GRANT_ID);
    expect(result).toMatchObject({ ok: false, statusCode: 400 });
  });

  it('(b) maps unknown SQLSTATE to 500 and captures Sentry with action name', async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { code: 'XX000', message: 'internal db error' },
    });
    const { revokeAction } = await import('../actions');
    const result = await revokeAction(VALID_GRANT_ID);
    expect(result).toMatchObject({ ok: false, statusCode: 500 });
    expect(mockSentryCaptureException).toHaveBeenCalledOnce();
    const [, sentryCtx] = mockSentryCaptureException.mock.calls[0];
    // WHY assert 'revoke' not 'approve': ensures the action name tag distinguishes
    // approve vs revoke failures in Sentry for ops triage.
    expect(sentryCtx?.tags?.user_action).toBe('revoke');
  });

  // ── (c) Happy path ─────────────────────────────────────────────────────────

  it('(c) calls user_revoke_support_access RPC with correct grantId', async () => {
    const { revokeAction } = await import('../actions');
    await expect(revokeAction(VALID_GRANT_ID)).rejects.toThrow(/NEXT_REDIRECT/);
    expect(mockRpc).toHaveBeenCalledWith('user_revoke_support_access', {
      p_grant_id: VALID_GRANT_ID,
    });
  });

  it('(c) revalidates and redirects to /support/access/[grantId] on success', async () => {
    const { revokeAction } = await import('../actions');
    await expect(revokeAction(VALID_GRANT_ID)).rejects.toThrow(/NEXT_REDIRECT/);
    expect(mockRevalidatePath).toHaveBeenCalledWith(`/support/access/${VALID_GRANT_ID}`);
    expect(mockRedirect).toHaveBeenCalledWith(expectedRedirectUrl(VALID_GRANT_ID));
  });

  // ── (e) Idempotent revoke ──────────────────────────────────────────────────

  it('(e) treats 0-row update (no RPC error) as success and redirects', async () => {
    // WHY: the RPC returns void (no error) even on 0-row updates for terminal
    // states. This simulates the idempotent behavior — already-revoked grants
    // do not return an error from the RPC, so the action should still redirect.
    mockRpc.mockResolvedValueOnce({ data: null, error: null });
    const { revokeAction } = await import('../actions');
    await expect(revokeAction(VALID_GRANT_ID)).rejects.toThrow(/NEXT_REDIRECT/);
    // No error, no Sentry capture.
    expect(mockSentryCaptureException).not.toHaveBeenCalled();
    expect(mockRedirect).toHaveBeenCalledWith(expectedRedirectUrl(VALID_GRANT_ID));
  });

  // ── (d) URL-binding integrity ──────────────────────────────────────────────

  it('(d) passes the bound grantId to the revoke RPC', async () => {
    const ANOTHER_GRANT_ID = 7;
    const { revokeAction } = await import('../actions');
    await expect(revokeAction(ANOTHER_GRANT_ID)).rejects.toThrow(/NEXT_REDIRECT/);
    expect(mockRpc).toHaveBeenCalledWith(
      'user_revoke_support_access',
      expect.objectContaining({ p_grant_id: ANOTHER_GRANT_ID })
    );
  });
});
