-- Migration 047: Disable migration 018's broken audit_log_* triggers.
--
-- RENAMED 2026-05-04: was originally `0395_disable_broken_audit_triggers.sql`,
-- a hotfix applied between 039 and 040 (hence the "03 9.5" version). The
-- numeric prefix `0395` triggered a Supabase CLI sort-order bug — ASCII
-- sorts `0395_*` BEFORE `039_*` (because '5' = 0x35 < '_' = 0x5F) while
-- Postgres sorts the version column the other way (039 < 0395). The
-- mismatched orderings broke `supabase db push` indefinitely. Renamed to
-- 047 (a previously-unused gap between 046 and 048) to fix the CLI; the
-- corresponding tracker row was UPDATEd from version='0395' to '047' at
-- the same time. Application order in production is unchanged — this
-- migration was applied to remote on 2026-04 (long before this rename).
--
-- WHY THIS MIGRATION EXISTS (context):
--   Migration 018 attached an audit_trigger_fn to profiles, subscriptions,
--   api_keys, team_members, and team_policies. The trigger function has
--   THREE independent latent bugs that prevent it from firing successfully:
--
--     1. Column-name mismatch — INSERTs into audit_log using a column
--        named "details", but the actual column on audit_log (migration
--        001 line 755) is named "metadata". SQLSTATE 42703.
--     2. Type cast mismatch — (v_record->>'id')::text is inserted into
--        audit_log.resource_id which is uuid. ->> returns text; no
--        implicit text→uuid cast. SQLSTATE 42804.
--     3. Enum incompatibility — TG_OP::text::audit_action casts 'INSERT',
--        'UPDATE', 'DELETE' to an enum whose values are domain events
--        (login, session_created, subscription_changed, ...) — none of
--        which are DML op verbs. SQLSTATE 22P02.
--
--   The function has been dormant in production (no migration has written
--   to the audited tables via DDL, and application-layer writes appear
--   to have been working — via unknown mechanism, likely transactional
--   rollback of the trigger error being silently retried or a disabled
--   trigger state that got set outside of this repo's history).
--
--   Phase 4.1 migration 040 performs `UPDATE public.subscriptions SET
--   override_source = 'polar' WHERE override_source IS NULL` as part of
--   its three-step NOT NULL backfill. This UPDATE fires audit_log_
--   subscriptions → audit_trigger_fn → ERROR. So 040 cannot apply to
--   production until the broken triggers are disabled.
--
-- WHY DISABLE vs FIX:
--   A proper repair of audit_trigger_fn requires deciding what
--   audit_action value to use for DML events (options: extend the enum,
--   map by TG_TABLE_NAME to domain events, or remove the function
--   entirely). That decision requires understanding the original intent
--   of the function — research scope that belongs in a dedicated follow-up
--   phase, not mid-stream during Phase 4.1 activation. Backlog item
--   "audit_trigger_fn full repair" tracks this.
--
-- WHY THE NUMBER 0395:
--   Must sort between existing migration 039 (context_memory) and the
--   Phase 4.1 migration 040 (admin_console) lexicographically, so
--   `supabase db push` applies this disable step before 040 attempts
--   its UPDATE on subscriptions. '0395_…' sorts correctly: after
--   '039_…' and before '040_…'.
--
-- PRODUCTION IMPACT:
--   None. The triggers have been effectively dormant (any successful
--   trigger fire would have silently dropped events because of the
--   bugs). Disabling them makes this dormancy explicit and reversible
--   once the proper repair ships.
--
-- Governing:
--   SOC2 CC7.2 (audit logging correctness — the trigger's current state
--   is a dormant audit gap, not a functioning audit; this migration
--   removes the illusion of coverage rather than the coverage itself).

ALTER TABLE public.profiles      DISABLE TRIGGER audit_log_profiles;
ALTER TABLE public.subscriptions DISABLE TRIGGER audit_log_subscriptions;
ALTER TABLE public.api_keys      DISABLE TRIGGER audit_log_api_keys;

-- team_members and team_policies triggers are conditionally attached in
-- migration 018 only when those tables exist. Use a DO block to probe
-- pg_trigger and skip when absent.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'audit_log_team_members' AND NOT tgisinternal
  ) THEN
    ALTER TABLE public.team_members DISABLE TRIGGER audit_log_team_members;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'audit_log_team_policies' AND NOT tgisinternal
  ) THEN
    ALTER TABLE public.team_policies DISABLE TRIGGER audit_log_team_policies;
  END IF;
END $$;
