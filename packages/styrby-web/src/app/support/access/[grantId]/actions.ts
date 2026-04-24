'use server';

/**
 * Server actions for user-facing support access grant management.
 *
 * Phase 4.2 — Support Tooling T5
 *
 * Two mutations exposed as Next.js Server Actions:
 *   1. approveAction(grantId) — user approves a pending support_access_grant.
 *   2. revokeAction(grantId)  — user revokes an approved (or pending) grant.
 *
 * Security model (3 layers):
 *   1. Next.js 15 server actions enforce `Action-Origin` same-origin — no manual
 *      CSRF token required. GDPR Art. 7 compliance: the user must affirmatively
 *      POST to approve — no query-param auto-approve.
 *   2. Middleware: /support/access/* requires authenticated session (any logged-in
 *      user may visit). Unauthenticated requests are redirected to /login.
 *   3. SECURITY DEFINER RPCs (`user_approve_support_access`,
 *      `user_revoke_support_access`) — enforce grant.user_id = auth.uid() inside
 *      Postgres so a user cannot approve or revoke another user's grant even if
 *      they know the grant ID.
 *
 * Token safety:
 *   The raw support access token is NEVER visible to the user at any point.
 *   Only the grant ID (bigint primary key) flows through the URL.
 *
 * GDPR Art. 7:
 *   Approval requires an affirmative POST action. A query-param auto-approve
 *   pattern (e.g. `?action=approve`) would allow phishing links to approve grants
 *   without user intent, violating the "freely given, specific, informed" standard.
 *   Server actions enforce this because GET requests cannot trigger server actions.
 *
 * SOC 2 CC6.1: operations require authenticated session (RLS enforced).
 * SOC 2 CC7.2: every mutation is audited via SECURITY DEFINER RPCs.
 */

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import * as Sentry from '@sentry/nextjs';

// ─── Shared action result type ────────────────────────────────────────────────

/**
 * Union of all result shapes for user support-access actions.
 *
 * WHY separate from AdminActionResult: these actions are user-facing and have
 * different SQLSTATE mappings. Keeping them separate avoids confusion at call
 * sites and allows per-action ergonomic typing.
 */
export type UserSupportAccessActionResult =
  | { ok: true }
  | { ok: false; error: string; statusCode?: 400 | 403 | 500 };

// ─── Input schema ─────────────────────────────────────────────────────────────

/**
 * Zod schema for a grantId path parameter.
 *
 * WHY coerce + int + positive:
 *   - `coerce` handles the string→number conversion from URL params / FormData.
 *   - `int()` rejects floats (e.g. "1.5") which would pass the RPC bigint cast
 *     but are not valid grant IDs.
 *   - `positive()` rejects zero and negative IDs — no valid PK is ≤ 0.
 *
 * WHY not z.bigint(): JavaScript's `BigInt` does not JSON-serialize cleanly and
 * Supabase JS client converts `bigint` columns to `number` in JS. We use `number`
 * throughout and rely on Postgres bigint casting in the RPC.
 */
const GrantIdSchema = z.coerce.number().int().positive({ message: 'Invalid grant ID' });

// ─── SQLSTATE → user-facing error mapping ─────────────────────────────────────

/**
 * Maps Postgres SQLSTATE codes from user_approve/revoke_support_access to safe
 * user-facing error messages. Never leaks internal SQL error text.
 *
 * Codes handled:
 *   42501 — INSUFFICIENT_PRIVILEGE: grant.user_id !== auth.uid() (wrong user).
 *   22023 — INVALID_PARAMETER_VALUE: invalid grant state transition (e.g. trying
 *            to approve an already-revoked grant, or a non-existent grant ID).
 *
 * Anything else is an unexpected server error — captured in Sentry for ops triage.
 *
 * SOC 2 CC6.1: 42501 surfaces as 403 to signal "you don't own this grant"
 * without leaking internal authorization logic details.
 *
 * @param err    - Error object from the Supabase RPC call.
 * @param action - Action name for Sentry tagging ('approve' | 'revoke').
 * @returns UserSupportAccessActionResult with ok: false.
 */
function mapRpcError(
  err: { code?: string; message?: string },
  action: string
): UserSupportAccessActionResult & { ok: false } {
  if (err.code === '42501') {
    return { ok: false, error: 'You are not authorized to modify this grant', statusCode: 403 };
  }
  if (err.code === '22023') {
    return {
      ok: false,
      error: 'This grant cannot be modified in its current state',
      statusCode: 400,
    };
  }

  // Unexpected error — capture in Sentry for ops triage.
  // WHY we DO NOT include any token or grant details in Sentry extras beyond
  // the grant ID: the grant ID is a non-sensitive PK. The raw token is never
  // visible at this layer (it lives only in the DB as a hash). SOC 2 CC6.1.
  Sentry.captureException(new Error(`user support-access action failed: ${action}`), {
    tags: {
      user_action: action,
      sqlstate: err.code ?? 'unknown',
    },
    extra: {
      // rpc_message may contain internal table/column names — safe for Sentry
      // (ops-internal) but must NEVER reach the client response.
      rpc_message: err.message,
    },
  });

  return { ok: false, error: 'An unexpected error occurred. Please try again.', statusCode: 500 };
}

// ─── Server actions ───────────────────────────────────────────────────────────

/**
 * Server action: approve a pending support access grant.
 *
 * Flow:
 *   1. Validate grantId (Zod) — reject non-positive integers early.
 *   2. Call `user_approve_support_access(p_grant_id)` RPC (SECURITY DEFINER).
 *      The RPC enforces grant.user_id = auth.uid() (42501 if not).
 *   3. On success — revalidate the grant page and redirect back to it.
 *   4. On error — map SQLSTATE to safe user-facing error and return.
 *
 * WHY user-scoped client (not service-role):
 *   The RPC body calls auth.uid() to enforce ownership. With service-role there
 *   is no JWT context → auth.uid() = NULL → ownership check fails → 42501.
 *   The user-scoped client forwards the user's session cookie so auth.uid()
 *   resolves to the correct UUID. SOC 2 CC6.1.
 *
 * WHY URL-binding pattern (.bind(null, grantId)):
 *   The grantId flows from the URL, not from a hidden form field. This prevents
 *   a tampered form from approving a different user's grant. The page binds the
 *   action server-side: `approveAction.bind(null, grantId)`. The action never
 *   reads a grantId from FormData — it uses only the bound parameter.
 *
 * GDPR Art. 7 compliance:
 *   This action is only reachable via a POST (server action). The page renders
 *   a visible "Approve access" button the user must explicitly click. There is no
 *   query-param or GET-based auto-approve path.
 *
 * @param grantId - Grant ID from the URL param, bound server-side (unforgeable).
 * @returns UserSupportAccessActionResult — never throws on success (redirect throws).
 */
export async function approveAction(grantId: number): Promise<UserSupportAccessActionResult> {
  // ── 1. Validate grantId ────────────────────────────────────────────────────
  const parsed = GrantIdSchema.safeParse(grantId);
  if (!parsed.success) {
    return { ok: false, error: 'Invalid grant ID', statusCode: 400 };
  }

  // ── 2. Call SECURITY DEFINER RPC ──────────────────────────────────────────
  // WHY createClient() (user-scoped): auth.uid() must resolve to the user's UUID
  // inside the RPC for the ownership check (grant.user_id = auth.uid()) to pass.
  // SOC 2 CC6.1, CC7.2.
  const supabase = await createClient();

  const { error } = await supabase.rpc('user_approve_support_access', {
    p_grant_id: parsed.data,
  });

  if (error) return mapRpcError(error, 'approve');

  // ── 3. Revalidate + redirect ───────────────────────────────────────────────
  // WHY revalidatePath before redirect: ensures the grant page re-fetches from
  // Supabase on the next render, showing the approved status immediately.
  revalidatePath(`/support/access/${grantId}`);
  redirect(`/support/access/${grantId}`);

  // TypeScript requires a return even after redirect (which throws).
  return { ok: true };
}

/**
 * Server action: revoke an active (approved or pending) support access grant.
 *
 * The RPC is idempotent — calling it on a terminal state (already revoked,
 * expired, or consumed) returns success (0 rows affected) rather than an error.
 * We treat 0-row updates as success so the user sees a consistent "revoked"
 * state regardless of concurrent revocations.
 *
 * Flow:
 *   1. Validate grantId (Zod).
 *   2. Call `user_revoke_support_access(p_grant_id)` RPC (SECURITY DEFINER).
 *   3. On success (or idempotent no-op) — revalidate relevant path(s) + redirect.
 *   4. On error — map SQLSTATE to safe user-facing error and return.
 *
 * WHY idempotent:
 *   Mobile notifications or back-button navigation may cause the revoke form to
 *   submit twice. The RPC is designed to be a no-op on terminal states so double-
 *   submission never creates an error the user has to deal with.
 *
 * WHY optional sessionId:
 *   When this action is invoked from the SessionPrivacyBanner on a session detail
 *   page, we revalidate the session page so the banner disappears immediately.
 *   When invoked from the /support/access/[grantId] page (the original call site),
 *   sessionId is omitted and we redirect back to that page as before.
 *   Both call sites bind grantId server-side — sessionId is bound the same way
 *   to prevent FormData tampering.
 *
 * @param grantId  - Grant ID from the URL param, bound server-side (unforgeable).
 * @param sessionId - Optional session UUID. When provided, revalidates the session
 *                    detail page so the banner disappears and redirects there.
 *                    When omitted, redirects back to /support/access/[grantId].
 * @returns UserSupportAccessActionResult.
 */
export async function revokeAction(
  grantId: number,
  sessionId?: string,
): Promise<UserSupportAccessActionResult> {
  // ── 1. Validate grantId ────────────────────────────────────────────────────
  const parsed = GrantIdSchema.safeParse(grantId);
  if (!parsed.success) {
    return { ok: false, error: 'Invalid grant ID', statusCode: 400 };
  }

  // ── 2. Call SECURITY DEFINER RPC ──────────────────────────────────────────
  const supabase = await createClient();

  const { error } = await supabase.rpc('user_revoke_support_access', {
    p_grant_id: parsed.data,
  });

  if (error) return mapRpcError(error, 'revoke');

  // ── 3. Revalidate + redirect ───────────────────────────────────────────────
  // WHY always revalidate the grant page: even when the action originates from
  // the session banner, a user may navigate back to the grant page. Revalidating
  // both ensures consistent state across all surfaces that display grant status.
  revalidatePath(`/support/access/${grantId}`);

  if (sessionId) {
    // Called from the SessionPrivacyBanner on the session detail page.
    // Revalidate the session page so the banner disappears, then redirect
    // back to the session (not away from it — the user was viewing their session).
    revalidatePath(`/dashboard/sessions/${sessionId}`);
    redirect(`/dashboard/sessions/${sessionId}`);
  } else {
    // Called from the /support/access/[grantId] page — original behavior.
    redirect(`/support/access/${grantId}`);
  }

  return { ok: true };
}
