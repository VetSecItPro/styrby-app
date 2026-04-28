'use server';

/**
 * Server actions for admin user mutations.
 *
 * Three mutations exposed as Next.js Server Actions:
 *   1. overrideTierAction — sets subscription tier with an optional expiry.
 *   2. resetPasswordAction — records audit row then sends Supabase magic link.
 *   3. toggleConsentAction — grants or revokes a per-user consent flag.
 *
 * Security model (3 layers — all must pass before any mutation runs):
 *   1. Next.js 15 server actions auto-validate the `Action-Origin` header.
 *      WHY no manual CSRF check: Next.js 15 server actions enforce same-origin
 *      by rejecting requests whose `Action-Origin` header does not match the
 *      configured `origin`. This is equivalent to a CSRF token check at the
 *      framework level — we don't need to add one ourselves.
 *   2. Middleware (T3) — returns 404 for non-site-admins before the action runs.
 *   3. SECURITY DEFINER RPCs (T2) — call `is_site_admin(auth.uid())` inside
 *      Postgres; mutations are impossible even if the middleware is bypassed.
 *
 * SOC 2 CC6.1: admin operations require authenticated site admin session.
 * SOC 2 CC7.2: every mutation is audited in admin_audit_log via the RPC.
 *
 * Deploy-time assertion (infra, not runtime):
 *   Verify that `has_schema_privilege('authenticated', 'public', 'CREATE')` is
 *   `false` on prod. The `authenticated` Postgres role must not have CREATE
 *   schema privileges. Check this in the Supabase SQL editor after each migration.
 */

import { z } from 'zod';
import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createAdminClient, createClient } from '@/lib/supabase/server';
import * as Sentry from '@sentry/nextjs';
import { assertAdminMfa, AdminMfaRequiredError } from '@/lib/admin/mfa-gate';

// ─── Shared types ─────────────────────────────────────────────────────────────

/** Union of all possible admin action result shapes. */
export type AdminActionResult =
  | { ok: true; warning?: string }
  | { ok: false; error: string; field?: string };

// ─── Input schemas (Zod) ──────────────────────────────────────────────────────

/**
 * Schema for the tier override action.
 *
 * WHY validate targetUserId as UUID: prevents malformed strings from reaching
 * the RPC. The Postgres `uuid` type would also reject them, but validating at
 * the app layer gives a cleaner user-facing error and avoids a round-trip.
 *
 * WHY reason max 500 chars: reasonable cap to prevent abuse of the audit log
 * as a free-text storage medium while allowing full justification context.
 */
const OverrideTierSchema = z.object({
  targetUserId: z.string().uuid({ message: 'Invalid user ID' }),
  newTier: z.enum(['free', 'pro', 'power', 'team', 'business', 'enterprise'], {
    errorMap: () => ({ message: 'newTier must be a valid tier' }),
  }),
  expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
  reason: z
    .string()
    .min(1, { message: 'Reason is required' })
    .max(500, { message: 'Reason must be 500 characters or fewer' }),
});

/**
 * Schema for the password reset action.
 *
 * WHY targetEmail is NOT in this schema (C1 fix):
 *   The original schema accepted targetEmail from FormData (a hidden field).
 *   An admin could tamper that field via browser devtools to redirect the
 *   recovery magic-link to an email they control — a full account-takeover
 *   primitive. The fix: accept only targetUserId + reason here; the email
 *   is fetched server-side via the trusted Supabase Auth Admin API inside
 *   the action body, never from client-supplied FormData. T6 quality review #C1.
 */
const ResetPasswordSchema = z.object({
  targetUserId: z.string().uuid({ message: 'Invalid user ID' }),
  reason: z
    .string()
    .min(1, { message: 'Reason is required' })
    .max(500, { message: 'Reason must be 500 characters or fewer' }),
});

/**
 * Schema for the toggle consent action.
 *
 * WHY purpose is a literal union (not free-text): only pre-approved consent
 * purposes exist. The DB has a Postgres ENUM — we mirror it here so invalid
 * values are rejected in TypeScript before reaching the wire.
 */
const ToggleConsentSchema = z.object({
  targetUserId: z.string().uuid({ message: 'Invalid user ID' }),
  purpose: z.enum(['support_read_metadata'], {
    errorMap: () => ({ message: 'purpose must be a valid consent purpose' }),
  }),
  grant: z.enum(['true', 'false'], {
    errorMap: () => ({ message: 'grant must be "true" or "false"' }),
  }),
  reason: z
    .string()
    .min(1, { message: 'Reason is required' })
    .max(500, { message: 'Reason must be 500 characters or fewer' }),
});

// ─── Header utilities ─────────────────────────────────────────────────────────

/**
 * Extracts the first valid IP from the `x-forwarded-for` header.
 *
 * WHY x-forwarded-for: Vercel sets this header to the originating client IP
 * for all requests, including those behind the Vercel edge network. The first
 * IP in the comma-separated list is the original client (left-most = least
 * trusted proxy). We take the first entry after trimming whitespace.
 *
 * WHY allow null: the header may be absent in local dev / test environments.
 * The RPC accepts NULL for p_ip, so we pass null cleanly.
 *
 * @param xff - Value of the `x-forwarded-for` header, or null if absent.
 * @returns The first IP string, or null if the header is empty/absent.
 */
function extractIP(xff: string | null): string | null {
  if (!xff) return null;
  const first = xff.split(',')[0].trim();
  // WHY length check: guard against pathological values like "," which would
  // produce an empty string. A valid IP has at least 3 chars (e.g. "1.1").
  return first.length >= 2 ? first : null;
}

// ─── SQLSTATE → HTTP error mapping ───────────────────────────────────────────

/**
 * Maps Postgres SQLSTATE codes returned by admin RPCs to safe user-facing
 * error messages. Never leaks internal SQL error text.
 *
 * Codes handled:
 *   42501 — INSUFFICIENT_PRIVILEGE: the caller is not a site admin.
 *   22023 — INVALID_PARAMETER_VALUE: a value rejected by the RPC (e.g. bad tier).
 *   23514 — CHECK_VIOLATION: a constraint failed (e.g. empty reason string).
 *
 * Anything else is an unexpected server error — captured in Sentry with the
 * admin action name and SQLSTATE so on-call can triage without a user report.
 *
 * SOC 2 CC6.1: 42501 errors surface as "Not authorized" to avoid confirming
 * which admin guard failed to a potential attacker.
 *
 * @param err - Error object from the Supabase RPC call.
 * @param action - Name of the admin action for Sentry tagging.
 * @param auditId - Optional audit_id returned before the failure (for reconciliation).
 *   NOTE (M3 clarity): for overrideTierAction and toggleConsentAction, the auditId
 *   is never passed here because if mapRpcError fires it means the RPC itself failed —
 *   the audit row was never written. The auditId parameter is only meaningful for
 *   resetPasswordAction where a post-RPC failure (magic-link send) could happen after
 *   a successful audit write. In that case the caller passes auditId explicitly via
 *   the inline Sentry capture, not through this function.
 * @returns An AdminActionResult with ok: false and a safe error message.
 */
function mapRpcError(
  err: { code?: string; message?: string },
  action: string,
  auditId?: string | number
): { ok: false; error: string } {
  if (err.code === '42501') return { ok: false, error: 'Not authorized' };
  if (err.code === '22023') return { ok: false, error: 'Invalid input value' };
  if (err.code === '23514') return { ok: false, error: 'Reason is required' };

  // Unexpected error — capture full context in Sentry for ops triage.
  // WHY audit_id tag: if the mutation partially succeeded before the error
  // (e.g. audit row written but subscription update failed), the Sentry event
  // carries the audit_id so ops can reconcile without manual DB spelunking.
  Sentry.captureException(new Error(`admin action failed: ${action}`), {
    tags: {
      admin_action: action,
      sqlstate: err.code ?? 'unknown',
      ...(auditId != null ? { audit_id: String(auditId) } : {}),
    },
    extra: {
      // WHY we log err.message here (not in the user-facing response):
      // The raw message may contain internal table/column names. It's safe
      // to include in Sentry (ops-internal), but must never reach the client.
      rpc_message: err.message,
    },
  });
  return { ok: false, error: 'Internal error — check Sentry' };
}

// ─── Server actions ───────────────────────────────────────────────────────────

/**
 * Server action: override a user's subscription tier.
 *
 * Flow:
 *   1. Cross-check trustedUserId (from URL) vs FormData targetUserId — reject
 *      mismatch to prevent forensic integrity issues.
 *   2. Validate FormData with Zod — reject early with field-level errors.
 *   3. Extract IP + UA from request headers.
 *   4. Call `admin_override_tier` RPC (SECURITY DEFINER — audits + mutates in
 *      one Postgres transaction).
 *   5. On success — revalidate the dossier page and redirect back.
 *   6. On RPC error — map SQLSTATE to safe user-facing error and return.
 *
 * WHY server action not API route: server actions run on the server and are
 * not publicly addressable endpoints. Combined with Next.js 15 Action-Origin
 * enforcement, they cannot be invoked cross-origin. An API route at
 * `/api/admin/*` would need additional CSRF guards; server actions get this
 * for free. SOC 2 CC6.1.
 *
 * WHY trustedUserId parameter (Fix B):
 *   The URL param is the authoritative reference. FormData can be tampered via
 *   browser devtools. By binding the URL userId to the action via
 *   `action.bind(null, userId)` on the page, we pass an unforgeable server-side
 *   value. If FormData.targetUserId mismatches, we reject immediately — an admin
 *   visiting /users/<A>/override-tier cannot be tricked into acting on <B>.
 *   Threat review round 2, Fix B.
 *
 * @param trustedUserId - UUID from the URL param, bound server-side (unforgeable).
 * @param formData - FormData submitted by the OverrideTierForm.
 * @returns AdminActionResult — never throws (errors returned as { ok: false }).
 */
export async function overrideTierAction(
  trustedUserId: string,
  formData: FormData
): Promise<AdminActionResult> {
  // ── 0. URL vs FormData cross-check (Fix B) ────────────────────────────────
  // WHY reject on mismatch: if FormData.targetUserId was tampered to a
  // different UUID, the audit row and mutation would apply to the wrong user
  // while the admin believes they acted on the URL user. This breaks forensic
  // integrity. We surface a hard error rather than silently using one over
  // the other. Threat review round 2, Fix B.
  const fdUserId = formData.get('targetUserId');
  if (fdUserId !== trustedUserId) {
    Sentry.captureMessage('admin override-tier: targetUserId mismatch between URL and FormData', {
      level: 'warning',
      tags: {
        admin_action: 'override_tier',
        trusted_user_id: trustedUserId,
        form_user_id: String(fdUserId),
      },
    });
    return { ok: false, error: 'targetUserId mismatch with URL context' };
  }

  // ── 1. Validate input ──────────────────────────────────────────────────────
  const parsed = OverrideTierSchema.safeParse({
    targetUserId: formData.get('targetUserId'),
    newTier: formData.get('newTier'),
    // Empty string from the datetime input = "not set" → treat as null.
    expiresAt: (formData.get('expiresAt') as string) || null,
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

  // ── 2. Extract network context from request headers ────────────────────────
  const hdrs = await headers();
  const ip = extractIP(hdrs.get('x-forwarded-for'));
  const ua = hdrs.get('user-agent') ?? null;

  // ── 3. Call SECURITY DEFINER RPC ──────────────────────────────────────────
  // WHY createClient() (user-scoped, NOT service-role) for the RPC call:
  // The SECURITY DEFINER RPC body calls `is_site_admin(auth.uid())`. When
  // called via the service-role client, auth.uid() returns NULL inside
  // Postgres (no JWT context → NULL uid → is_site_admin(NULL) = false →
  // 42501 INSUFFICIENT_PRIVILEGE). The user-scoped client carries the admin's
  // session cookie → JWT is forwarded → auth.uid() resolves correctly.
  // The GRANT EXECUTE ... TO authenticated (migration 040/041) allows this.
  // SOC 2 CC6.1, CC7.2.
  const supabase = await createClient();

  // ── MFA gate — H42 Layer 1 ────────────────────────────────────────────────
  // WHY here (not in layout): the layout cannot call assertAdminMfa because it
  // would block the passkey enrollment page itself (bootstrap paradox). Per-action
  // enforcement is the correct pattern. OWASP A07:2021, SOC 2 CC6.1.
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

  const { data: auditId, error } = await supabase.rpc('admin_override_tier', {
    p_target_user_id: parsed.data.targetUserId,
    p_new_tier: parsed.data.newTier,
    p_expires_at: parsed.data.expiresAt ?? null,
    p_reason: parsed.data.reason,
    p_ip: ip,
    p_ua: ua,
  });

  if (error) return mapRpcError(error, 'override_tier');

  // ── 4. Revalidate + redirect ───────────────────────────────────────────────
  // WHY revalidatePath before redirect: ensures the dossier page re-fetches
  // from Supabase on the next render, showing the updated tier immediately.
  revalidatePath(`/dashboard/admin/users/${parsed.data.targetUserId}`);
  redirect(`/dashboard/admin/users/${parsed.data.targetUserId}`);

  // TypeScript requires an explicit return even after redirect (which throws).
  return { ok: true };
}

/**
 * Server action: record a password reset audit row then send a magic link.
 *
 * WHY audit-first, then magic-link:
 *   The audit row is written FIRST (inside the Postgres SECURITY DEFINER RPC)
 *   before the magic link is dispatched. This preserves the SOC 2 CC7.2 intent
 *   requirement: the audit record captures the admin's intention regardless of
 *   whether the email delivery succeeds. If the magic-link call fails, the audit
 *   row exists as evidence that a reset was requested, allowing ops to manually
 *   follow up. The reverse order (link first, then audit) would mean a successful
 *   link with no audit trail if the DB write fails — an unacceptable compliance gap.
 *
 * WHY trustedUserId parameter (Fix B):
 *   See overrideTierAction JSDoc for the full rationale. Same pattern applied here.
 *   Threat review round 2, Fix B.
 *
 * @param trustedUserId - UUID from the URL param, bound server-side (unforgeable).
 * @param formData - FormData submitted by the ResetPasswordForm.
 * @returns AdminActionResult — { ok: true, warning? } on success (warning if
 *   the magic-link call failed after a successful audit write, or if target user
 *   is banned/deleted).
 */
export async function resetPasswordAction(
  trustedUserId: string,
  formData: FormData
): Promise<AdminActionResult> {
  // ── 0. URL vs FormData cross-check (Fix B) ────────────────────────────────
  const fdUserId = formData.get('targetUserId');
  if (fdUserId !== trustedUserId) {
    Sentry.captureMessage('admin reset-password: targetUserId mismatch between URL and FormData', {
      level: 'warning',
      tags: {
        admin_action: 'reset_password',
        trusted_user_id: trustedUserId,
        form_user_id: String(fdUserId),
      },
    });
    return { ok: false, error: 'targetUserId mismatch with URL context' };
  }

  // ── 1. Validate input ──────────────────────────────────────────────────────
  // WHY targetEmail is NOT read from FormData (C1 fix):
  //   The prior implementation accepted a hidden <input name="targetEmail"> and
  //   passed it directly to generateLink(). An admin could tamper this field via
  //   browser devtools to redirect the recovery link to an email they control —
  //   a full account-takeover primitive. We now accept only targetUserId + reason,
  //   then fetch the email server-side via the trusted Auth Admin API below.
  //   T6 quality review #C1.
  const parsed = ResetPasswordSchema.safeParse({
    targetUserId: formData.get('targetUserId'),
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

  // ── 2. Extract network context ─────────────────────────────────────────────
  const hdrs = await headers();
  const ip = extractIP(hdrs.get('x-forwarded-for'));
  const ua = hdrs.get('user-agent') ?? null;

  // WHY two separate clients for this action:
  //   - adminClient (service_role): required for auth.admin.getUserById() and
  //     auth.admin.generateLink() — these Auth Admin APIs require service-role
  //     privilege and cannot be accessed with a user-scoped client.
  //   - userScopedSupabase (user-scoped): required for the admin_record_password_reset
  //     RPC. The RPC's SECURITY DEFINER body calls is_site_admin(auth.uid()). With
  //     service-role there is no JWT context → auth.uid() = NULL → 42501. The user-
  //     scoped client forwards the admin's session cookie → auth.uid() resolves.
  //   SOC 2 CC6.1, CC7.2.
  const adminClient = createAdminClient();

  // ── MFA gate — H42 Layer 1 ────────────────────────────────────────────────
  // WHY user-scoped client for MFA check: assertAdminMfa uses createAdminClient()
  // internally for DB queries, but we need the acting admin's user ID. We use
  // a temporary user-scoped client here to resolve auth.uid() → actingAdmin.id.
  // OWASP A07:2021, SOC 2 CC6.1.
  {
    const mfaClient = await createClient();
    const { data: { user: actingAdmin } } = await mfaClient.auth.getUser();
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

  // ── 3. Fetch target user server-side via trusted Auth Admin API ───────────
  // CRITICAL (C1): email is resolved from the server-side Auth Admin API, not
  // from FormData. This prevents an admin from tampering a hidden form field to
  // redirect the recovery magic-link to an email they control (account takeover).
  // The Auth Admin API is only accessible with the service-role key, which never
  // reaches the client. SOC 2 CC6.1.
  const { data: authUser, error: userFetchErr } = await adminClient.auth.admin.getUserById(
    parsed.data.targetUserId
  );

  if (userFetchErr || !authUser?.user?.email) {
    return { ok: false, error: 'Target user not found' };
  }

  const trustedEmail = authUser.user.email;
  const targetUser = authUser.user;

  // ── 3a. Banned / soft-deleted guard (Fix A) ───────────────────────────────
  // Threat-review #4: don't un-ban a banned user via password recovery. If the
  // target is banned or soft-deleted, write the audit row (intent is preserved
  // for SOC 2 CC7.2) but skip the magic-link send and return a clear warning
  // so the admin understands their action was partially refused.
  //
  // Field semantics (from @supabase/auth-js User type):
  //   banned_until — ISO 8601 timestamp or 'none' when indefinitely banned; null/undefined when not banned.
  //   deleted_at   — ISO 8601 timestamp of soft-delete; null/undefined when not deleted.
  //
  // WHY we check banned_until before writing the audit row (not after):
  //   The intent here is to prevent the recovery email from ever going out for
  //   a banned/deleted user. The audit write still happens below (step 4) to
  //   preserve the admin's intent, but we skip step 5 (generateLink). Returning
  //   before the RPC write here would lose the audit trail entirely.
  const bannedUntil = targetUser.banned_until;
  const deletedAt = targetUser.deleted_at;

  // A banned_until of 'none' means indefinitely banned in Supabase's API.
  // A non-null banned_until timestamp means banned until that date.
  // Either way we treat the user as blocked.
  const isBanned = !!bannedUntil;
  const isDeleted = !!deletedAt;

  // ── 4. Write audit row FIRST (SECURITY DEFINER RPC) ───────────────────────
  // WHY audit before magic link: see function JSDoc above. SOC 2 CC7.2.
  // WHY also write audit row for banned/deleted users (Fix A):
  //   The admin's intent to trigger a reset should be recorded even when we
  //   refuse to send the link. This preserves the SOC 2 CC7.2 audit trail and
  //   lets ops reconcile why a reset was attempted but blocked.
  // WHY user-scoped client for this RPC (not adminClient): see client setup above.
  const userScopedSupabase = await createClient();
  const { data: auditId, error: rpcErr } = await userScopedSupabase.rpc('admin_record_password_reset', {
    p_target_user_id: parsed.data.targetUserId,
    p_reason: parsed.data.reason,
    p_ip: ip,
    p_ua: ua,
  });

  if (rpcErr) return mapRpcError(rpcErr, 'reset_password');

  // ── 4a. Banned / soft-deleted short-circuit (Fix A) ───────────────────────
  // Audit row is already written above (intent preserved). Now check if the
  // target is banned or deleted before dispatching the recovery email.
  if (isBanned || isDeleted) {
    const targetStatus = isDeleted ? 'deleted' : 'banned';
    Sentry.captureMessage(
      `admin reset-password blocked: target user is ${targetStatus}`,
      {
        level: 'warning',
        tags: {
          admin_action: 'reset_password',
          audit_id: String(auditId),
          target_status: targetStatus,
        },
      }
    );
    return {
      ok: true,
      warning: `Audit recorded (id ${auditId}) but recovery link NOT sent — target user is ${targetStatus}.`,
    };
  }

  // ── 5. Send magic link via Supabase Auth Admin API ─────────────────────────
  // WHY generateLink not signInWithOtp: generateLink creates a one-time recovery
  // link without immediately sending an email — Supabase handles the send
  // internally. The `type: 'recovery'` mode creates a password-reset link, not
  // a sign-in link, which is semantically correct for a site-admin-initiated reset.
  // WHY trustedEmail (not FormData): see step 3 above (C1).
  const { error: linkErr } = await adminClient.auth.admin.generateLink({
    type: 'recovery',
    email: trustedEmail,
  });

  if (linkErr) {
    // WHY ok: true with warning: the audit row is already written (intent
    // preserved). Returning ok: false would suggest the admin should retry,
    // which could create duplicate audit rows. The admin should instead check
    // Sentry and manually follow up with the user. SOC 2 CC7.2.
    Sentry.captureException(linkErr, {
      tags: {
        admin_action: 'reset_password',
        audit_id: String(auditId),
      },
      extra: {
        target_user_id: parsed.data.targetUserId,
        note: 'Audit row written; magic link send failed. Reconcile manually.',
      },
    });
    return {
      ok: true,
      warning: `Audit recorded (id ${auditId}) but magic link send failed — check Sentry for reconciliation.`,
    };
  }

  // ── 6. Revalidate + redirect ───────────────────────────────────────────────
  revalidatePath(`/dashboard/admin/users/${parsed.data.targetUserId}`);
  redirect(`/dashboard/admin/users/${parsed.data.targetUserId}`);

  return { ok: true };
}

/**
 * Server action: grant or revoke a user's consent flag.
 *
 * Flow:
 *   1. Cross-check trustedUserId (from URL) vs FormData targetUserId — reject mismatch.
 *   2. Validate FormData with Zod.
 *   3. Extract IP + UA.
 *   4. Call `admin_toggle_consent` RPC (SECURITY DEFINER — upserts consent_flags
 *      and writes audit in one Postgres transaction).
 *   5. On success — revalidate + redirect.
 *
 * WHY trustedUserId parameter (Fix B):
 *   See overrideTierAction JSDoc for the full rationale. Same pattern applied here.
 *   Threat review round 2, Fix B.
 *
 * @param trustedUserId - UUID from the URL param, bound server-side (unforgeable).
 * @param formData - FormData submitted by the ToggleConsentForm.
 * @returns AdminActionResult.
 */
export async function toggleConsentAction(
  trustedUserId: string,
  formData: FormData
): Promise<AdminActionResult> {
  // ── 0. URL vs FormData cross-check (Fix B) ────────────────────────────────
  const fdUserId = formData.get('targetUserId');
  if (fdUserId !== trustedUserId) {
    Sentry.captureMessage('admin toggle-consent: targetUserId mismatch between URL and FormData', {
      level: 'warning',
      tags: {
        admin_action: 'toggle_consent',
        trusted_user_id: trustedUserId,
        form_user_id: String(fdUserId),
      },
    });
    return { ok: false, error: 'targetUserId mismatch with URL context' };
  }

  // ── 1. Validate input ──────────────────────────────────────────────────────
  const parsed = ToggleConsentSchema.safeParse({
    targetUserId: formData.get('targetUserId'),
    purpose: formData.get('purpose'),
    grant: formData.get('grant'),
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

  // ── 2. Extract network context ─────────────────────────────────────────────
  const hdrs = await headers();
  const ip = extractIP(hdrs.get('x-forwarded-for'));
  const ua = hdrs.get('user-agent') ?? null;

  // ── 3. Call SECURITY DEFINER RPC ──────────────────────────────────────────
  // WHY createClient() (user-scoped): the RPC's SECURITY DEFINER body calls
  // is_site_admin(auth.uid()). Service-role has no JWT context → auth.uid()
  // = NULL → 42501. User-scoped client forwards the admin's session cookie.
  // SOC 2 CC6.1, CC7.2.
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

  const { error } = await supabase.rpc('admin_toggle_consent', {
    p_target_user_id: parsed.data.targetUserId,
    p_purpose: parsed.data.purpose,
    p_grant: parsed.data.grant === 'true',
    p_reason: parsed.data.reason,
    p_ip: ip,
    p_ua: ua,
  });

  if (error) return mapRpcError(error, 'toggle_consent');

  // ── 4. Revalidate + redirect ───────────────────────────────────────────────
  revalidatePath(`/dashboard/admin/users/${parsed.data.targetUserId}`);
  redirect(`/dashboard/admin/users/${parsed.data.targetUserId}`);

  return { ok: true };
}
