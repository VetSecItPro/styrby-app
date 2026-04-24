'use server';

/**
 * Billing Server Actions — `/dashboard/admin/users/[userId]/billing/actions.ts`
 *
 * Three server actions for admin billing operations:
 *   1. issueRefundAction — issues a Polar refund + writes audit row.
 *   2. issueCreditAction — grants account credit via Supabase RPC.
 *   3. sendChurnSaveOfferAction — sends a retention offer via Supabase RPC.
 *
 * Security model (3 layers — all must pass before any mutation runs):
 *   1. Next.js 15 server actions auto-validate the `Action-Origin` header.
 *      WHY no manual CSRF check: Next.js 15 enforces same-origin by rejecting
 *      requests whose `Action-Origin` header does not match the configured
 *      `origin`. Equivalent to a CSRF token check at the framework level.
 *   2. Middleware — returns 404 for non-site-admins before the action runs.
 *   3. SECURITY DEFINER RPCs — call `is_site_admin(auth.uid())` inside Postgres;
 *      mutations are impossible even if middleware is bypassed.
 *
 * WHY URL-binding (Fix B from Phase 4.1):
 *   Each action is bound via `.bind(null, userId)` on the page server component.
 *   The URL userId (unforgeable — from Next.js route params) is passed as the
 *   first `targetUserId` argument. A hidden FormData field `targetUserId` is
 *   cross-checked against this bound value. Mismatch → 400 + Sentry warning.
 *   This prevents an admin visiting /users/<A>/billing from being tricked into
 *   mutating <B> via a tampered form submission.
 *
 * WHY createClient() (user-scoped, NOT service-role) for RPC calls:
 *   The SECURITY DEFINER RPCs call `is_site_admin(auth.uid())`. With service-role
 *   there is no JWT context → auth.uid() = NULL → 42501 INSUFFICIENT_PRIVILEGE.
 *   The user-scoped client forwards the admin's session cookie so auth.uid()
 *   resolves correctly. SOC 2 CC6.1, CC7.2.
 *
 * SOC 2 CC6.1: admin operations require authenticated site admin session.
 * SOC 2 CC7.2: every mutation is audited in admin_audit_log via the RPC.
 */

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import * as Sentry from '@sentry/nextjs';
import { createPolarRefund, RefundError } from '@/lib/billing/polar-refund';
import type { AdminActionResult } from '@/app/dashboard/admin/users/[userId]/actions';

// Re-export AdminActionResult so sub-pages can import from this module too.
export type { AdminActionResult };

// ─── Input schemas (Zod) ──────────────────────────────────────────────────────

/**
 * Schema for the issue refund action.
 *
 * WHY subscription_id not UUID-validated: Polar subscription IDs are opaque
 * string identifiers — not necessarily UUIDs. We only enforce non-empty.
 *
 * WHY amount_cents is coerced via z.coerce.number: FormData values are always
 * strings; coerce handles the string→number conversion so the min/max/int
 * checks apply correctly.
 */
const IssueRefundSchema = z.object({
  targetUserId: z.string().uuid({ message: 'Invalid user ID' }),
  subscription_id: z
    .string()
    .min(1, { message: 'Subscription ID is required' })
    .max(255, { message: 'Subscription ID too long' }),
  amount_cents: z.coerce
    .number({ invalid_type_error: 'Amount must be a number' })
    .int({ message: 'Amount must be a whole number of cents' })
    .min(1, { message: 'Amount must be at least 1 cent' })
    .max(500_000, { message: 'Amount cannot exceed $5,000' }),
  reason: z
    .string()
    .min(10, { message: 'Reason must be at least 10 characters' })
    .max(500, { message: 'Reason must be 500 characters or fewer' }),
});

/**
 * Schema for the issue credit action.
 *
 * WHY expires_at is optional: credits can be permanent (no expiry) or
 * time-limited. A blank input from the form means no expiry.
 */
const IssueCreditSchema = z.object({
  targetUserId: z.string().uuid({ message: 'Invalid user ID' }),
  amount_cents: z.coerce
    .number({ invalid_type_error: 'Amount must be a number' })
    .int({ message: 'Amount must be a whole number of cents' })
    .min(1, { message: 'Amount must be at least 1 cent' })
    .max(100_000, { message: 'Amount cannot exceed $1,000' }),
  reason: z
    .string()
    .min(10, { message: 'Reason must be at least 10 characters' })
    .max(500, { message: 'Reason must be 500 characters or fewer' }),
  // WHY optional string: the form submits an empty string when not set.
  // Downstream we normalize: empty string → null, valid ISO → toISOString().
  expires_at: z.string().optional(),
});

/**
 * Schema for the send churn-save offer action.
 *
 * WHY kind is a strict enum: the server-side RPC derives discount_pct and
 * duration_months from the kind value — no client input for those fields.
 * Accepting only the known enum values here ensures the RPC always receives
 * a valid input. Unexpected kinds are rejected before hitting the wire.
 *
 * WHY polar_discount_code is optional: some offer kinds may not require a
 * Polar discount code (e.g., internal credits). Null is valid.
 */
const SendChurnSaveOfferSchema = z.object({
  targetUserId: z.string().uuid({ message: 'Invalid user ID' }),
  kind: z.enum(['annual_3mo_25pct', 'monthly_1mo_50pct'], {
    errorMap: () => ({ message: 'kind must be a valid offer type' }),
  }),
  reason: z
    .string()
    .min(10, { message: 'Reason must be at least 10 characters' })
    .max(500, { message: 'Reason must be 500 characters or fewer' }),
  polar_discount_code: z.string().max(255).optional().nullable(),
});

// ─── SQLSTATE → user-facing error mapping ─────────────────────────────────────

/**
 * Maps Postgres SQLSTATE codes returned by admin billing RPCs to safe
 * user-facing error messages. Never leaks internal SQL error text.
 *
 * Codes handled:
 *   42501 — INSUFFICIENT_PRIVILEGE: caller is not a site admin.
 *   22023 — INVALID_PARAMETER_VALUE: value rejected by the RPC.
 *   23514 — CHECK_VIOLATION: a constraint failed (e.g. empty reason).
 *
 * Anything else → unexpected server error, captured in Sentry.
 *
 * SOC 2 CC6.1: 42501 errors surface as "Not authorized" to avoid confirming
 * which admin guard failed to a potential attacker.
 *
 * @param err - Error object from the Supabase RPC call.
 * @param action - Name of the admin action for Sentry tagging.
 * @param targetUserId - Target user UUID for Sentry context.
 * @returns AdminActionResult with ok: false and a safe error message.
 */
function mapRpcError(
  err: { code?: string; message?: string },
  action: string,
  targetUserId?: string,
): { ok: false; error: string } {
  if (err.code === '42501') return { ok: false, error: 'Not authorized' };
  if (err.code === '22023') return { ok: false, error: 'Invalid input value' };
  if (err.code === '23514') return { ok: false, error: 'Reason is required' };

  // Unexpected error — capture full context in Sentry for ops triage.
  // WHY we log err.message here (not in the user-facing response):
  // The raw message may contain internal table/column names. Safe for Sentry
  // (ops-internal) but must never reach the client.
  Sentry.captureException(new Error(`admin billing action failed: ${action}`), {
    tags: {
      admin_action: action,
      sqlstate: err.code ?? 'unknown',
      ...(targetUserId ? { target_user_id: targetUserId } : {}),
    },
    extra: { rpc_message: err.message },
  });
  return { ok: false, error: 'Internal error — check Sentry' };
}

// ─── Server actions ───────────────────────────────────────────────────────────

/**
 * Server action: issue a refund for a user's subscription.
 *
 * Flow:
 *   1. Zod validate FormData.
 *   2. URL cross-check: FormData.targetUserId must match bound `targetUserId` param.
 *   3. Build idempotency key (rounded to the current minute to prevent rapid double-submit).
 *   4. Call `createPolarRefund()` — issues the refund via Polar SDK.
 *      On 'idempotent-replay': treat as success (refund already issued).
 *      On 'invalid': return { ok: false } with Polar's rejection reason.
 *      On 'polar-error': Sentry + { ok: false, error: 'Polar temporarily unavailable' }.
 *      On 'network'/'config': Sentry + { ok: false, error: 'Internal error' }.
 *   5. Call `admin_issue_refund` RPC with Polar event/refund IDs.
 *      If RPC returns 0: Sentry warn (audit-orphan — refund event row exists without audit).
 *   6. revalidatePath + redirect to billing dossier.
 *
 * WHY Polar call before RPC (not after):
 *   The Polar refund is the money-moving operation. We record it in Supabase
 *   only after Polar confirms it. If the RPC write fails after a successful Polar
 *   call, the audit is missing but no extra money moved. The reverse (RPC first,
 *   Polar fails) would write an audit row for a refund that never happened —
 *   worse for SOC 2 CC7.2 integrity. SOC 2 CC7.2.
 *
 * WHY idempotency key rounded to the minute:
 *   Rounding prevents rapid double-submit within the same minute (e.g. double-click).
 *   The Polar SDK deduplicates on its side when the same key is sent twice.
 *   After one minute, a new key is generated so a legitimate retry (e.g. next day)
 *   is not blocked by the old idempotency key.
 *
 * @param targetUserId - UUID from the URL param, bound server-side via `.bind(null, userId)`.
 * @param formData - FormData from IssueRefundForm.
 * @returns AdminActionResult — never throws (errors returned as { ok: false }).
 */
export async function issueRefundAction(
  targetUserId: string,
  formData: FormData,
): Promise<AdminActionResult> {
  // ── 0. URL vs FormData cross-check (Fix B) ────────────────────────────────
  // WHY: if FormData.targetUserId was tampered to a different UUID, the audit
  // row and mutation would apply to the wrong user while the admin believes they
  // acted on the URL user. Hard error + Sentry warning. Phase 4.1 T6 Fix B.
  const fdUserId = formData.get('targetUserId');
  if (fdUserId !== targetUserId) {
    Sentry.captureMessage(
      'admin issue-refund: targetUserId mismatch between URL and FormData',
      {
        level: 'warning',
        tags: {
          admin_action: 'issue_refund',
          trusted_user_id: targetUserId,
          form_user_id: String(fdUserId),
        },
      },
    );
    return { ok: false, error: 'targetUserId mismatch with URL context' };
  }

  // ── 1. Validate input ──────────────────────────────────────────────────────
  const parsed = IssueRefundSchema.safeParse({
    targetUserId: formData.get('targetUserId'),
    // WHY subscriptionId field: the IssueRefundForm submits the select value
    // under name="subscriptionId". We read it here and map to the schema key.
    subscription_id: formData.get('subscriptionId') ?? formData.get('subscription_id'),
    // WHY amount_cents from FormData: the form stores the converted cents value
    // in a hidden field 'amount_cents' after client-side dollar→cent conversion.
    amount_cents: formData.get('amount_cents'),
    reason: formData.get('reason'),
  });

  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    return {
      ok: false,
      error: firstIssue?.message ?? 'Invalid input',
      field: firstIssue?.path.join('.'),
    };
  }

  const { subscription_id, amount_cents, reason } = parsed.data;

  // ── 2. Build idempotency key (minute-rounded to prevent rapid double-submit) ─
  // WHY minute rounding: collisions within the same minute are treated as the
  // same intent (double-click). A new key after 60s allows legitimate retries.
  // The key encodes targetUserId + subscription + amount to prevent cross-user
  // collision even if two admins submit simultaneously. SOC 2 CC7.2.
  const nowRoundedToMinute = Math.floor(Date.now() / 60_000) * 60_000;
  const idempotencyKey = `${targetUserId}:${subscription_id}:${amount_cents}:${nowRoundedToMinute}`;

  // ── 3. Issue refund via Polar SDK ──────────────────────────────────────────
  // WHY createPolarRefund before RPC: Polar is the authoritative money-moving
  // system. We write to Supabase only after Polar confirms. SOC 2 CC7.2.
  let polarRefundId: string;
  let polarEventId: string;
  let polarResponseJson: unknown;

  try {
    const refundResult = await createPolarRefund({
      subscriptionId: subscription_id,
      // WHY subscriptionId as orderId: the admin UI references subscriptions, not
      // individual orders. The spec accepts subscriptionId here; when Polar exposes
      // a dedicated orderId lookup endpoint, this should be updated accordingly.
      orderId: subscription_id,
      amountCents: amount_cents,
      reason,
      idempotencyKey,
    });
    polarRefundId = refundResult.refundId;
    polarEventId = refundResult.eventId;
    polarResponseJson = refundResult.rawResponse;
  } catch (err) {
    if (err instanceof RefundError) {
      switch (err.code) {
        case 'idempotent-replay':
          // WHY treat as success: the refund was already issued. Polar's response
          // means no new money moved, but the admin's intent was fulfilled.
          // We still continue to the RPC write to ensure the audit row exists.
          // Fall through to use placeholder IDs — the webhook handler will have
          // already stored the real refund data via polar_refund_events.
          polarRefundId = 'idempotent-replay';
          polarEventId = 'idempotent-replay';
          polarResponseJson = { idempotentReplay: true };
          break;

        case 'invalid':
          // WHY not Sentry: 'invalid' means Polar rejected a bad request (4xx).
          // This is an expected failure condition — no server error to track.
          return { ok: false, error: `Polar rejected: ${err.message}` };

        case 'polar-error':
          // WHY Sentry: Polar 5xx indicates a transient platform issue.
          // Log for monitoring; admin can retry.
          Sentry.captureException(err, {
            tags: {
              admin_action: 'issue_refund',
              target_user_id: targetUserId,
              refund_error_code: err.code,
            },
          });
          return { ok: false, error: 'Polar temporarily unavailable — retry' };

        case 'network':
        case 'config':
          // WHY Sentry: network errors and config errors are ops issues that need
          // investigation. The admin cannot resolve these themselves.
          Sentry.captureException(err, {
            tags: {
              admin_action: 'issue_refund',
              target_user_id: targetUserId,
              refund_error_code: err.code,
            },
          });
          return { ok: false, error: 'Internal error' };

        default: {
          // Exhaustive check — TypeScript narrows err.code to never here.
          const _exhaustive: never = err.code;
          void _exhaustive;
          Sentry.captureException(err, {
            tags: { admin_action: 'issue_refund', target_user_id: targetUserId },
          });
          return { ok: false, error: 'Internal error' };
        }
      }
    } else {
      // Unexpected non-RefundError — should not happen in practice.
      Sentry.captureException(err, {
        tags: { admin_action: 'issue_refund', target_user_id: targetUserId },
      });
      return { ok: false, error: 'Internal error' };
    }
  }

  // ── 4. Write audit row via SECURITY DEFINER RPC ───────────────────────────
  // WHY createClient() (user-scoped): see module JSDoc. SOC 2 CC6.1.
  const supabase = await createClient();

  const { data: auditId, error: rpcErr } = await supabase.rpc('admin_issue_refund', {
    p_target_user_id: targetUserId,
    p_amount_cents: amount_cents,
    p_currency: 'usd',
    p_reason: reason,
    p_polar_event_id: polarEventId,
    p_polar_refund_id: polarRefundId,
    // WHY pass subscription_id explicitly: migration 051 admin_issue_refund has
    // 8 params — the 7th is p_polar_subscription_id. Nullable in DB so a
    // one-time charge that has no subscription passes null here. GDPR/SOC2:
    // linking the audit row to the Polar subscription enables charge reconciliation
    // and supports chargeback investigations without querying Polar directly.
    p_polar_subscription_id: subscription_id,
    p_polar_response_json: polarResponseJson,
  });

  if (rpcErr) return mapRpcError(rpcErr, 'issue_refund', targetUserId);

  // ── 5. Audit-orphan guard: RPC returned 0 rows ────────────────────────────
  // WHY treat return 0 as alert (not success): if admin_issue_refund returns 0,
  // the refund event row already existed (ON CONFLICT DO NOTHING) but an audit
  // row was expected. This is an inconsistency that ops should investigate.
  // We log to Sentry at warn severity and continue (refund event exists — money
  // is handled correctly; only the audit trail may have a gap). Carryover T2 review.
  if (auditId === 0) {
    Sentry.captureMessage(
      'admin_issue_refund audit orphan — refund event exists without audit row',
      {
        level: 'warning',
        tags: {
          admin_action: 'issue_refund',
          target_user_id: targetUserId,
        },
        extra: {
          polar_refund_id: polarRefundId,
          polar_event_id: polarEventId,
          note: 'Polar refund event row already existed; audit row not written. Reconcile manually.',
        },
      },
    );
    // Continue — the refund was processed; only the audit row is missing.
  }

  // ── 6. Revalidate + redirect ───────────────────────────────────────────────
  revalidatePath(`/dashboard/admin/users/${targetUserId}/billing`);
  redirect(`/dashboard/admin/users/${targetUserId}/billing`);

  // TypeScript requires explicit return after redirect (which throws).
  return { ok: true };
}

/**
 * Server action: issue account credit to a user.
 *
 * Flow:
 *   1. Zod validate FormData.
 *   2. URL cross-check (Fix B).
 *   3. Normalize expires_at: blank string → null; non-blank → validate + toISOString().
 *   4. Call `admin_issue_credit` RPC (SECURITY DEFINER).
 *   5. SQLSTATE map.
 *   6. revalidatePath + redirect.
 *
 * WHY expires_at normalization here (not Zod):
 *   FormData always submits strings. An empty datetime input sends an empty string.
 *   We parse and normalize before passing to the RPC so Postgres receives a proper
 *   ISO timestamp or NULL — not an empty string or a malformed date.
 *
 * @param targetUserId - UUID from the URL param, bound server-side via `.bind(null, userId)`.
 * @param formData - FormData from IssueCreditForm.
 * @returns AdminActionResult — never throws (errors returned as { ok: false }).
 */
export async function issueCreditAction(
  targetUserId: string,
  formData: FormData,
): Promise<AdminActionResult> {
  // ── 0. URL vs FormData cross-check (Fix B) ────────────────────────────────
  const fdUserId = formData.get('targetUserId');
  if (fdUserId !== targetUserId) {
    Sentry.captureMessage(
      'admin issue-credit: targetUserId mismatch between URL and FormData',
      {
        level: 'warning',
        tags: {
          admin_action: 'issue_credit',
          trusted_user_id: targetUserId,
          form_user_id: String(fdUserId),
        },
      },
    );
    return { ok: false, error: 'targetUserId mismatch with URL context' };
  }

  // ── 1. Validate input ──────────────────────────────────────────────────────
  const parsed = IssueCreditSchema.safeParse({
    targetUserId: formData.get('targetUserId'),
    amount_cents: formData.get('amount_cents'),
    reason: formData.get('reason'),
    expires_at: (formData.get('expires_at') as string | null) ?? '',
  });

  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    return {
      ok: false,
      error: firstIssue?.message ?? 'Invalid input',
      field: firstIssue?.path.join('.'),
    };
  }

  const { amount_cents, reason, expires_at: rawExpiresAt } = parsed.data;

  // ── 2. Normalize expires_at ───────────────────────────────────────────────
  // WHY normalize here: empty string from the form means "no expiry" (permanent
  // credit). A non-empty string must be a valid date — invalid dates are rejected
  // with a 400-equivalent error rather than forwarded to Postgres, which would
  // throw a cryptic type error. SOC 2 CC7.2 requires well-formed audit data.
  let normalizedExpiresAt: string | null = null;
  if (rawExpiresAt && rawExpiresAt.trim() !== '') {
    const parsed_date = new Date(rawExpiresAt);
    if (isNaN(parsed_date.getTime())) {
      return { ok: false, error: 'Invalid expires_at date', field: 'expires_at' };
    }
    normalizedExpiresAt = parsed_date.toISOString();
  }

  // ── 3. Call SECURITY DEFINER RPC ──────────────────────────────────────────
  // WHY createClient() (user-scoped): see module JSDoc. SOC 2 CC6.1, CC7.2.
  const supabase = await createClient();

  const { data: rpcData, error: rpcErr } = await supabase.rpc('admin_issue_credit', {
    p_target_user_id: targetUserId,
    p_amount_cents: amount_cents,
    p_currency: 'usd',
    p_reason: reason,
    p_expires_at: normalizedExpiresAt,
  });

  if (rpcErr) return mapRpcError(rpcErr, 'issue_credit', targetUserId);

  // WHY unused rpcData: the RPC returns { audit_id, credit_id } for logging.
  // We don't surface these in the redirect but they're available for future use
  // (e.g., linking to the specific credit row from the success state).
  void rpcData;

  // ── 4. Revalidate + redirect ───────────────────────────────────────────────
  revalidatePath(`/dashboard/admin/users/${targetUserId}/billing`);
  redirect(`/dashboard/admin/users/${targetUserId}/billing`);

  return { ok: true };
}

/**
 * Server action: send a churn-save retention offer to a user.
 *
 * Flow:
 *   1. Zod validate FormData (strict kind enum).
 *   2. URL cross-check (Fix B).
 *   3. Call `admin_send_churn_save_offer` RPC (SECURITY DEFINER).
 *   4. Handle SQLSTATE 22023 as "active offer exists" → user-friendly error.
 *   5. revalidatePath + redirect.
 *
 * WHY kind enum is server-enforced (not just form validation):
 *   The RPC derives discount_pct and duration_months from the kind on the server
 *   side — these values never come from client input. Validating kind as a strict
 *   enum here ensures the RPC always receives a known value. This is defense-in-
 *   depth; the RPC also validates kind, but catching it earlier gives cleaner errors.
 *
 * WHY SQLSTATE 22023 = active offer exists:
 *   The RPC raises SQLSTATE 22023 (INVALID_PARAMETER_VALUE) when a partial unique
 *   index check fails for "no active offer for this user + kind". This is a
 *   domain-specific use of 22023 (not a generic param error), so we return a
 *   user-friendly message specifically for this action rather than the generic
 *   "Invalid input value" used by mapRpcError. SOC 2 CC7.2.
 *
 * @param targetUserId - UUID from the URL param, bound server-side via `.bind(null, userId)`.
 * @param formData - FormData from SendChurnSaveOfferForm.
 * @returns AdminActionResult — never throws (errors returned as { ok: false }).
 */
export async function sendChurnSaveOfferAction(
  targetUserId: string,
  formData: FormData,
): Promise<AdminActionResult> {
  // ── 0. URL vs FormData cross-check (Fix B) ────────────────────────────────
  const fdUserId = formData.get('targetUserId');
  if (fdUserId !== targetUserId) {
    Sentry.captureMessage(
      'admin send-churn-save-offer: targetUserId mismatch between URL and FormData',
      {
        level: 'warning',
        tags: {
          admin_action: 'send_churn_save_offer',
          trusted_user_id: targetUserId,
          form_user_id: String(fdUserId),
        },
      },
    );
    return { ok: false, error: 'targetUserId mismatch with URL context' };
  }

  // ── 1. Validate input ──────────────────────────────────────────────────────
  const rawPolarCode = formData.get('polar_discount_code');
  const parsed = SendChurnSaveOfferSchema.safeParse({
    targetUserId: formData.get('targetUserId'),
    kind: formData.get('kind'),
    reason: formData.get('reason'),
    // WHY normalize empty string to null: an empty discount code field should be
    // stored as NULL in Postgres, not as an empty string, to distinguish
    // "not provided" from "provided but blank".
    polar_discount_code:
      typeof rawPolarCode === 'string' && rawPolarCode.trim() !== ''
        ? rawPolarCode.trim()
        : null,
  });

  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    return {
      ok: false,
      error: firstIssue?.message ?? 'Invalid input',
      field: firstIssue?.path.join('.'),
    };
  }

  const { kind, reason, polar_discount_code } = parsed.data;

  // ── 2. Call SECURITY DEFINER RPC ──────────────────────────────────────────
  // WHY createClient() (user-scoped): see module JSDoc. SOC 2 CC6.1, CC7.2.
  const supabase = await createClient();

  const { data: rpcData, error: rpcErr } = await supabase.rpc('admin_send_churn_save_offer', {
    p_target_user_id: targetUserId,
    p_kind: kind,
    p_reason: reason,
    p_polar_discount_code: polar_discount_code ?? null,
  });

  if (rpcErr) {
    // WHY special-case 22023 for this action: the RPC uses SQLSTATE 22023 to
    // signal that an active offer already exists for this user + kind. This is
    // a predictable domain constraint (not a generic input error), so we return
    // a specific message rather than the generic "Invalid input value".
    // The page already warns about existing offers but the admin may have proceeded
    // anyway (or the offer appeared between page load and form submit).
    if (rpcErr.code === '22023') {
      return {
        ok: false,
        error: 'Active offer already exists for this user + kind',
      };
    }
    return mapRpcError(rpcErr, 'send_churn_save_offer', targetUserId);
  }

  // WHY unused rpcData: the RPC returns { audit_id, offer_id } for logging.
  // Available for future use (e.g., linking to the offer from success state).
  void rpcData;

  // ── 3. Revalidate + redirect ───────────────────────────────────────────────
  revalidatePath(`/dashboard/admin/users/${targetUserId}/billing`);
  redirect(`/dashboard/admin/users/${targetUserId}/billing`);

  return { ok: true };
}
