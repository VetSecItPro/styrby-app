'use server';

/**
 * Server actions for admin support ticket session-access requests.
 *
 * Phase 4.2 — Support Tooling T4
 * Updated 2026-04-25 — SEC-ADV-001 remediation (server-side token pickup).
 *
 * Action exposed:
 *   requestSupportAccessAction(trustedTicketId, formData) — creates a
 *   `support_access_grants` row via the `admin_request_support_access` SECURITY
 *   DEFINER RPC, stashes the raw token in `support_grant_token_pickup` via
 *   `admin_stash_grant_token`, then redirects to the success page (no cookie).
 *
 * Security model (4 layers):
 *   1. Next.js 15 server actions enforce `Action-Origin` same-origin — no manual
 *      CSRF token required.
 *   2. Middleware (T3) — returns 404 for non-site-admins before the action runs.
 *   3. `admin_request_support_access` RPC (SECURITY DEFINER) — calls
 *      `is_site_admin(auth.uid())` inside Postgres and raises 42501 on failure.
 *   4. `admin_stash_grant_token` RPC (SECURITY DEFINER, migration 057) —
 *      requires both is_site_admin AND that auth.uid() = grant.granted_by, so
 *      only the admin who just created the grant can lodge its raw token.
 *
 * Token safety (SEC-ADV-001 — eliminates XSS extraction window):
 *   The previous implementation flashed the raw token through a non-HttpOnly
 *   cookie with maxAge=60. Because the success page had to clear the cookie
 *   from JS, httpOnly could not be set; any same-origin XSS within 60s could
 *   read `document.cookie`, exfiltrate the raw token, and call
 *   `admin_consume_support_access` from an attacker-controlled browser to read
 *   victim session metadata. PR #164 hardened sameSite to 'strict' which closes
 *   cross-site CSRF leaks but did NOT close the intra-origin XSS window.
 *
 *   This implementation removes the cookie channel entirely. The raw token
 *   exists only:
 *     (a) briefly in this process's memory (one statement after stash),
 *     (b) in `support_grant_token_pickup` for ≤60s (RLS-locked, no SELECT
 *         policy — only readable via admin_pickup_grant_token RPC),
 *     (c) in the HTML response body of the success page server component for
 *         exactly one render. No client-readable cookie or storage.
 *
 *   See migration 057 header for the full threat-model delta.
 *
 * SOC 2 CC6.1: admin operations require authenticated site admin session.
 * SOC 2 CC7.2: every grant is audited via the SECURITY DEFINER RPC.
 * OWASP A02:2021 / A04:2021: token never reaches client storage; pickup is
 *   atomic via FOR UPDATE in the pickup RPC.
 */

import { z } from 'zod';
import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { generateSupportToken } from '@/lib/support/token';
import * as Sentry from '@sentry/nextjs';
import { assertAdminMfa, AdminMfaRequiredError } from '@/lib/admin/mfa-gate';

// ─── Shared action result type ────────────────────────────────────────────────

/**
 * Union of all result shapes for support-access server actions.
 * Mirrors the AdminActionResult pattern established in Phase 4.1.
 */
export type SupportAccessActionResult =
  | { ok: true; grantId: string }
  | { ok: false; error: string; field?: string };

// ─── Input schema ─────────────────────────────────────────────────────────────

/**
 * Zod schema for the request-support-access form.
 *
 * WHY session_id as UUID: the dropdown only renders sessions scoped to the
 * ticket's user, but we validate the UUID format here so a tampered value is
 * caught at the app layer before touching Postgres.
 *
 * WHY reason min 10 / max 500: mirrors Phase 4.1 T6 (T2 threat review carryover).
 * Minimum prevents trivially empty justifications; max caps audit log abuse.
 *
 * WHY expires_in_hours 1-168: spec constraint (1 hour min, 7-day max).
 * Default is 24 hours shown in the form's select.
 */
const RequestSupportAccessSchema = z.object({
  session_id: z.string().uuid({ message: 'Invalid session ID' }),
  reason: z
    .string()
    .min(10, { message: 'Reason must be at least 10 characters' })
    .max(500, { message: 'Reason must be 500 characters or fewer' }),
  expires_in_hours: z
    .number()
    .int()
    .min(1, { message: 'Expiry must be at least 1 hour' })
    .max(168, { message: 'Expiry cannot exceed 168 hours (7 days)' }),
});

// ─── Header utilities ─────────────────────────────────────────────────────────

/**
 * Extracts the first valid IP from the `x-forwarded-for` header.
 *
 * WHY x-forwarded-for: Vercel sets this to the originating client IP.
 * The first IP in the comma-separated list is the original client.
 * WHY allow null: absent in local dev / test environments; RPC accepts NULL.
 *
 * @param xff - Value of the `x-forwarded-for` header, or null if absent.
 * @returns The first IP string, or null.
 */
function extractIP(xff: string | null): string | null {
  if (!xff) return null;
  const first = xff.split(',')[0].trim();
  return first.length >= 2 ? first : null;
}

// ─── SQLSTATE → error mapping ─────────────────────────────────────────────────

/**
 * Maps Postgres SQLSTATE codes from admin_request_support_access to safe
 * user-facing error messages. Never leaks internal SQL error text to the client.
 *
 * Codes handled:
 *   42501 — INSUFFICIENT_PRIVILEGE: caller is not a site admin.
 *   22023 — INVALID_PARAMETER_VALUE: invalid session_id, expired session, or
 *            cross-user session (session belongs to a different user_id than
 *            the ticket owner — the RPC enforces this constraint).
 *   23514 — CHECK_VIOLATION: DB-level constraint (e.g., empty reason).
 *
 * SOC 2 CC6.1: 42501 surfaces as "Not authorized" to avoid confirming which
 * guard failed to a potential attacker.
 *
 * @param err    - Error from the Supabase RPC call.
 * @param action - Action name for Sentry tagging.
 * @returns SupportAccessActionResult with ok: false.
 */
function mapRpcError(
  err: { code?: string; message?: string },
  action: string
): { ok: false; error: string } {
  if (err.code === '42501') return { ok: false, error: 'Not authorized' };
  if (err.code === '22023') return { ok: false, error: 'Invalid session — the session may not belong to this ticket\'s user or may be expired' };
  if (err.code === '23514') return { ok: false, error: 'Reason is required' };

  // Unexpected error — capture in Sentry for ops triage.
  // WHY we do NOT include the raw token in Sentry extras: the raw token is
  // generated before the RPC call but should never appear in any log or
  // external service. We pass only the ticket/session IDs.
  Sentry.captureException(new Error(`admin support action failed: ${action}`), {
    tags: {
      admin_action: action,
      sqlstate: err.code ?? 'unknown',
    },
    extra: {
      // NOTE: rpc_message may contain internal table/column names — safe for
      // Sentry (ops-internal) but must NEVER reach the client response.
      rpc_message: err.message,
    },
  });
  return { ok: false, error: 'Internal error — check Sentry' };
}

// ─── Server action ────────────────────────────────────────────────────────────

/**
 * Server action: create a support access grant for a specific session.
 *
 * Flow (post SEC-ADV-001 remediation):
 *   1. Validate FormData with Zod — reject early with field-level errors.
 *   2. Extract IP + UA from request headers (reserved for future logging).
 *   3. Generate a cryptographically random token and its SHA-256 hash.
 *   4. Resolve the ticket's user_id from `support_tickets` (server-side, never
 *      from FormData — see Fix B pattern below).
 *   5. Call `admin_request_support_access` RPC: writes the grant row with the
 *      token hash and audit entry. Returns the grant_id.
 *   6. Call `admin_stash_grant_token` RPC: persists the raw token in the
 *      server-only `support_grant_token_pickup` table for ≤60s.
 *      WHY the same client (user-scoped): the SECURITY DEFINER body of
 *      admin_stash_grant_token requires auth.uid() to resolve to the admin's
 *      UUID and to match grant.granted_by — see migration 057.
 *   7. Redirect to /…/success?grant=<id>. The success-page server component
 *      will call admin_pickup_grant_token to fetch+delete the raw token in
 *      a single atomic operation, render it once, and never re-render it.
 *
 * WHY trustedTicketId parameter (Fix B pattern from Phase 4.1 T6):
 *   The URL param is the authoritative reference. The action is bound to
 *   the ticket ID server-side via `requestSupportAccessAction.bind(null, id)`
 *   in the page component. This prevents a tampered FormData ticket_id from
 *   creating a grant against a different ticket. The RPC also cross-checks
 *   that the session belongs to the ticket's user_id (22023 if not).
 *
 * WHY user-scoped client (not service-role):
 *   Both SECURITY DEFINER RPCs (admin_request_support_access and
 *   admin_stash_grant_token) call `is_site_admin(auth.uid())`. With the
 *   service-role client there is no JWT context, so auth.uid() = NULL → 42501.
 *   The user-scoped client forwards the admin's session cookie so auth.uid()
 *   resolves correctly. Same pattern as all Phase 4.1 admin RPCs.
 *
 * WHY the raw token is NOT in the action return value, FormData, cookies, or
 *   any client-readable channel:
 *   The raw token is the credential that authorises admin_consume_support_access.
 *   Any channel readable by the browser is reachable by XSS. By keeping the
 *   token strictly server-side (DB pickup table → server-component HTML render
 *   → DELETEd row) the XSS extraction window is eliminated entirely.
 *   SEC-ADV-001 (closed by this change).
 *
 * @param trustedTicketId - UUID from the URL param, bound server-side (unforgeable).
 * @param formData        - FormData submitted by RequestSupportAccessForm.
 * @returns Never returns to the caller on success (redirect throws). On error,
 *   returns SupportAccessActionResult with ok: false.
 */
export async function requestSupportAccessAction(
  trustedTicketId: string,
  formData: FormData
): Promise<SupportAccessActionResult> {
  // ── 1. Validate input ──────────────────────────────────────────────────────
  const rawExpiry = formData.get('expires_in_hours');
  const expiresInHours = rawExpiry ? parseInt(String(rawExpiry), 10) : NaN;

  const parsed = RequestSupportAccessSchema.safeParse({
    session_id: formData.get('session_id'),
    reason: formData.get('reason'),
    expires_in_hours: isNaN(expiresInHours) ? 0 : expiresInHours,
  });

  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    return {
      ok: false,
      error: firstIssue?.message ?? 'Invalid input',
      field: firstIssue?.path.join('.'),
    };
  }

  // ── 2. Extract network context ─────────────────────────────────────────────
  // WHY we still extract IP/UA here (even though they are not RPC parameters):
  //   They are available for future structured logging or audit enhancement without
  //   requiring a form-layer change. Currently not forwarded to the RPC because the
  //   migration 049 signature does not include p_ip / p_ua — the RPC logs context
  //   through the DB session and admin_audit_log, which captures auth.uid().
  const hdrs = await headers();
  const _ip = extractIP(hdrs.get('x-forwarded-for'));
  const _ua = hdrs.get('user-agent') ?? null;
  void _ip; void _ua; // reserved for future structured logging

  // ── 3. Generate token and hash ─────────────────────────────────────────────
  // WHY generate here, before the RPC: the hash is passed to the RPC which
  // stores it. The raw token is then stashed in support_grant_token_pickup via
  // admin_stash_grant_token (step 6) so the success page server component can
  // pick it up exactly once. The raw token MUST NOT be logged, included in
  // Sentry, returned to the caller, or written to any client-readable cookie
  // or storage. SEC-ADV-001.
  const { raw, hash } = generateSupportToken();

  // ── 4. Resolve user_id from the ticket (server-side, unforgeable) ──────────
  const supabase = await createClient();

  // ── MFA gate — H42 Layer 1 ────────────────────────────────────────────────
  // OWASP A07:2021, SOC 2 CC6.1.
  {
    const { data: { user: actingAdmin } } = await supabase.auth.getUser();
    if (actingAdmin) {
      try {
        await assertAdminMfa(actingAdmin.id);
      } catch (err) {
        if (err instanceof AdminMfaRequiredError) {
          return { ok: false, error: err.code };
        }
        throw err;
      }
    }
  }

  // WHY resolve p_user_id from the ticket server-side (not from FormData):
  //   The admin's form submits session_id and reason — there is no user_id field
  //   in the form. Deriving user_id from the ticket row server-side prevents a
  //   malicious admin from tampering FormData to target a different user's session.
  //   The ticket is fetched using trustedTicketId (URL-bound, unforgeable) so the
  //   resulting user_id is authoritative. SOC 2 CC6.1: input integrity at the
  //   server boundary before any privileged operation.
  const { data: ticket, error: ticketErr } = await supabase
    .from('support_tickets')
    .select('user_id')
    .eq('id', trustedTicketId)
    .maybeSingle();

  if (ticketErr || !ticket?.user_id) {
    return { ok: false, error: 'Ticket not found' };
  }

  // ── 5. Create grant + write hash via SECURITY DEFINER RPC ──────────────────
  const { data: grantId, error } = await supabase.rpc('admin_request_support_access', {
    p_ticket_id: trustedTicketId,
    p_user_id: ticket.user_id,
    p_session_id: parsed.data.session_id,
    p_reason: parsed.data.reason,
    p_expires_in_hours: parsed.data.expires_in_hours,
    p_token_hash: hash,
  });

  if (error) return mapRpcError(error, 'request_support_access');

  // ── 6. Stash raw token server-side (replaces the cookie channel) ───────────
  // WHY this RPC (admin_stash_grant_token, migration 057):
  //   It performs is_site_admin(auth.uid()) AND verifies auth.uid() ==
  //   grant.granted_by, then INSERTs the raw token into the RLS-locked
  //   support_grant_token_pickup table. The success-page server component
  //   pulls it exactly once via admin_pickup_grant_token, which atomically
  //   DELETEs the row. Token never crosses to a client-readable surface.
  //
  //   This replaces the prior cookie-flash channel (PR-C / SEC-COOKIE-001
  //   tightened sameSite to 'strict'); SEC-ADV-001 eliminates the channel
  //   entirely so an XSS within the 60-second window cannot read the token
  //   from document.cookie. The token now lives only in the RLS-locked
  //   pickup table for ≤60s and in the success page's HTML response.
  //
  // WHY we do not roll back the grant on stash failure:
  //   The grant exists and the audit trail records its creation — that is a
  //   SOC2 CC7.2 invariant we do not want to undo. If stash fails (extremely
  //   unlikely; the RPC has minimal failure modes apart from auth and
  //   uniqueness), the admin sees an error, the row in support_access_grants
  //   stays in 'pending' status, and the admin can revoke it from the ticket
  //   page. Re-issuing requires creating a fresh grant (new hash). This is
  //   safer than synthesising a compensating revoke that itself could fail.
  const { error: stashError } = await supabase.rpc('admin_stash_grant_token', {
    p_grant_id: grantId,
    p_raw_token: raw,
  });

  if (stashError) {
    // Capture in Sentry — this should never happen in steady state.
    // WHY explicitly omit p_raw_token from Sentry: the raw token must not
    // appear in external systems even on error paths.
    Sentry.captureException(new Error('admin support stash failed'), {
      tags: { admin_action: 'stash_grant_token', sqlstate: stashError.code ?? 'unknown' },
      extra: { rpc_message: stashError.message, grant_id: String(grantId) },
    });
    return {
      ok: false,
      error: 'Token could not be stored for retrieval. Revoke this grant from the ticket page and try again.',
    };
  }

  // ── 7. Revalidate + redirect ───────────────────────────────────────────────
  revalidatePath(`/dashboard/admin/support/${trustedTicketId}`);
  redirect(
    `/dashboard/admin/support/${trustedTicketId}/request-access/success?grant=${grantId}`
  );

  // TypeScript requires a return even after redirect (which throws).
  return { ok: true, grantId: String(grantId) };
}
