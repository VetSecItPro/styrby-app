'use server';

/**
 * Server actions for user-facing churn-save offer acceptance.
 *
 * Phase 4.3 — Billing Ops T6
 *
 * One mutation exposed as a Next.js Server Action:
 *   acceptOfferAction(offerId) — user accepts an active churn_save_offer.
 *
 * Security model (3 layers):
 *   1. Next.js 15 server actions enforce `Action-Origin` same-origin — no manual
 *      CSRF token required. The user must affirmatively POST to accept.
 *   2. Middleware: /billing/offer/* requires authenticated session (any logged-in
 *      user may visit). Unauthenticated requests are redirected to /login.
 *   3. SECURITY DEFINER RPC (`user_accept_churn_save_offer`) — enforces
 *      offer.user_id = auth.uid() + expiry + not-accepted + not-revoked inside
 *      Postgres so a user cannot accept another user's offer even if they know
 *      the offer ID.
 *
 * SQLSTATE map:
 *   42501 — INSUFFICIENT_PRIVILEGE → 403 (wrong user or ownership mismatch)
 *   22023 — INVALID_PARAMETER_VALUE → 400 "Offer is no longer available"
 *           (already accepted, revoked, or expired)
 *   other — 500 + Sentry capture
 *
 * SOC 2 CC6.1: operations require authenticated session (RLS enforced).
 * SOC 2 CC7.2: every acceptance is audited via SECURITY DEFINER RPC.
 * GDPR Art. 7: acceptance requires an affirmative POST action — GET requests
 *   cannot trigger server actions.
 */

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import * as Sentry from '@sentry/nextjs';

// ─── Result type ──────────────────────────────────────────────────────────────

/**
 * Union of all result shapes for the churn-save offer acceptance action.
 *
 * WHY separate type: this action is user-facing and has different SQLSTATE
 * semantics from the admin billing actions (T5). Keeping it separate allows
 * per-action ergonomic typing at call sites.
 */
export type AcceptOfferActionResult =
  | { ok: true }
  | { ok: false; error: string; statusCode?: 400 | 403 | 500 };

// ─── Input schema ─────────────────────────────────────────────────────────────

/**
 * Validates a bigint offer ID from the URL parameter.
 *
 * WHY manual validation rather than Zod: the offerId is bound server-side from
 * a validated parseInt result. We revalidate defensively to guard against any
 * future refactor that might pass an unvalidated value.
 *
 * @param offerId - The offer ID to validate.
 * @returns true if valid, false if not.
 */
function isValidOfferId(offerId: number): boolean {
  return Number.isInteger(offerId) && offerId > 0 && Number.isFinite(offerId);
}

// ─── SQLSTATE → user-facing error mapping ─────────────────────────────────────

/**
 * Maps Postgres SQLSTATE codes from user_accept_churn_save_offer to safe
 * user-facing error messages. Never leaks internal SQL error text.
 *
 * Codes handled:
 *   42501 — INSUFFICIENT_PRIVILEGE: offer.user_id !== auth.uid() (wrong user).
 *   22023 — INVALID_PARAMETER_VALUE: offer is no longer available (already
 *            accepted, revoked, or expired per DB CHECK constraints).
 *
 * Anything else is an unexpected server error — captured in Sentry for ops triage.
 *
 * SOC 2 CC6.1: 42501 surfaces as 403 to signal ownership mismatch without
 * leaking internal authorization logic details.
 *
 * @param err - Error object from the Supabase RPC call.
 * @returns AcceptOfferActionResult with ok: false.
 */
function mapRpcError(
  err: { code?: string; message?: string }
): AcceptOfferActionResult & { ok: false } {
  if (err.code === '42501') {
    return {
      ok: false,
      error: 'You are not authorized to accept this offer',
      statusCode: 403,
    };
  }

  if (err.code === '22023') {
    return {
      ok: false,
      error: 'Offer is no longer available (already accepted, revoked, or expired)',
      statusCode: 400,
    };
  }

  // Unexpected error — capture in Sentry for ops triage.
  // WHY we DO NOT include any sensitive user or offer details in Sentry extras
  // beyond the SQLSTATE code: the offer ID is a non-sensitive PK. SOC 2 CC6.1.
  Sentry.captureException(new Error('user_accept_churn_save_offer failed'), {
    tags: {
      user_action: 'accept_churn_save_offer',
      sqlstate: err.code ?? 'unknown',
    },
    extra: {
      // rpc_message may contain internal table/column names — safe for Sentry
      // (ops-internal) but must NEVER reach the client response.
      rpc_message: err.message,
    },
  });

  return {
    ok: false,
    error: 'An unexpected error occurred. Please try again.',
    statusCode: 500,
  };
}

// ─── Server action ────────────────────────────────────────────────────────────

/**
 * Server action: accept an active churn-save offer.
 *
 * Flow:
 *   1. Validate offerId (positive integer check) — reject invalid IDs early.
 *   2. Call `user_accept_churn_save_offer(p_offer_id)` RPC (SECURITY DEFINER).
 *      The RPC enforces:
 *        - offer.user_id = auth.uid() (42501 if not)
 *        - accepted_at IS NULL (22023 if already accepted)
 *        - revoked_at IS NULL (22023 if revoked)
 *        - expires_at > now() (22023 if expired)
 *   3. On success — revalidate the offer page and redirect back to it.
 *      The page re-renders in the "accepted" state, showing the discount code.
 *   4. On error — map SQLSTATE to safe user-facing error and return.
 *
 * WHY user-scoped client (not service-role):
 *   The RPC body calls auth.uid() to enforce ownership. With service-role there
 *   is no JWT context → auth.uid() = NULL → ownership check fails → 42501.
 *   The user-scoped client forwards the user's session cookie so auth.uid()
 *   resolves to the correct UUID. SOC 2 CC6.1.
 *
 * WHY URL-binding pattern (.bind(null, offerId)):
 *   The offerId flows from the URL, not from a hidden form field. This prevents
 *   a tampered form from accepting a different user's offer. The page binds the
 *   action server-side: `acceptOfferAction.bind(null, offerId)`. The action
 *   never reads an offerId from FormData — it uses only the bound parameter.
 *
 * @param offerId - Offer ID from the URL param, bound server-side (unforgeable).
 * @returns AcceptOfferActionResult — never throws on success (redirect throws).
 */
export async function acceptOfferAction(offerId: number): Promise<AcceptOfferActionResult> {
  // ── 1. Validate offerId ────────────────────────────────────────────────────
  // WHY re-validate even though the page already validated: the action can be
  // called independently (e.g., via direct fetch or test), so defensive validation
  // here ensures the RPC is never called with a garbage ID. Follows the OWASP
  // server-side validation mandate (never trust client-side validation alone).
  if (!isValidOfferId(offerId)) {
    return { ok: false, error: 'Invalid offer ID', statusCode: 400 };
  }

  // ── 2. Call SECURITY DEFINER RPC ──────────────────────────────────────────
  // WHY createClient() (user-scoped): auth.uid() must resolve to the user's UUID
  // inside the RPC for the ownership check (offer.user_id = auth.uid()) to pass.
  // SOC 2 CC6.1, CC7.2.
  const supabase = await createClient();

  const { error } = await supabase.rpc('user_accept_churn_save_offer', {
    p_offer_id: offerId,
  });

  if (error) return mapRpcError(error);

  // ── 3. Revalidate + redirect ───────────────────────────────────────────────
  // WHY revalidatePath before redirect: ensures the offer page re-fetches from
  // Supabase on the next render, showing the accepted status and discount code
  // immediately without serving stale cached data.
  revalidatePath(`/billing/offer/${offerId}`);
  redirect(`/billing/offer/${offerId}`);

  // TypeScript requires a return even after redirect (which throws).
  return { ok: true };
}
