/**
 * Account Deletion API Route
 *
 * DELETE /api/account/delete
 *
 * Initiates account deletion using a soft-delete pattern. Data is marked as
 * deleted immediately but not permanently removed for 30 days, allowing for
 * recovery if needed.
 *
 * @auth Required - Supabase Auth JWT via cookie (web) OR Bearer token in
 *   Authorization header (mobile). Mobile clients send
 *   `Authorization: Bearer <access_token>` because they have no cookies.
 * @rateLimit 1 request per day
 *
 * @body {
 *   confirmation: 'DELETE MY ACCOUNT' (exact match required),
 *   reason?: string (optional feedback)
 * }
 *
 * @returns 200 { success: true, message: string }
 *
 * @error 400 { error: string } - Invalid JSON or confirmation mismatch
 * @error 401 { error: 'Unauthorized' }
 * @error 429 { error: 'RATE_LIMITED', retryAfter: number }
 * @error 500 { error: 'Failed to delete account' }
 */

import { createClient, createAdminClient } from '@/lib/supabase/server';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { rateLimit, RATE_LIMITS, rateLimitResponse } from '@/lib/rateLimit';
import { checkIdempotency, storeIdempotencyResult } from '@/lib/middleware/idempotency';

/**
 * Zod schema for delete request validation.
 * WHY: The confirmation literal ensures users consciously acknowledge deletion.
 * This prevents accidental deletions from automated tools or misclicks.
 *
 * MASS-ASSIGN-SAFE: OWASP A04:2021 — only `confirmation` and `reason` are
 * accepted. `.strict()` causes Zod to reject any unrecognized key (e.g.
 * `is_admin`, `tier`) at parse time and return 400 before any DB write occurs.
 * The `.update()` calls below use only server-computed values (e.g. `deleted_at`),
 * never the raw user-supplied object.
 */
const DeleteRequestSchema = z
  .object({
    confirmation: z.literal('DELETE MY ACCOUNT'),
    reason: z.string().optional(),
  })
  .strict(); // OWASP A04:2021 — reject unknown keys (mass-assignment guard)

/**
 * Handles account deletion requests.
 *
 * WHY soft-delete: Allows recovery within 30 days if user changes their mind
 * or if the deletion was unauthorized. Hard deletion is scheduled separately.
 *
 * @param request - The incoming HTTP request
 * @returns Success message or error response
 */
export async function DELETE(request: Request) {
  // Rate limit check - 1 deletion attempt per day
  // WHY: Prevents abuse and accidental rapid clicks
  const { allowed, retryAfter } = await rateLimit(request, RATE_LIMITS.delete, 'delete');
  if (!allowed) {
    return rateLimitResponse(retryAfter!);
  }

  // WHY: Mobile clients send `Authorization: Bearer <token>` because they have
  // no cookies. Web clients rely on the default cookie-based session. We support
  // both so a single endpoint serves the web dashboard and the mobile app.
  const authHeader = request.headers.get('Authorization');
  let supabase;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    // Create a Supabase client that injects the Bearer token into every request.
    // This is equivalent to using the cookie-based client but works for mobile.
    /**
     * NEXT_PUBLIC_SUPABASE_URL — Public URL of the Supabase project.
     *
     * Source: Supabase Dashboard > Project Settings > API > Project URL
     * Format: "https://<project-ref>.supabase.co"
     * Required in: all (local / preview / production)
     * Behavior when missing: createSupabaseClient throws at call time, returning
     *   500 to the client. Next.js build will warn about the missing NEXT_PUBLIC_ var.
     * Rotation: not a secret — changes only if the project is migrated.
     *
     * NEXT_PUBLIC_SUPABASE_ANON_KEY — Public anon key for client-side Supabase access.
     *
     * Source: Supabase Dashboard > Project Settings > API > Project API Keys > anon/public
     * Format: JWT string (~200 chars), prefix "eyJ..."
     * Required in: all (local / preview / production)
     * Behavior when missing: createSupabaseClient throws at call time, returning
     *   500 to the client. RLS policies still enforce row-level security.
     * Rotation: annually or per-incident via Supabase Dashboard > API Keys > Rotate.
     */
    supabase = createSupabaseClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        global: {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
      }
    );
  } else {
    supabase = await createClient();
  }

  // Get authenticated user
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // ── Idempotency check ────────────────────────────────────────────────────

  // WHY: Account deletion is irreversible within the 30-day grace window.
  // A CLI retry on transient error must not soft-delete the account again
  // (which would reset the deleted_at timestamp and defer the hard-delete
  // deadline). The cached success response lets the client confirm the
  // deletion without re-executing all the cleanup steps.
  // OWASP A04:2021 replay protection.
  const ROUTE_ACCOUNT_DELETE = '/api/account/delete';
  const idemResult = await checkIdempotency(request, user.id, ROUTE_ACCOUNT_DELETE);
  if ('conflict' in idemResult) {
    return NextResponse.json({ error: 'CONFLICT', message: idemResult.message }, { status: 409 });
  }
  if (idemResult.replayed) {
    return NextResponse.json(idemResult.body, { status: idemResult.status });
  }

  // Validate request body
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const validation = DeleteRequestSchema.safeParse(body);
  if (!validation.success) {
    return NextResponse.json(
      { error: 'Must confirm with "DELETE MY ACCOUNT"' },
      { status: 400 }
    );
  }

  const now = new Date().toISOString();

  try {
    // PERF-DELTA-002 (a): Three independent ownership-marker writes in parallel.
    // - profile.deleted_at      (triggers RLS hide-deleted policies)
    // - sessions.deleted_at     (preserves data for potential recovery)
    // - device_tokens DELETE    (hard delete; push tokens are useless post-deletion)
    // None depends on any other; profile error is the only one that should
    // abort the flow (signals user mismatch / RLS denial). Other failures are
    // tolerated via Promise.allSettled — a partial failure here doesn't break
    // soft-delete semantics, and the 30-day retention cron is the safety net.
    const [profileResult, _sessionsResult, _tokensResult] = await Promise.all([
      supabase.from('profiles').update({ deleted_at: now }).eq('id', user.id),
      supabase.from('sessions').update({ deleted_at: now }).eq('user_id', user.id),
      supabase.from('device_tokens').delete().eq('user_id', user.id),
    ]);

    if (profileResult.error) throw profileResult.error;

    // SEC-INTEG-001 FIX: Hard-delete data that references auth.users directly
    // (not via profiles). These tables do NOT cascade from profiles.deleted_at
    // and would remain accessible until the retention cron fires 30 days later.
    // Since the user is banned immediately, API access is blocked - but for
    // defense in depth, we remove sensitive data now rather than waiting.
    //
    // SEC-ADV-003 FIX (2026-04-25): Phase 4 tables added. The most important
    // is `support_access_grants` — admins could otherwise hold an APPROVED
    // grant against a session whose owner is in the 30-day soft-delete grace
    // window, allowing read access to a deleted account's session metadata.
    // We REVOKE every non-terminal grant via the user_revoke_support_access
    // RPC (migration 049) before purging the rows. The RPC drives the state
    // machine to 'revoked' and writes a non-repudiable admin_audit_log row.
    //
    // Tables verified to cascade from profiles ON DELETE CASCADE (handled by
    // the retention cron's hard delete of auth.users):
    //   machines -> machine_keys, sessions -> session_messages/bookmarks
    //   /session_state_snapshots/session_replay_tokens, agent_configs,
    //   cost_records, subscriptions, budget_alerts, notification_preferences,
    //   prompt_templates, offline_command_queue, audit_log (preserved as
    //   legal-hold — see retention cron), user_feedback, api_keys,
    //   webhooks -> webhook_deliveries, agent_session_groups ->
    //   agent_context_memory, predictive_cost_alert_sends, budget_threshold_sends.
    //
    // Tables flagged as legal-hold (preserved on deletion):
    //   audit_log, admin_audit_log, polar_refund_events, billing_events
    //   (user_id ON DELETE SET NULL preserves the row sans link).
    //   See docs/compliance/gdpr-table-inventory-2026-04-25.md.

    // Step A: Revoke active support_access_grants before purging.
    // WHY a separate step: we must read grant IDs first, then call the RPC per row.
    // The RPC enforces state-machine + audit invariants that direct DELETE bypasses.
    // SEC-ADV-003 P0: closes the 30-day grace-window admin-access vector.
    const { data: activeGrants } = await supabase
      .from('support_access_grants')
      .select('id')
      .eq('user_id', user.id)
      .in('status', ['pending', 'approved'])
      .limit(1000);

    if (activeGrants && activeGrants.length > 0) {
      // WHY Promise.allSettled: a single grant whose state changed concurrently
      // (e.g. consumed by an admin a millisecond before we read) raises a
      // 22023 from the RPC. We tolerate per-row failures because the row is
      // about to be deleted anyway; the audit row from the consume call
      // already exists. We do not let one rejection abort the whole flow.
      await Promise.allSettled(
        activeGrants.map((g: { id: number }) =>
          supabase.rpc('user_revoke_support_access', { p_grant_id: g.id })
        )
      );
    }

    // Step B: Hard-delete the user_id-owned rows in tables that do NOT cascade
    // automatically from profiles.deleted_at, plus tables that we want purged
    // immediately rather than waiting for the 30-day retention cron.
    await Promise.allSettled([
      // context_templates: references auth.users ON DELETE CASCADE, but we
      // purge immediately since templates have no recovery value.
      supabase.from('context_templates').delete().eq('user_id', user.id),

      // notification_logs: analytics/debug logs - no recovery value, purge now.
      // References auth.users ON DELETE CASCADE.
      supabase.from('notification_logs').delete().eq('user_id', user.id),

      // support_tickets: references auth.users ON DELETE CASCADE, but we
      // purge immediately for privacy. support_ticket_replies will cascade
      // automatically from the support_tickets FK (ticket_id ON DELETE CASCADE).
      // Note: support_ticket_replies uses author_id (not user_id), so we
      // only need to delete the parent tickets; replies cascade automatically.
      supabase.from('support_tickets').delete().eq('user_id', user.id),

      // session_shared_links: share links created by the user for their sessions.
      // WHY: Uses 'shared_by' (not 'user_id') as the ownership column. This table
      // has no FK to auth.users or profiles, so it does NOT cascade automatically
      // on profile soft/hard delete. We must purge it explicitly to prevent orphaned
      // share links remaining publicly accessible after account deletion.
      // SEC-LOGIC-004 FIX: was missing from deletion route.
      supabase.from('session_shared_links').delete().eq('shared_by', user.id),

      // ── SEC-ADV-003 (2026-04-25): Phase 4 + earlier-phase gaps ────────────────

      // passkeys (migration 020): WebAuthn credentials. Cascade-deletes from
      // auth.users on hard delete, but explicit purge during the soft-delete
      // grace window blocks WebAuthn re-auth on a banned-but-not-yet-deleted user.
      supabase.from('passkeys').delete().eq('user_id', user.id),

      // approvals (migration 021): rows where the user is the requester.
      // resolver_user_id is SET NULL on cascade so we don't need to handle that side.
      supabase.from('approvals').delete().eq('requester_user_id', user.id),

      // sessions_shared (migration 021): share rows the user created (sender side).
      // The recipient side cascades automatically via shared_with_user_id ON DELETE CASCADE.
      supabase.from('sessions_shared').delete().eq('shared_by_user_id', user.id),

      // exports (migration 021): historical export job records.
      supabase.from('exports').delete().eq('user_id', user.id),

      // data_export_requests (migration 025): the user's prior export-request history.
      supabase.from('data_export_requests').delete().eq('user_id', user.id),

      // notifications (migration 026): in-app + push notification history.
      supabase.from('notifications').delete().eq('user_id', user.id),

      // referral_events (migration 026): rows where the user is the referrer.
      // referred_user_id is SET NULL on cascade for the referee side.
      supabase.from('referral_events').delete().eq('referrer_user_id', user.id),

      // user_feedback_prompts (migration 027): NPS scheduling state.
      supabase.from('user_feedback_prompts').delete().eq('user_id', user.id),

      // agent_session_groups (migration 035): user-created agent groupings.
      // Deleting these cascade-deletes agent_context_memory rows automatically.
      supabase.from('agent_session_groups').delete().eq('user_id', user.id),

      // devices (migration 036): session-handoff device records.
      supabase.from('devices').delete().eq('user_id', user.id),

      // consent_flags (migration 040): GDPR Art. 7 consent record. WHY delete
      // (not preserve): consent records are tied to the user's identity; once
      // the account is being erased the consent record is no longer meaningful.
      // The audit_log row for the deletion event records the erasure itself.
      supabase.from('consent_flags').delete().eq('user_id', user.id),

      // support_access_grants (migration 048): now safe to delete because we
      // revoked all non-terminal grants in Step A above. Terminal-state rows
      // (revoked / consumed / expired) are also deleted here — the audit trail
      // lives in admin_audit_log which is preserved as legal-hold.
      supabase.from('support_access_grants').delete().eq('user_id', user.id),

      // churn_save_offers (migration 050): unaccepted/active offers. Accepted
      // offers' financial impact is recorded in admin_audit_log (preserved).
      supabase.from('churn_save_offers').delete().eq('user_id', user.id),

      // billing_credits (migration 050): credits. WHY include here even though
      // the FK is ON DELETE CASCADE: cascade fires on auth.users hard delete,
      // not soft delete. Purging during the grace window prevents the user
      // from accidentally seeing or applying a credit if recovery occurs.
      // Applied credits' financial record is in admin_audit_log (legal-hold).
      supabase.from('billing_credits').delete().eq('user_id', user.id),

      // NOTE: billing_events is intentionally NOT deleted here. The FK is
      // ON DELETE SET NULL, which preserves the financial event log under
      // GDPR Art. 17(3)(b)(e) legal-hold while scrubbing the user link.
      // The auth.users hard-delete (retention cron) triggers the SET NULL.
    ]);

    // PERF-DELTA-002 (b): Three independent finalization writes in parallel.
    // - audit_log.insert     (compliance — non-blocking; failure logs but doesn't abort)
    // - admin.updateUserById (ban → invalidates JWT during grace period)
    // - supabase.auth.signOut (clear current session cookie)
    // None depends on the others; previously sequential, ~130ms saved.
    const adminClient = createAdminClient();
    await Promise.all([
      // Compliance audit row. SEC-R2-S2-004: take only the first hop of
      // x-forwarded-for to prevent multi-IP injection polluting the column.
      supabase.from('audit_log').insert({
        user_id: user.id,
        action: 'settings_updated',
        resource_type: 'account_deletion',
        ip_address: (request.headers.get('x-forwarded-for') || 'unknown').split(',')[0].trim(),
        metadata: {
          soft_delete: true,
          reason: validation.data.reason || 'Not provided',
          hard_delete_scheduled: '30 days',
        },
      }),
      // FIX-012: Ban the user in auth.users to prevent login during grace
      // period. Soft-deleting the profile doesn't prevent re-authentication;
      // banning via admin API invalidates the JWT immediately.
      adminClient.auth.admin.updateUserById(user.id, {
        ban_duration: '720h', // 30 days — matches hard-delete grace period
      }),
      // Sign out current session — user should lose access immediately.
      supabase.auth.signOut(),
    ]);

    const deleteResponseBody = {
      success: true,
      message:
        'Account scheduled for deletion. Data will be permanently removed in 30 days.',
    };

    // WHY store before returning: ensures a CLI retry after a transient network
    // failure receives the cached success response and does not re-execute the
    // deletion sequence (which would reset deleted_at and the 30-day deadline).
    await storeIdempotencyResult(request, user.id, ROUTE_ACCOUNT_DELETE, 200, deleteResponseBody);

    return NextResponse.json(deleteResponseBody);
  } catch (error) {
    const isDev = process.env.NODE_ENV === 'development';
    console.error(
      'Delete error:',
      isDev ? error : error instanceof Error ? error.message : 'Unknown error'
    );
    return NextResponse.json({ error: 'Failed to delete account' }, { status: 500 });
  }
}
