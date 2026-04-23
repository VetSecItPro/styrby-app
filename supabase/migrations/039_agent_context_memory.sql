-- ============================================================================
-- Migration 039: Agent Context Memory — Cross-Agent Context Sync (Phase 3.5)
--
-- Adds:
--   1. agent_context_memory table — structured memory record per session group
--   2. Indexes for group lookup and version ordering
--   3. RLS: user can only access their own groups' memory
--   4. updated_at trigger (consistent with prior table patterns)
--   5. Extend audit_action enum with context-sync values
--
-- Design rationale:
--   When a user switches the active agent in a session group, the new agent
--   starts cold with no knowledge of what the previous agent was doing.
--   agent_context_memory closes this gap: it holds a structured summary of
--   the project state (markdown), relevant file references (JSONB), and the
--   last 20 message summaries (JSONB — no raw content; scrub engine applied).
--
--   The token_budget column lets the injection system truncate the memory
--   to fit the target agent's context window. The version column enables
--   optimistic-locking writes from concurrent CLI workers without clobbering
--   each other.
--
--   One record per session group (upsert on session_group_id). Older versions
--   are preserved in the version history by bumping the version counter;
--   but the "live" record is always the one with the highest version for
--   that group.
--
-- Security model:
--   - RLS: membership derived via agent_session_groups.user_id = auth.uid()
--   - recent_messages stores SCRUBBED summaries only (Phase 3.3 scrub engine)
--   - Raw message content never stored in this table (GDPR Art. 5(1)(c))
--   - token_budget is server-side enforced (capped at 8000) to prevent DoS
--
-- References:
--   Phase 3.1: agent_session_groups (migration 035)
--   Phase 3.3: scrub engine — packages/styrby-shared/src/session-replay/scrub.ts
--
-- GDPR Art. 5(1)(c) data minimisation — only scrubbed summaries stored.
-- SOC2 CC6.1 — no cached plaintext; scrub applied before every write.
-- ============================================================================

-- ============================================================================
-- 1. agent_context_memory table
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.agent_context_memory (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- FK to the session group this memory record belongs to.
  -- ON DELETE CASCADE: deleting a group wipes its memory — no orphaned data.
  -- WHY CASCADE not SET NULL: orphaned memory records with no group have no
  -- owner context and can never be accessed (RLS blocks them). They would
  -- accumulate as storage waste.
  session_group_id    UUID NOT NULL REFERENCES public.agent_session_groups(id) ON DELETE CASCADE,

  -- Condensed project state in Markdown. Built by the summarizer using the
  -- fixed template: "## Current task / ## Recently touched / ## Open questions".
  -- Length bounded by token_budget at write time; typically 400-2000 chars.
  --
  -- WHY Markdown: All 11 supported agents accept system-role prompts in Markdown.
  -- Markdown headings make the structure machine-parseable for injection.
  summary_markdown    TEXT NOT NULL,

  -- Array of file references extracted from tool_call arguments in recent messages.
  -- Schema: [{ "path": "/abs/path/file.ts", "lastTouchedAt": "ISO8601", "relevance": 0.0-1.0 }]
  --
  -- WHY JSONB not a separate table: file refs are ephemeral; they change every
  -- sync cycle. A separate table would require DELETE + INSERT on every sync,
  -- creating churn on a hot path. JSONB with a full replacement update is
  -- simpler and matches the "replace-on-sync" semantic.
  file_refs           JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Last 20 message summaries (scrubbed). NEVER raw message content.
  -- Schema: [{ "role": "user"|"assistant"|"tool", "preview": "first 200 chars" }]
  --
  -- WHY 20 messages: Matches the spec. Empirically, 20 messages cover ~1 task
  -- cycle for all supported agents. Going beyond 20 hits token budget limits.
  --
  -- SECURITY: Secrets, file paths, and shell commands are stripped by the
  -- Phase 3.3 scrub engine before this column is written. The application
  -- layer is responsible for scrubbing; no DB trigger can enforce content rules.
  recent_messages     JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Maximum tokens this memory may consume when injected into a new agent.
  -- The summarizer truncates content to this budget. Server-side cap: 8000.
  --
  -- WHY 4000 default: balances context richness against not consuming a large
  -- fraction of a model's context window on memory injection alone.
  token_budget        INTEGER NOT NULL DEFAULT 4000
    CONSTRAINT token_budget_min CHECK (token_budget >= 100)
    CONSTRAINT token_budget_max CHECK (token_budget <= 8000),

  -- Optimistic locking counter. Incremented by 1 on every sync write.
  -- WHY: CLI workers can race on sync (e.g. two terminals sharing the same
  -- session group). The writer reads current version, increments, then uses
  -- WHERE version = <expected> in the UPDATE. If the row was concurrently
  -- updated, the write fails and the writer re-reads before retrying.
  version             INTEGER NOT NULL DEFAULT 1
    CONSTRAINT version_positive CHECK (version >= 1),

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.agent_context_memory IS
  'Structured memory record for a session group enabling cross-agent context sync. '
  'Holds a scrubbed markdown summary, file references, and last-20 message previews. '
  'Injected as a system-role prompt when focus switches to a new agent. Phase 3.5.';

COMMENT ON COLUMN public.agent_context_memory.summary_markdown IS
  'Condensed project state in Markdown. Scrubbed via Phase 3.3 scrub engine. '
  'Injected verbatim as a system-role message to the newly-focused agent.';

COMMENT ON COLUMN public.agent_context_memory.file_refs IS
  'JSONB array of file references extracted from tool_call arguments. '
  'Schema: [{ path: string, lastTouchedAt: string, relevance: number }]. '
  'Sorted descending by relevance when injected.';

COMMENT ON COLUMN public.agent_context_memory.recent_messages IS
  'JSONB array of last-20 message summaries. SCRUBBED — no raw content. '
  'Schema: [{ role: string, preview: string (≤200 chars) }]. '
  'GDPR Art. 5(1)(c): only the minimum necessary preview is stored.';

COMMENT ON COLUMN public.agent_context_memory.token_budget IS
  'Maximum tokens this memory may consume when injected. '
  'Server-side cap: 8000. Client-supplied budgets above 8000 are rejected.';

COMMENT ON COLUMN public.agent_context_memory.version IS
  'Optimistic locking counter. Write pattern: UPDATE ... WHERE version = $expected '
  'AND SET version = $expected + 1. Retry on 0-rows-affected.';

-- ============================================================================
-- 2. Indexes
-- ============================================================================

-- Primary lookup: get the memory record for a group.
-- WHY UNIQUE: one memory record per group (latest state wins via upsert).
-- The application performs INSERT ... ON CONFLICT (session_group_id) DO UPDATE.
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_context_memory_group_id_unique
  ON public.agent_context_memory(session_group_id);

-- Version ordering index: supports "get highest version for group" queries.
-- Partial index on non-null groups (all rows qualify, so this is a full index).
CREATE INDEX IF NOT EXISTS idx_agent_context_memory_version
  ON public.agent_context_memory(session_group_id, version DESC);

-- ============================================================================
-- 3. updated_at trigger (reuses pattern from agent_session_groups)
-- ============================================================================

-- WHY: Consistent trigger pattern — application code never needs to manually
-- set updated_at. The trigger fires on every UPDATE row.
CREATE OR REPLACE FUNCTION public.set_agent_context_memory_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_agent_context_memory_updated_at
  BEFORE UPDATE ON public.agent_context_memory
  FOR EACH ROW EXECUTE FUNCTION public.set_agent_context_memory_updated_at();

-- ============================================================================
-- 4. RLS
-- ============================================================================

ALTER TABLE public.agent_context_memory ENABLE ROW LEVEL SECURITY;

-- WHY join to agent_session_groups: agent_context_memory has no direct user_id
-- column (denormalizing it would drift from the source of truth). The group
-- record is the ownership anchor.
--
-- WHY (SELECT auth.uid()): query-plan caching per CLAUDE.md "Query Optimization
-- Patterns". Prevents re-evaluating auth.uid() per row.
--
-- WHY subquery with EXISTS: Using a lateral EXISTS is faster than a JOIN
-- for single-row ownership checks because it short-circuits on the first match.
CREATE POLICY "Users can manage their own group context memory"
  ON public.agent_context_memory
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.agent_session_groups g
      WHERE g.id = session_group_id
        AND g.user_id = (SELECT auth.uid())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.agent_session_groups g
      WHERE g.id = session_group_id
        AND g.user_id = (SELECT auth.uid())
    )
  );

-- ============================================================================
-- 5. Extend audit_action enum with context-sync values
-- ============================================================================

-- WHY IF NOT EXISTS guard: ALTER TYPE ADD VALUE is non-transactional.
-- Safe to re-run if migration is retried.
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'context_memory_synced';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'context_memory_injected';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'context_memory_exported';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'context_memory_imported';
