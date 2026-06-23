-- ============================================================================
-- Migration 103: Extend agent_type enum to all 11 supported agents
-- ============================================================================
-- ROOT CAUSE (INV token-tracking, 2026-06): the `agent_type` enum was created
-- in migration 001 with only ('claude','codex','gemini'). Styrby now supports
-- 11 agents (see packages/styrby-shared/src/types.ts). Every persistence write
-- keyed on agent_type — the `sessions` row insert (api/apiSession.ts) and the
-- `cost_records` insert (/api/v1/cost-records) — is REJECTED by Postgres for
-- the 8 missing agents (invalid_text_representation, 22P02), and on the CLI
-- side that error was swallowed. Net effect: sessions and token/cost rows for
-- opencode/aider/goose/amp/crush/kilo/kiro/droid never persisted at all.
--
-- This adds the 8 missing values so persistence works uniformly across every
-- supported agent. (claude/codex/gemini already exist and are untouched.)
--
-- WHY ADD VALUE IF NOT EXISTS: idempotent + safe to re-run (CI db-reset
-- re-applies all migrations). ADD VALUE is non-transactional-sensitive in
-- PG12+ when the new value is not USED in the same migration — we only add
-- values here; no statement in this migration references them.
-- ============================================================================

ALTER TYPE agent_type ADD VALUE IF NOT EXISTS 'opencode';
ALTER TYPE agent_type ADD VALUE IF NOT EXISTS 'aider';
ALTER TYPE agent_type ADD VALUE IF NOT EXISTS 'goose';
ALTER TYPE agent_type ADD VALUE IF NOT EXISTS 'amp';
ALTER TYPE agent_type ADD VALUE IF NOT EXISTS 'crush';
ALTER TYPE agent_type ADD VALUE IF NOT EXISTS 'kilo';
ALTER TYPE agent_type ADD VALUE IF NOT EXISTS 'kiro';
ALTER TYPE agent_type ADD VALUE IF NOT EXISTS 'droid';
