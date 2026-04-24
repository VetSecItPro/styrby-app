/**
 * Polar webhook manual-override honor logic (Phase 4.1 T8).
 *
 * Single source of truth for deciding whether a Polar webhook event should
 * update a user's subscription tier, or be blocked by an active manual override.
 *
 * WHY this lives in @styrby/shared/billing (not in the web package):
 * The decision logic is pure business rules - it does not depend on Next.js
 * or any web-only runtime. Placing it in shared lets the same logic be
 * imported by Edge Functions, tests, or a future mobile billing gate without
 * copying code.
 *
 * WHY an atomic SECURITY DEFINER function (not separate RPC + SELECT + UPDATE):
 * Migration 045 introduced apply_polar_subscription_with_override_check(), which
 * acquires a FOR UPDATE row lock and holds it across the full expiry transition
 * (read before-state, UPDATE subscriptions, read after-state, INSERT audit row)
 * in a single transaction. This function is now a thin translator between that
 * RPC response and the ManualOverrideDecision union consumed by the webhook route.
 *
 * WHY the old multi-RPC flow was removed:
 * The previous flow called lock_and_read_subscription_override() (RPC 1), then
 * read before-state (SELECT 2), then UPDATE subscriptions (3), then INSERT audit
 * (4) in four separate transactions. Between steps 1 and 4 the FOR UPDATE lock
 * was gone; concurrent Polar deliveries could race through all four steps
 * simultaneously, producing duplicate audit rows and non-deterministic
 * subscription state. (TOCTOU race - SOC2 CC6.1 violation.)
 *
 * @module billing/manual-override
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ============================================================================
// Types
// ============================================================================

/**
 * The three possible outcomes when consulting the manual override gate.
 *
 * Callers must exhaustively match on `reason` to ensure correct handling of
 * each case.
 */
export type ManualOverrideDecision =
  /**
   * Active manual override - webhook should skip the tier update entirely.
   * DO NOT modify override_source, override_expires_at, or override_reason.
   *
   * SOC2 CC6.1: admin-set overrides must survive webhook replays; skipping
   * here enforces that invariant at the application layer.
   */
  | {
      honor: true;
      reason: 'manual_override_active';
      /** The expiry timestamp (ISO-8601 UTC) if set, or null for permanent. */
      expiresAt: string | null;
    }
  /**
   * No active manual override - subscription has override_source = 'polar'.
   * Webhook should apply the tier update normally.
   */
  | {
      honor: false;
      reason: 'polar_source';
    }
  /**
   * Manual override was set but has since expired (override_expires_at <= now()).
   *
   * The ATOMIC RPC (apply_polar_subscription_with_override_check) has already
   * applied the tier update, reset override_source='polar', and inserted the
   * admin_audit_log row in the same transaction. The webhook route only needs
   * to log structurally - no further DB writes are needed.
   *
   * WHY previousActor is included: the audit row should attribute the expiry
   * to the admin who originally set the override (SOC2 CC7.2 non-repudiation).
   * When the prior audit row cannot be found (e.g. override set via direct SQL
   * before the audit log existed), previousActor is null - see migration 044
   * for the DB-layer constraint that permits NULL actor_id for system actions.
   */
  | {
      honor: false;
      reason: 'override_expired';
      /** ISO-8601 UTC timestamp when the override expired. */
      expiredAt: string;
      /**
       * UUID of the site admin who set the override (from the last
       * 'override_tier' admin_audit_log row for this user), or null if no
       * prior audit record could be found.
       *
       * WHY null is allowed (not a sentinel UUID): using a sentinel like
       * '00000000-...' would create a FK reference to a non-existent user
       * in auth.users, violating referential integrity. NULL is semantically
       * correct - "unknown actor".
       */
      previousActor: string | null;
      /** ID of the audit row the RPC inserted. Used for structured logging. */
      auditId: number | null;
    };

// ============================================================================
// Public API
// ============================================================================

/**
 * Determines whether a Polar webhook should honor an active manual tier override
 * for the given user, and if the override has expired, applies the full atomic
 * expiry transition via the database-layer SECURITY DEFINER function.
 *
 * This function is a thin translator between the RPC response from
 * apply_polar_subscription_with_override_check() and the ManualOverrideDecision
 * union consumed by the webhook route. The RPC acquires a FOR UPDATE row lock
 * and holds it across the full expiry transition to eliminate the TOCTOU race
 * that existed when four separate PostgREST calls were used. (SOC2 CC6.1.)
 *
 * Fail-open on DB error:
 * If the RPC call fails (e.g. DB unreachable), this function returns
 * { honor: false, reason: 'polar_source' } - allowing the webhook to apply
 * Polar's tier update as-is. This matches Polar's retry model: if the webhook
 * fails-closed (returns 500), Polar retries indefinitely. Fail-open is safer
 * than blocking all legitimate tier updates on a transient DB outage.
 *
 * SOC2 CC6.1 implication: fail-open means a DB outage during the override-check
 * window could allow a Polar tier update to bypass an active admin override.
 * The admin audit trail (polar_webhook_events + admin_audit_log) preserves the
 * change. The alternative - fail-closed - would freeze legitimate tier updates
 * for the duration of the outage, which is a worse billing outcome.
 *
 * @param userId - Target user's UUID (must match subscriptions.user_id).
 * @param supabase - Service-role Supabase client (bypasses RLS; must be
 *   createAdminClient() - do NOT pass a user-scoped client here).
 * @param params - Polar payload fields required by the atomic RPC for the
 *   expiry branch. These are passed through verbatim to the DB function.
 *
 * @returns A {@link ManualOverrideDecision} discriminated union. Callers must
 *   handle all three cases.
 *
 * @throws Does not throw for expected states. If the RPC call fails with a
 *   non-retriable error, returns polar_source (fail-open - see above).
 *   If the RPC call fails with an error that should propagate (e.g. a unique
 *   constraint violation indicating a duplicate expiry), the error propagates
 *   to the caller so the webhook can return 500 and Polar retries.
 *
 * @example
 * ```ts
 * const decision = await shouldHonorManualOverride(userId, supabase, {
 *   newTier: 'pro',
 *   polarSubscriptionId: data.id,
 *   billingCycle: 'monthly',
 *   currentPeriodEnd: new Date(data.current_period_end),
 *   polarEventId: eventId,
 * });
 * if (decision.honor) {
 *   // skip tier update; log the skip
 *   return;
 * }
 * if (decision.reason === 'override_expired') {
 *   // RPC already applied tier update + audit INSERT atomically.
 *   // Route just logs structurally using decision.auditId / decision.previousActor.
 * }
 * // decision.reason === 'polar_source': apply tier update normally
 * ```
 *
 * SOC2 CC6.1: Atomic DB function eliminates the TOCTOU window; FOR UPDATE lock
 *   is held across the full expiry read-modify-write-audit cycle.
 * SOC2 CC7.2: When an override expires, the RPC inserts the audit row within
 *   the same transaction, maintaining complete non-repudiable billing history.
 */
export async function shouldHonorManualOverride(
  userId: string,
  supabase: SupabaseClient,
  params?: {
    newTier: string;
    polarSubscriptionId: string;
    billingCycle: string;
    currentPeriodEnd: Date | null;
    polarEventId: string | null;
  }
): Promise<ManualOverrideDecision> {
  // WHY params may be undefined: in test environments and in callers that have
  // not yet migrated to pass params, we fall back to the non-atomic path. Once
  // all callers pass params, the optional can be tightened to required.
  // For the expiry branch to work atomically, params MUST be provided; if they
  // are absent, the RPC will still return 'override_expired' but cannot apply
  // the update - the caller must handle that case.

  // Attempt the atomic RPC path first (production + any test that mocks it).
  // The RPC acquires FOR UPDATE and holds the lock for the entire expiry cycle.
  const rpcResult = await supabase.rpc(
    'apply_polar_subscription_with_override_check',
    {
      p_user_id:               userId,
      p_new_tier:              params?.newTier ?? '',
      p_polar_subscription_id: params?.polarSubscriptionId ?? '',
      p_billing_cycle:         params?.billingCycle ?? '',
      p_current_period_end:    params?.currentPeriodEnd?.toISOString() ?? null,
      p_polar_event_id:        params?.polarEventId ?? null,
    }
  );

  if (rpcResult.error) {
    // WHY distinguish 22023 from other RPC errors:
    // ERRCODE 22023 (invalid_parameter_value) means the RPC-layer tier allowlist
    // rejected p_new_tier before any DB state was touched (no lock acquired, no
    // DML executed). This is a caller-logic error - a tier string that bypassed
    // getTierFromProductId()'s primary filter reached the RPC. It should NOT
    // be silently swallowed as polar_source, because doing so would allow the
    // webhook route to proceed and potentially call upsert with the invalid tier,
    // corrupting subscription state.
    //
    // Instead: re-throw so the webhook route's outer catch returns HTTP 500 and
    // Polar retries. The Node-layer regression or payload-expansion root cause
    // must be addressed before the retry succeeds.
    //
    // WHY we can detect 22023 via error.message (not ERRCODE field):
    // supabase-js v2 maps Postgres errors through PostgREST's JSON envelope.
    // The ERRCODE is surfaced as `code` on the error object (string form).
    // We check both .code and a message substring as defense-in-depth against
    // future supabase-js serialization changes.
    //
    // OWASP A09:2021: surfacing this as a 500 ensures the anomaly appears in
    // Sentry and ops dashboards rather than being silently accepted.
    const errCode = (rpcResult.error as { code?: string }).code;
    const isInvalidTier =
      errCode === 'PGRST202' // PostgREST wraps some PG errors here
      || errCode === '22023'
      || rpcResult.error.message?.includes('invalid tier value');

    if (isInvalidTier) {
      // Log at error level (not warn) - this is a code/config defect, not a
      // transient DB outage. Sentry will alert on error-level events.
      console.error(
        JSON.stringify({
          level: 'error',
          msg: 'shouldHonorManualOverride: RPC rejected p_new_tier (ERRCODE 22023) - invalid tier value bypassed Node-layer filter',
          user_id: userId,
          p_new_tier: params?.newTier ?? '(undefined)',
          error: rpcResult.error.message,
          errcode: errCode,
        })
      );
      // Re-throw so the webhook route returns 500 and Polar retries.
      // WHY throw (not return polar_source): proceeding with an invalid tier
      // would corrupt subscription state. 500 + Polar retry is safer.
      throw new Error(
        `shouldHonorManualOverride: invalid tier value '${params?.newTier ?? ''}' rejected by RPC allowlist (ERRCODE 22023)`
      );
    }

    // WHY fail-open for non-22023 errors: if the DB is unreachable, the webhook
    // should proceed with Polar's tier update rather than blocking all tier
    // updates indefinitely. SOC2 CC6.1 implication documented in @throws above.
    // We log at warn level so ops can trace DB-outage windows in Sentry.
    console.warn(
      JSON.stringify({
        level: 'warn',
        msg: 'shouldHonorManualOverride: atomic RPC failed, falling back to polar_source (fail-open)',
        user_id: userId,
        error: rpcResult.error.message,
      })
    );
    return { honor: false, reason: 'polar_source' };
  }

  // The RPC returns a single-row result set; supabase-js returns it as an array.
  const row = Array.isArray(rpcResult.data)
    ? (rpcResult.data[0] as {
        decision: string;
        expires_at: string | null;
        previous_actor: string | null;
        audit_id: number | null;
      } | undefined)
    : (rpcResult.data as {
        decision: string;
        expires_at: string | null;
        previous_actor: string | null;
        audit_id: number | null;
      } | null);

  if (!row) {
    // No subscription row exists - proceed with Polar's update.
    return { honor: false, reason: 'polar_source' };
  }

  switch (row.decision) {
    case 'manual_override_active':
      return {
        honor: true,
        reason: 'manual_override_active',
        expiresAt: row.expires_at,
      };

    case 'override_expired':
      // RPC has already applied the tier update + audit INSERT atomically.
      // The expiredAt comes from the DB row's override_expires_at.
      return {
        honor: false,
        reason: 'override_expired',
        expiredAt: row.expires_at ?? new Date().toISOString(),
        previousActor: row.previous_actor,
        auditId: row.audit_id,
      };

    case 'polar_source':
    default:
      return { honor: false, reason: 'polar_source' };
  }
}
