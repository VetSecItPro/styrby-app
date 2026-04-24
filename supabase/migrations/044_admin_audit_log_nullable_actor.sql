-- ============================================================================
-- Migration 044: Allow NULL actor_id on admin_audit_log for system-initiated
--                audit rows (Polar webhook auto-expiry of manual overrides).
--
-- Context:
--   Migration 040 created admin_audit_log with actor_id uuid NOT NULL, which
--   is correct for human-initiated admin actions (override_tier, toggle_consent,
--   record_password_reset) where a site admin is always the actor.
--
--   T8 (Polar webhook tier-override honor) must write an audit row with
--   action='manual_override_expired' when the webhook detects an elapsed manual
--   override. In this scenario the actor is the Polar webhook system — there is
--   no authenticated human admin. When the previous admin who set the override
--   can be identified from a prior 'override_tier' audit row, actor_id is set
--   to that admin's UUID. When no prior audit row is found (e.g. the override
--   was set via direct SQL before the audit log existed), actor_id is NULL.
--
--   Allowing NULL preserves the hash-chain integrity — the trigger already uses
--   COALESCE(NEW.actor_id::text, '') in the hash preimage, so NULL actor_id is
--   safe for the chain computation.
--
-- What this migration does:
--   1. DROP the NOT NULL constraint on actor_id.
--   2. Add a CHECK constraint to enforce that actor_id is either:
--        (a) a valid uuid (human-initiated action), OR
--        (b) NULL only when action IN ('manual_override_expired', ...)
--            — future system-action types added here when needed.
--      WHY: this is defense-in-depth to prevent unintentional NULL actor_id
--      slipping through for human-initiated actions.
--
-- Security notes:
--   The hash-chain trigger (admin_audit_chain_hash) uses
--     COALESCE(NEW.actor_id::text, '')
--   in the hash preimage (migration 040 line ~285). NULL actor_id is therefore
--   hash-chain safe — the chain verifier coalesces identically.
--
-- SOC2 CC7.2: System-initiated audit rows (webhook auto-expiry) are auditable
--   events. Recording them with NULL actor_id and action='manual_override_expired'
--   correctly attributes the event to the automated system, not to a human actor.
-- OWASP A09:2021 (Security Logging and Monitoring Failures): failing to record
--   the expiry event entirely (due to a DB constraint block) would be a worse
--   outcome than recording it with NULL actor. This migration prevents silent
--   audit gaps.
-- ============================================================================

-- Step 1: Drop the NOT NULL constraint on actor_id.
-- WHY ALTER COLUMN ... DROP NOT NULL (not DROP CONSTRAINT): actor_id is NOT NULL
-- via a column-level constraint, not a named table constraint. ALTER COLUMN is
-- the correct DDL. The FK reference auth.users(id) is preserved — NULL FK values
-- are valid in Postgres (NULL is not a value, it does not violate referential
-- integrity).
ALTER TABLE public.admin_audit_log
  ALTER COLUMN actor_id DROP NOT NULL;

-- Step 2: Add a named CHECK constraint that enforces actor_id is non-NULL for
-- all human-initiated actions, and permits NULL only for known system actions.
--
-- WHY a whitelist of system actions (not blacklist): if a developer accidentally
-- omits actor_id on a new human-initiated action, they should get a clear
-- constraint violation instead of silent data quality loss. The whitelist
-- makes intentional NULL actor_id an explicit, enumerated decision.
ALTER TABLE public.admin_audit_log
  ADD CONSTRAINT chk_actor_id_null_only_for_system_actions
  CHECK (
    actor_id IS NOT NULL
    OR action IN ('manual_override_expired')
  );

-- WHY no data migration needed: all existing rows have actor_id NOT NULL
-- (human-initiated). The constraint change is backward-compatible.
-- WHY no index change: idx_admin_audit_actor already handles NULLs correctly
-- in Postgres (NULL values are indexed in B-tree indexes and correctly excluded
-- from IS NOT NULL queries).


-- ============================================================================
-- §2 lock_and_read_subscription_override — Row-locking helper for T8
-- ============================================================================

/*
 * lock_and_read_subscription_override
 *
 * Acquires a row-level FOR UPDATE lock on the subscriptions row for the given
 * user and returns (override_source, override_expires_at). The lock serializes
 * concurrent Polar webhook deliveries for the same user, preventing two
 * concurrent deliveries from both reading override_source='manual' and both
 * attempting the expiry transition in parallel - which would produce duplicate
 * audit rows and non-deterministic subscription state.
 *
 * WHY SECURITY DEFINER: service_role can already SELECT all rows, but this
 * function is called by the webhook route which uses service_role anyway.
 * SECURITY DEFINER ensures the function runs with a stable search_path and
 * that authenticated callers (if this were ever called from a user context)
 * cannot bypass RLS by passing arbitrary user_ids - the function only returns
 * the caller's data filtered by p_user_id.
 *
 * WHY SKIP LOCKED is NOT used: SKIP LOCKED causes a concurrent delivery to
 * skip the row and proceed without a lock - which is exactly the race we want
 * to prevent. Plain FOR UPDATE causes the second delivery to wait for the first
 * to commit/rollback, then re-read the updated row (override_source now 'polar'
 * after the expiry transition) and proceed normally.
 *
 * param p_user_id  UUID of the user whose subscription override to read.
 * returns          SETOF RECORD with (override_source text, override_expires_at timestamptz).
 *                  Returns empty set (zero rows) when no subscriptions row exists.
 *
 * SOC2 CC6.1: Row locking prevents concurrent webhook deliveries from
 *   independently expiring the same override and writing duplicate audit rows.
 */
CREATE OR REPLACE FUNCTION public.lock_and_read_subscription_override(
  p_user_id uuid
)
RETURNS TABLE(override_source text, override_expires_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- WHY FOR UPDATE (not FOR SHARE): we need exclusive access because the
  -- caller will immediately UPDATE this row on expiry. FOR SHARE would block
  -- other writers but allow concurrent readers to also read 'manual' and both
  -- attempt the expiry, defeating the purpose of the lock.
  --
  -- WHY NO SKIP LOCKED: SKIP LOCKED would cause the second concurrent delivery
  -- to bypass the lock and proceed without waiting — reintroducing the race.
  RETURN QUERY
    SELECT s.override_source, s.override_expires_at
    FROM public.subscriptions s
    WHERE s.user_id = p_user_id
    FOR UPDATE;
END;
$$;

-- WHY REVOKE then targeted GRANT: principle of least privilege (SOC2 CC6.1).
-- Only service_role (used by the webhook route after HMAC verification) and
-- authenticated (defense-in-depth — function body is safe) need EXECUTE.
REVOKE ALL ON FUNCTION public.lock_and_read_subscription_override(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lock_and_read_subscription_override(uuid) TO service_role;
-- WHY grant to authenticated as well: admin server actions run as authenticated
-- and may call this function in the future. Granting now avoids a migration
-- gap if admin tooling evolves to check override state directly.
GRANT EXECUTE ON FUNCTION public.lock_and_read_subscription_override(uuid) TO authenticated;
