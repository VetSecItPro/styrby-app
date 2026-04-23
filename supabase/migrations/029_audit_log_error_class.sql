-- ============================================================================
-- Migration 029: Structured error_class column on audit_log
-- ============================================================================
--
-- UNBLOCKS: Phase 1.6.7b (Per-agent error class histogram on founder dashboard)
--
-- WHY a dedicated column instead of metadata JSONB:
--   The founder dashboard queries a histogram of error classes over time
--   (`SELECT error_class, count(*) FROM audit_log WHERE created_at > ... GROUP BY error_class`).
--   JSONB path extraction is 10-100x slower than a plain indexed column at
--   the scale we expect (millions of audit rows within a year). A first-class
--   column with a partial index gives sub-10ms histogram queries even at
--   100M rows.
--
-- WHY a CHECK constraint on the 5 values:
--   Phase 1.6.10 (PR #126) already defined this taxonomy via
--   `classifyError()` in daemon/daemonProcess.ts:
--     - network       : transport-level failures (DNS, TLS, timeout, reset)
--     - auth          : 401/403 from relay or Supabase
--     - supabase      : 5xx from Supabase or schema errors
--     - agent_crash   : the child agent process exited non-zero unexpectedly
--     - unknown       : did not match any of the above
--   Locking these into the DB prevents drift between the runtime classifier
--   and the analytics consumer (founder dashboard). Adding a new class
--   requires a new migration AND a classifier update — the constraint
--   enforces that coupling.
--
-- WHY NULL-by-default (not NOT NULL):
--   audit_log covers everything (auth events, setting changes, consent grants,
--   push sends, etc.) — only a small fraction are error events. Forcing
--   error_class NOT NULL would require every non-error audit entry to write
--   a sentinel value, bloating the column and the index. NULL cleanly
--   signals "this audit entry isn't about an error" and the partial index
--   below skips those rows entirely.
--
-- BACKFILL: none required. Existing rows stay NULL; future error-related
-- audit writes (from Phase 1.6.10's classifyError, future phases) start
-- populating the column. If we later want historical backfill, a
-- data-migration script can parse `metadata->>'error'` and derive the
-- classes for pre-029 rows.
--
-- AUDIT CITATION: SOC2 CC7.2 (system operations — monitoring for anomalies).
-- Structured error classes on an immutable audit trail = auditable evidence
-- of error-rate trends and quality-regression windows.
-- ============================================================================

-- Step 1: Add the column (nullable, no default — most audit rows don't have one)
ALTER TABLE audit_log
  ADD COLUMN IF NOT EXISTS error_class TEXT;

-- Step 2: Constrain to the canonical taxonomy from Phase 1.6.10
-- WHY IF NOT EXISTS: makes the migration idempotent in re-run scenarios
-- (e.g., dev resets, accidental re-apply).
ALTER TABLE audit_log
  DROP CONSTRAINT IF EXISTS audit_log_error_class_check;

ALTER TABLE audit_log
  ADD CONSTRAINT audit_log_error_class_check
  CHECK (
    error_class IS NULL
    OR error_class IN ('network', 'auth', 'supabase', 'agent_crash', 'unknown')
  );

-- Step 3: Partial index for the founder dashboard histogram query
-- WHY partial (WHERE error_class IS NOT NULL):
--   The dashboard only cares about rows where an error was recorded. A
--   partial index is smaller + faster to maintain when the vast majority
--   of rows have NULL in this column.
--
-- WHY (error_class, created_at DESC):
--   Typical query shape is "GROUP BY error_class, time-bucket within the
--   last N days." Leading with error_class groups locality; DESC on
--   created_at serves the most-recent-first scan pattern.
CREATE INDEX IF NOT EXISTS idx_audit_log_error_class
  ON audit_log (error_class, created_at DESC)
  WHERE error_class IS NOT NULL;

-- Step 4: Column comment for self-documenting schema
COMMENT ON COLUMN audit_log.error_class IS
  'Structured error taxonomy (Phase 1.6.7b). Matches classifyError() in '
  'daemon/daemonProcess.ts: network | auth | supabase | agent_crash | unknown. '
  'NULL for non-error audit entries (most rows). Used by founder dashboard '
  'error-class histogram. See docs/infrastructure/environment-variables.md '
  'for pg_cron and env-var provenance.';
