'use server';

/**
 * Server actions for admin support ticket session-access requests.
 *
 * Phase 4.2 — Support Tooling T4
 *
 * Action exposed:
 *   requestSupportAccessAction(trustedTicketId, formData) — creates a
 *   `support_access_grant` row via the `admin_request_support_access` SECURITY
 *   DEFINER RPC, then flashes the raw token as a short-lived cookie for the
 *   success page to surface once.
 *
 * Security model (3 layers):
 *   1. Next.js 15 server actions enforce `Action-Origin` same-origin — no manual
 *      CSRF token required.
 *   2. Middleware (T3) — returns 404 for non-site-admins before the action runs.
 *   3. `admin_request_support_access` RPC (SECURITY DEFINER) — calls
 *      `is_site_admin(auth.uid())` inside Postgres and raises 42501 on failure.
 *
 * Token safety:
 *   The raw token is NEVER logged, included in Sentry extras, or returned in
 *   the action result. It flows ONLY through the `support_grant_token_once`
 *   cookie with `maxAge: 60` so the success page can surface it once.
 *
 * SOC 2 CC6.1: admin operations require authenticated site admin session.
 * SOC 2 CC7.2: every grant is audited via the SECURITY DEFINER RPC.
 */

import { z } from 'zod';
import { headers, cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { generateSupportToken } from '@/lib/support/token';
import * as Sentry from '@sentry/nextjs';

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
 * Flow:
 *   1. Validate FormData with Zod — reject early with field-level errors.
 *   2. Extract IP + UA from request headers.
 *   3. Generate a cryptographically random token and its SHA-256 hash.
 *   4. Call `admin_request_support_access` RPC (SECURITY DEFINER — enforces
 *      is_site_admin, scopes session to ticket's user_id, writes grant row).
 *   5. Flash the raw token as a non-HttpOnly cookie with maxAge: 60 (1 min).
 *      The success page reads it once, then deletes it.
 *   6. Redirect to the success page with the grant ID in the URL.
 *
 * WHY trustedTicketId parameter (Fix B pattern from Phase 4.1 T6):
 *   The URL param is the authoritative reference. The action is bound to
 *   the ticket ID server-side via `requestSupportAccessAction.bind(null, id)`
 *   in the page component. This prevents a tampered FormData ticket_id from
 *   creating a grant against a different ticket. The RPC also cross-checks
 *   that the session belongs to the ticket's user_id (22023 if not).
 *
 * WHY user-scoped client (not service-role):
 *   The SECURITY DEFINER RPC body calls `is_site_admin(auth.uid())`. With the
 *   service-role client there is no JWT context, so auth.uid() = NULL → 42501.
 *   The user-scoped client forwards the admin's session cookie so auth.uid()
 *   resolves correctly. Same pattern as all Phase 4.1 admin RPCs.
 *
 * WHY the raw token is NOT in the action return value:
 *   Server action return values can appear in the browser's network tab. We
 *   exclusively use the short-lived cookie channel to pass the token to the
 *   success page. The cookie is non-HttpOnly (the success page needs to read
 *   it on the client to clear it after display), but has maxAge: 60 so it
 *   self-destructs within 1 minute.
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
  // stores it. The raw token is displayed ONCE on the success page via cookie.
  // The raw token MUST NOT be logged, included in Sentry, or returned to the
  // client through any channel other than the one-time cookie.
  const { raw, hash } = generateSupportToken();

  // ── 4. Call SECURITY DEFINER RPC ──────────────────────────────────────────
  // WHY createClient() (user-scoped): auth.uid() must resolve to the admin's
  // UUID inside the RPC for is_site_admin() to pass. SOC 2 CC6.1, CC7.2.
  const supabase = await createClient();

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

  const { data: grantId, error } = await supabase.rpc('admin_request_support_access', {
    p_ticket_id: trustedTicketId,
    p_user_id: ticket.user_id,
    p_session_id: parsed.data.session_id,
    p_reason: parsed.data.reason,
    p_expires_in_hours: parsed.data.expires_in_hours,
    p_token_hash: hash,
  });

  if (error) return mapRpcError(error, 'request_support_access');

  // ── 5. Flash raw token via short-lived cookie ──────────────────────────────
  // SEC-COOKIE-001: Hardened from sameSite='lax' to 'strict'.
  //
  // WHY 'strict' is correct here (correcting the prior 'lax' rationale):
  // The redirect target (/dashboard/admin/support/[id]/request-access/success)
  // is same-site as the form-submission origin. SameSite=Strict ONLY drops
  // cookies on cross-site navigations — same-site server-action redirects
  // preserve the cookie. The previous comment claimed Strict would drop the
  // cookie on the redirect; that was factually incorrect for this flow. Strict
  // gives maximum CSRF protection for a 60-second read-once token without
  // breaking the redirect.
  //
  // WHY non-HttpOnly: the success page JS reads + clears this cookie after
  // displaying the raw token. HttpOnly cookies cannot be cleared from JS, and
  // we want the token gone the instant the admin sees it (defense-in-depth
  // against shoulder-surfing or stale tabs).
  //
  // WHY maxAge=60 (1 minute): tight window ensures the token self-destructs
  // even if the admin doesn't navigate to the success page immediately. We do
  // NOT use sessionStorage here because the redirect creates a new navigation
  // which would clear sessionStorage in some browsers.
  //
  // SECURITY: the raw token is the ONLY sensitive value in this cookie. The
  // grant ID in the redirect URL is not sensitive (it's a bigint primary key
  // visible only to admins).
  const cookieStore = await cookies();
  cookieStore.set('support_grant_token_once', raw, {
    httpOnly: false,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 60,
    path: '/',
  });

  // ── 6. Revalidate + redirect ───────────────────────────────────────────────
  revalidatePath(`/dashboard/admin/support/${trustedTicketId}`);
  redirect(
    `/dashboard/admin/support/${trustedTicketId}/request-access/success?grant=${grantId}`
  );

  // TypeScript requires a return even after redirect (which throws).
  return { ok: true, grantId: String(grantId) };
}
