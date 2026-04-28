/**
 * Admin MFA Gate — Unit Tests
 *
 * Tests for assertAdminMfa() in packages/styrby-web/src/lib/admin/mfa-gate.ts.
 *
 * Coverage matrix:
 *   (1) Grace period allows action + writes audit event
 *   (2) Grace period writes audit event (audit table called)
 *   (3) Expired grace + no MFA → throws AdminMfaRequiredError (403)
 *   (4) Passkey present → allows action (no grace required)
 *   (5) Verified TOTP present → allows action
 *   (6) Unverified TOTP (pending status) → blocked (not counted as MFA)
 *   (7) DB error (grace query) → fail-closed (throws AdminMfaRequiredError)
 *   (8) DB error (passkeys query) → fail-closed
 *   (9) Auth API error + passkey present → passkey fallback allows action
 *  (10) Auth API error + no passkey → fail-closed
 *  (11) Audit write failure during grace → does NOT block action
 *  (12) Empty userId → throws AdminMfaRequiredError immediately (no DB call)
 *  (13) Grace exactly at boundary (expired by 1ms) → blocked
 *  (14) Blocked (no MFA after grace) → Sentry warning captured
 *  (15) DB error path → Sentry exception captured
 *
 * Security references:
 *   OWASP A07:2021 — Identification and Authentication Failures
 *   SOC 2 CC6.1    — Privileged access requires phishing-resistant MFA
 *   NIST SP 800-53 AC-3 — Deny-by-default on error
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// ============================================================================
// Mocks — set up before imports so vi.mock hoisting works
// ============================================================================

vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: vi.fn(),
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

import { createAdminClient } from '@/lib/supabase/server';
import * as Sentry from '@sentry/nextjs';
import { assertAdminMfa, AdminMfaRequiredError } from '@/lib/admin/mfa-gate';

// ============================================================================
// Helpers
// ============================================================================

/** ISO timestamp in the future (grace active). */
const FUTURE_GRACE = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();

/** ISO timestamp in the past (grace expired). */
const PAST_GRACE = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();

/** Just-expired: 1 ms before now (boundary test). */
const JUST_EXPIRED = new Date(Date.now() - 1).toISOString();

type FromTable = 'site_admins' | 'passkeys' | 'audit_log';

interface SetupOptions {
  graceUntil?: string | null;
  graceError?: Error | null;
  passkeys?: { id: string }[];
  passkeysError?: Error | null;
  totpVerified?: boolean;
  totpError?: Error | null;
  auditInsertError?: Error | null;
}

/**
 * Configures createAdminClient mock for a single assertAdminMfa() call.
 *
 * WHY per-table dispatch on `from()`:
 *   assertAdminMfa() calls createAdminClient() once at the top of
 *   queryAdminMfaStatus, then calls .from('site_admins'), .from('passkeys'),
 *   and auth.admin.getUserById in parallel. We route `from()` calls by table
 *   name and return independent mock chains.
 *
 * @param opts - Override defaults to simulate specific scenarios.
 */
function setupFromMock(opts: SetupOptions = {}) {
  const {
    graceUntil = FUTURE_GRACE,
    graceError = null,
    passkeys = [],
    passkeysError = null,
    totpVerified = false,
    totpError = null,
    auditInsertError = null,
  } = opts;

  // Build per-table from() mock chains.
  const fromMocks: Record<FromTable, ReturnType<typeof vi.fn>> = {
    site_admins: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue(
            graceError
              ? { data: null, error: graceError }
              : { data: graceUntil != null ? { mfa_grace_until: graceUntil } : null, error: null }
          ),
        }),
      }),
    }),

    passkeys: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          is: vi.fn().mockResolvedValue(
            passkeysError
              ? { data: null, error: passkeysError }
              : { data: passkeys, error: null }
          ),
        }),
      }),
    }),

    audit_log: vi.fn().mockReturnValue({
      insert: vi.fn().mockResolvedValue(
        auditInsertError
          ? { data: null, error: auditInsertError }
          : { data: null, error: null }
      ),
    }),
  };

  // Auth Admin API mock.
  const mockGetUserById = vi.fn().mockResolvedValue(
    totpError
      ? { data: null, error: totpError }
      : {
          data: {
            user: {
              id: 'admin-uuid',
              factors: totpVerified
                ? [{ factor_type: 'totp', status: 'verified' }]
                : [],
            },
          },
          error: null,
        }
  );

  (createAdminClient as Mock).mockReturnValue({
    from: (table: string) => {
      const mock = fromMocks[table as FromTable];
      if (!mock) throw new Error(`Unexpected table: ${table}`);
      return mock(table);
    },
    auth: {
      admin: {
        getUserById: mockGetUserById,
      },
    },
  });

  return { fromMocks, mockGetUserById };
}

// ============================================================================
// Tests
// ============================================================================

describe('assertAdminMfa', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // (1) Grace period allows action
  // --------------------------------------------------------------------------

  it('(1) allows action when admin is within grace period', async () => {
    setupFromMock({ graceUntil: FUTURE_GRACE, passkeys: [], totpVerified: false });

    // Should not throw.
    await expect(assertAdminMfa('admin-uuid')).resolves.toBeUndefined();
  });

  // --------------------------------------------------------------------------
  // (2) Grace period writes audit event
  // --------------------------------------------------------------------------

  it('(2) writes grace audit event when action allowed in grace period', async () => {
    const { fromMocks } = setupFromMock({
      graceUntil: FUTURE_GRACE,
      passkeys: [],
      totpVerified: false,
    });

    await assertAdminMfa('admin-uuid');

    // audit_log.insert should have been called once.
    const auditInsertMock = fromMocks.audit_log('audit_log').insert;
    expect(auditInsertMock).toHaveBeenCalledOnce();
    expect(auditInsertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'admin-uuid',
        event_type: 'admin_mfa_grace_action',
      })
    );
  });

  // --------------------------------------------------------------------------
  // (3) Expired grace + no MFA → blocked
  // --------------------------------------------------------------------------

  it('(3) throws AdminMfaRequiredError when grace expired and no MFA enrolled', async () => {
    setupFromMock({ graceUntil: PAST_GRACE, passkeys: [], totpVerified: false });

    await expect(assertAdminMfa('admin-uuid')).rejects.toThrow(AdminMfaRequiredError);
  });

  it('(3a) AdminMfaRequiredError has correct statusCode and code', async () => {
    setupFromMock({ graceUntil: PAST_GRACE, passkeys: [], totpVerified: false });

    let err: unknown;
    try {
      await assertAdminMfa('admin-uuid');
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(AdminMfaRequiredError);
    expect((err as AdminMfaRequiredError).statusCode).toBe(403);
    expect((err as AdminMfaRequiredError).code).toBe('ADMIN_MFA_REQUIRED');
  });

  // --------------------------------------------------------------------------
  // (4) Passkey present → allows (no grace needed)
  // --------------------------------------------------------------------------

  it('(4) allows action when passkey is enrolled (no grace required)', async () => {
    setupFromMock({
      graceUntil: PAST_GRACE, // grace expired
      passkeys: [{ id: 'passkey-uuid-001' }],
      totpVerified: false,
    });

    await expect(assertAdminMfa('admin-uuid')).resolves.toBeUndefined();
  });

  // --------------------------------------------------------------------------
  // (5) Verified TOTP → allows
  // --------------------------------------------------------------------------

  it('(5) allows action when verified TOTP factor is enrolled', async () => {
    setupFromMock({
      graceUntil: PAST_GRACE,
      passkeys: [],
      totpVerified: true,
    });

    await expect(assertAdminMfa('admin-uuid')).resolves.toBeUndefined();
  });

  // --------------------------------------------------------------------------
  // (6) Unverified TOTP → blocked
  // --------------------------------------------------------------------------

  it('(6) blocks action when TOTP factor exists but is not verified (status pending)', async () => {
    // Manually configure Auth response with unverified TOTP.
    (createAdminClient as Mock).mockReturnValue({
      from: (table: string) => {
        if (table === 'site_admins') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: { mfa_grace_until: PAST_GRACE },
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === 'passkeys') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                is: vi.fn().mockResolvedValue({ data: [], error: null }),
              }),
            }),
          };
        }
        throw new Error(`Unexpected table: ${table}`);
      },
      auth: {
        admin: {
          getUserById: vi.fn().mockResolvedValue({
            data: {
              user: {
                id: 'admin-uuid',
                // status: 'unverified' — should NOT count as MFA.
                factors: [{ factor_type: 'totp', status: 'unverified' }],
              },
            },
            error: null,
          }),
        },
      },
    });

    await expect(assertAdminMfa('admin-uuid')).rejects.toThrow(AdminMfaRequiredError);
  });

  // --------------------------------------------------------------------------
  // (7) DB error (grace query) → fail-closed
  // --------------------------------------------------------------------------

  it('(7) throws AdminMfaRequiredError when site_admins query fails (fail-closed)', async () => {
    setupFromMock({ graceError: new Error('DB connection timeout') });

    await expect(assertAdminMfa('admin-uuid')).rejects.toThrow(AdminMfaRequiredError);
  });

  // --------------------------------------------------------------------------
  // (8) DB error (passkeys query) → fail-closed
  // --------------------------------------------------------------------------

  it('(8) throws AdminMfaRequiredError when passkeys query fails (fail-closed)', async () => {
    setupFromMock({
      graceUntil: PAST_GRACE,
      passkeysError: new Error('passkeys table unavailable'),
    });

    await expect(assertAdminMfa('admin-uuid')).rejects.toThrow(AdminMfaRequiredError);
  });

  // --------------------------------------------------------------------------
  // (9) Auth API error + passkey present → fallback allows
  // --------------------------------------------------------------------------

  it('(9) allows action when Auth API fails but passkey is present (passkey fallback)', async () => {
    setupFromMock({
      graceUntil: PAST_GRACE,
      passkeys: [{ id: 'passkey-uuid-001' }],
      totpError: new Error('Auth API timeout'),
    });

    // Should NOT throw — passkey satisfies MFA requirement even when TOTP check fails.
    await expect(assertAdminMfa('admin-uuid')).resolves.toBeUndefined();
  });

  // --------------------------------------------------------------------------
  // (10) Auth API error + no passkey → fail-closed
  // --------------------------------------------------------------------------

  it('(10) throws AdminMfaRequiredError when Auth API fails and no passkey (fail-closed)', async () => {
    setupFromMock({
      graceUntil: PAST_GRACE,
      passkeys: [],
      totpError: new Error('Auth API timeout'),
    });

    await expect(assertAdminMfa('admin-uuid')).rejects.toThrow(AdminMfaRequiredError);
  });

  // --------------------------------------------------------------------------
  // (11) Audit write failure → does NOT block action
  // --------------------------------------------------------------------------

  it('(11) allows action even when audit_log.insert fails during grace period', async () => {
    setupFromMock({
      graceUntil: FUTURE_GRACE,
      passkeys: [],
      auditInsertError: new Error('audit_log write failed'),
    });

    // Action should still be allowed — audit failure is non-blocking.
    await expect(assertAdminMfa('admin-uuid')).resolves.toBeUndefined();
  });

  it('(11a) captures Sentry exception when audit_log.insert fails', async () => {
    const insertErr = new Error('audit_log write failed');
    setupFromMock({
      graceUntil: FUTURE_GRACE,
      passkeys: [],
      auditInsertError: insertErr,
    });

    await assertAdminMfa('admin-uuid');

    // Sentry should capture the audit write failure.
    expect(Sentry.captureException).toHaveBeenCalledWith(
      insertErr,
      expect.objectContaining({
        tags: expect.objectContaining({ component: 'writeGraceAuditEvent' }),
      })
    );
  });

  // --------------------------------------------------------------------------
  // (12) Empty userId → immediate throw, no DB call
  // --------------------------------------------------------------------------

  it('(12) throws AdminMfaRequiredError immediately for empty userId', async () => {
    await expect(assertAdminMfa('')).rejects.toThrow(AdminMfaRequiredError);
    // createAdminClient should NOT be called — we fail before any DB query.
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // (13) Grace boundary — expired by 1ms → blocked
  // --------------------------------------------------------------------------

  it('(13) blocks action when grace expired by 1ms (boundary test)', async () => {
    setupFromMock({
      graceUntil: JUST_EXPIRED,
      passkeys: [],
      totpVerified: false,
    });

    await expect(assertAdminMfa('admin-uuid')).rejects.toThrow(AdminMfaRequiredError);
  });

  // --------------------------------------------------------------------------
  // (14) Sentry warning captured when blocked (no MFA after grace)
  // --------------------------------------------------------------------------

  it('(14) captures Sentry warning when admin blocked due to no MFA after grace', async () => {
    setupFromMock({ graceUntil: PAST_GRACE, passkeys: [], totpVerified: false });

    await expect(assertAdminMfa('admin-uuid')).rejects.toThrow(AdminMfaRequiredError);

    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('no MFA enrolled after grace period'),
      expect.objectContaining({
        level: 'warning',
        tags: expect.objectContaining({ reason: 'no_mfa_after_grace' }),
      })
    );
  });

  // --------------------------------------------------------------------------
  // (15) DB error path → Sentry exception captured
  // --------------------------------------------------------------------------

  it('(15) captures Sentry exception when queryAdminMfaStatus throws', async () => {
    const dbErr = new Error('DB connection timeout');
    setupFromMock({ graceError: dbErr });

    await expect(assertAdminMfa('admin-uuid')).rejects.toThrow(AdminMfaRequiredError);

    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.anything(), // The error may be wrapped
      expect.objectContaining({
        tags: expect.objectContaining({ component: 'assertAdminMfa' }),
      })
    );
  });
});
