-- ============================================================================
-- Migration 099: offline_command_queue — enforce machine_id + session_id ownership
-- ============================================================================
--
-- SECURITY FIX (SEC-WEBMOB-001, /sec-ship --comprehensive 2026-06-10)
--
-- The offline_command_queue RLS policies (001_initial_schema.sql:1091-1106) gate
-- every operation on `user_id = auth.uid()` ONLY. `machine_id` is
-- `NOT NULL REFERENCES machines(id)` and `session_id` REFERENCES sessions(id),
-- but NO policy verifies those rows belong to the caller. The FK is satisfied by
-- ANY existing machine/session id, so an authenticated user could INSERT/UPDATE a
-- queued command carrying another user's machine_id or session_id.
--
-- Impact is bounded (delivery is user_id-partitioned: the victim's CLI only drains
-- rows WHERE user_id = victim, so a foreign-machine_id row sits inert in the
-- attacker's own partition and is never delivered or read cross-user). The real
-- exposure is a machine_id/session_id existence oracle (FK success/failure) plus
-- audit-record integrity. Classified MEDIUM. This migration closes it at the
-- correct layer (the write WITH CHECK) so the trust boundary is explicit rather
-- than relying on delivery scoping downstream.
--
-- WHY only INSERT/UPDATE WITH CHECK (not SELECT/DELETE USING): SELECT and DELETE
-- are already user_id-scoped, so no cross-user read/delete is possible. The IDOR
-- is purely on the WRITTEN machine_id/session_id columns, which only the WITH
-- CHECK clauses constrain. Legitimate clients (web useRelaySend / mobile
-- offline-sync) always write their OWN machine_id, so this tightening is
-- transparent to them.
--
-- WHY session_id allows NULL: command.session_id is nullable (a queued chat may
-- predate session creation); a NULL session_id is owner-agnostic and safe.
-- ============================================================================

-- INSERT: caller's own user_id AND a machine they own AND (no session OR their session)
DROP POLICY IF EXISTS "offline_queue_insert_own" ON offline_command_queue;
CREATE POLICY "offline_queue_insert_own"
  ON offline_command_queue FOR INSERT
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND machine_id IN (SELECT id FROM machines WHERE user_id = (SELECT auth.uid()))
    AND (
      session_id IS NULL
      OR session_id IN (SELECT id FROM sessions WHERE user_id = (SELECT auth.uid()))
    )
    -- SEC-WEBMOB-004: a freshly-queued command is always 'pending'. Pinning the
    -- INSERT status closes the mass-assignment gap where a client could enqueue a
    -- row pre-marked 'completed'/'cancelled' (skipping delivery) or otherwise
    -- forge queue state. The drain path updates status server-side afterward.
    AND status = 'pending'
  );

-- UPDATE: same ownership constraint on both the visible row (USING) and the
-- post-update row (WITH CHECK), so a row cannot be re-pointed at a foreign
-- machine/session via UPDATE either.
DROP POLICY IF EXISTS "offline_queue_update_own" ON offline_command_queue;
CREATE POLICY "offline_queue_update_own"
  ON offline_command_queue FOR UPDATE
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND machine_id IN (SELECT id FROM machines WHERE user_id = (SELECT auth.uid()))
    AND (
      session_id IS NULL
      OR session_id IN (SELECT id FROM sessions WHERE user_id = (SELECT auth.uid()))
    )
  );

-- SELECT + DELETE policies are unchanged (already user_id-scoped; no cross-user
-- read/delete possible). Left in place by this migration.
