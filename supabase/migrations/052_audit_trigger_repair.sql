-- Migration 052: Add 'record_mutated' enum value (transaction-isolated).
--
-- MUST be a separate migration from the audit_trigger_fn repair (053) because
-- Postgres raises 55P04 "unsafe use of new value" if an ALTER TYPE ADD VALUE
-- is referenced in the same transaction that created it. Each migration file
-- is its own transaction in the Supabase migration runner, so splitting the
-- enum add (here) from the function body that references it (053) resolves
-- the constraint.
--
-- See migration 053 for the full audit_trigger_fn repair, trigger re-enablement,
-- and self-test. See migration 018 for the original (broken) audit_trigger_fn
-- and the 5 triggers that migration 0395 disabled.
--
-- Governing: SOC2 CC7.2 (audit logging correctness).

ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'record_mutated';
