-- ============================================================================
-- STYRBY DATABASE MIGRATION 032: Approval Chain Audit Actions + Token Column
-- ============================================================================
-- Phase 2.4 — CLI approval chain wiring.
--
-- This migration extends the audit_action enum with the three terminal states
-- of the approval round-trip so that every resolution decision is persisted
-- in the audit_log with a first-class action value rather than a generic
-- 'settings_updated' fallback.
--
-- It also adds an `approval_token` column to `approvals` that holds a
-- cryptographically-random, HMAC-verifiable token. The CLI receives this
-- token at submit time and must include it on every poll/cancel request.
-- The edge function re-derives the HMAC from (approvalId, secret) and
-- compares in constant time (timing-safe). This prevents IDOR — a
-- low-privilege user who knows a UUID cannot drive another team's approval.
--
-- Compliance anchors:
--   - SOC2 CC6.2: distinct audit_action values for each decision
--   - SOC2 CC7.1: all approvals logged with resolver identity + timestamp
--   - ISO 27001 A.9.1: HMAC token guards the approval endpoint
--
-- New enum values (3):
--   team_command_approved  — requester's tool call was approved
--   team_command_denied    — requester's tool call was denied
--   team_command_timeout   — approval row expired before a decision
--
-- Schema changes (1):
--   approvals.approval_token  TEXT NOT NULL DEFAULT ''
--     (populated by the resolve-approval edge function on first INSERT;
--     empty default lets us apply to existing rows safely)
--
-- Dependencies:
--   - Migration 001 (audit_action enum, audit_log table)
--   - Migration 021 (approvals table)
-- ============================================================================


-- ============================================================================
-- STEP 1: Extend audit_action enum
-- ============================================================================
-- WHY three distinct values instead of a single 'team_command_resolved':
--   The audit_log `action` column is queried by dashboards, security
--   reporting, and SOC2 evidence scripts that filter on exact action names.
--   Conflating approve/deny/timeout into one value forces every query to
--   read the `metadata` JSONB for the sub-type — expensive and error-prone.
--   Three values cost nothing at schema level; they save every downstream
--   query a JSONB parse.
--
-- WHY `IF NOT EXISTS`: Idempotent. Safe to replay during DR or local reset.
-- ============================================================================

ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'team_command_approved';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'team_command_denied';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'team_command_timeout';


-- ============================================================================
-- STEP 2: Add approval_token to approvals
-- ============================================================================
-- WHY a separate token rather than using the UUID primary key:
--   The UUID is returned in Supabase Realtime events visible to all team
--   members (read-scoped via RLS SELECT). A separate HMAC-derived token,
--   transmitted only over the authenticated POST /resolve-approval channel,
--   means that knowing an approval's UUID is not sufficient to drive it.
--
-- WHY TEXT (not BYTEA): the token is a 64-char hex-encoded HMAC-SHA256
--   output. TEXT is marginally easier to pass through JSON without
--   additional encoding. The extra ~3% storage is irrelevant for this table.
--
-- WHY DEFAULT '': the column must be NOT NULL (token must always be set
--   before polling), but the empty string lets us ALTER TABLE on a live
--   table without backfilling existing rows that predate this migration.
--   The edge function's INSERT always supplies the token; the empty default
--   is purely a DDL concession, not a valid operational state.
-- ============================================================================

ALTER TABLE approvals
  ADD COLUMN IF NOT EXISTS approval_token TEXT NOT NULL DEFAULT '';

-- Partial index: lookup by token for the edge function's constant-time
-- verify path. Only active (pending) rows need fast token lookup.
-- WHY partial on status = 'pending': resolved rows are never re-validated.
CREATE INDEX IF NOT EXISTS idx_approvals_token_pending
  ON approvals (approval_token)
  WHERE status = 'pending' AND approval_token <> '';


-- ============================================================================
-- END OF MIGRATION 032
-- ============================================================================
