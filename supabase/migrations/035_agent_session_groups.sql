-- ============================================================================
-- Migration 035: Agent Session Groups — Multi-Agent Concurrent Sessions (Phase 3.1)
--
-- Adds:
--   1. agent_session_groups table — parent record tying N concurrent sessions together
--   2. sessions.session_group_id FK → agent_session_groups
--   3. RLS: users can only read/write their own groups
--   4. Indexes for FK traversal and active-session lookup
--   5. Extend audit_action enum with group-related values
--
-- Design rationale:
--   A session group is a lightweight parent record. Each individual session
--   still has its own session_id, cost_records, and messages — they are just
--   logically linked by session_group_id. The active_agent_session_id pointer
--   tracks which session the user is currently "focused on" in the mobile UI.
--
--   The group can survive partial agent failures: if claude crashes but codex
--   is still running, session_group_id remains intact and the focus pointer
--   shifts to the surviving session.
--
-- Security model:
--   - RLS: user_id = auth.uid() on all operations (standard pattern)
--   - active_agent_session_id FK uses ON DELETE SET NULL to survive session deletion
--   - session_group_id FK on sessions uses ON DELETE SET NULL to survive group deletion
--   - No cross-user group sharing (Phase 3.x concern)
-- ============================================================================

-- ============================================================================
-- 1. agent_session_groups table
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.agent_session_groups (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Human-readable label set by the user or derived from the --prompt flag.
  -- e.g. "Refactoring PR #42 across agents"
  name                    TEXT NOT NULL DEFAULT '',

  -- The session the mobile user is currently "focused" on.
  -- WHY nullable: when the group first spawns, we set this once the first
  -- session starts running. When the focused session ends, the CLI updates
  -- this to the next available running session (or NULL if all are stopped).
  -- ON DELETE SET NULL ensures the group persists even if a session is deleted.
  active_agent_session_id UUID REFERENCES public.sessions(id) ON DELETE SET NULL,

  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.agent_session_groups IS
  'Parent record linking N concurrent agent sessions together for multi-agent workflows. '
  'The active_agent_session_id points to the session currently focused in the mobile UI. '
  'Created by `styrby multi`; Phase 3.1.';

COMMENT ON COLUMN public.agent_session_groups.active_agent_session_id IS
  'Session the mobile UI is currently focused on. '
  'Updated by POST /api/sessions/groups/[groupId]/focus. '
  'NULL means no session is active (all stopped or not yet started).';

-- ============================================================================
-- 2. Add session_group_id to sessions
-- ============================================================================

-- WHY NULL default: existing sessions pre-Phase-3.1 are not part of any group.
-- WHY ON DELETE SET NULL: if a group is deleted, member sessions survive orphaned
-- (useful for history browsing). This is safer than CASCADE which would wipe
-- all sessions in the group.
ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS session_group_id UUID
    REFERENCES public.agent_session_groups(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.sessions.session_group_id IS
  'Optional FK to agent_session_groups. NULL for single-agent sessions. '
  'Set when session is spawned via `styrby multi`.';

-- ============================================================================
-- 3. Indexes
-- ============================================================================

-- List all sessions in a group (mobile strip and CLI status)
CREATE INDEX IF NOT EXISTS idx_sessions_group_id
  ON public.sessions(session_group_id)
  WHERE session_group_id IS NOT NULL;

-- Lookup groups by owner (dashboard listing)
CREATE INDEX IF NOT EXISTS idx_agent_session_groups_user_id
  ON public.agent_session_groups(user_id);

-- Fast lookup of the active session for a group (focus pointer)
CREATE INDEX IF NOT EXISTS idx_agent_session_groups_active_session
  ON public.agent_session_groups(active_agent_session_id)
  WHERE active_agent_session_id IS NOT NULL;

-- ============================================================================
-- 4. updated_at trigger (reuses pattern from other tables in this schema)
-- ============================================================================

-- WHY: Consistent with sessions, budget_alerts etc. which all use this trigger
-- pattern to keep updated_at fresh without application-layer overhead.
CREATE OR REPLACE FUNCTION public.set_agent_session_groups_updated_at()
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

CREATE TRIGGER trg_agent_session_groups_updated_at
  BEFORE UPDATE ON public.agent_session_groups
  FOR EACH ROW EXECUTE FUNCTION public.set_agent_session_groups_updated_at();

-- ============================================================================
-- 5. RLS
-- ============================================================================

ALTER TABLE public.agent_session_groups ENABLE ROW LEVEL SECURITY;

-- WHY (SELECT auth.uid()): query-plan caching per CLAUDE.md "Query Optimization Patterns".
-- Avoids re-evaluating auth.uid() per row for large result sets.

CREATE POLICY "Users can manage their own session groups"
  ON public.agent_session_groups
  FOR ALL
  USING  (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

-- ============================================================================
-- 6. Extend audit_action enum with group-specific values
-- ============================================================================

-- WHY IF NOT EXISTS guard: ALTER TYPE ADD VALUE is non-transactional in Postgres.
-- Safe to re-run (idempotent migration retries).
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'session_group_created';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'session_group_focus_changed';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'session_group_deleted';
