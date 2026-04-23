/**
 * Migration 035 structural tests — agent_session_groups (Phase 3.1)
 *
 * Validates that migration 035 contains all required DDL, RLS policies,
 * indexes, FK constraints, and audit_action values. These are file-content
 * regression tests — fast, no DB connection required.
 *
 * WHY regression tests for migrations:
 *   Migrations are irreversible in production. Missing RLS on the new table,
 *   or a missing audit_action enum value, would be a silent security gap.
 *   Catching these at CI time costs milliseconds; catching in production
 *   requires emergency hotfix migrations.
 *
 * Invariants tested:
 *   1. agent_session_groups table DDL (all required columns)
 *   2. session_group_id FK added to sessions
 *   3. ON DELETE SET NULL for both FKs
 *   4. RLS enabled + policy present
 *   5. Updated_at trigger
 *   6. All 3 indexes created
 *   7. audit_action enum values present
 *   8. No missing IF NOT EXISTS guards (idempotent re-run safety)
 *
 * @module __tests__/migration-035
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Path: packages/styrby-web/src/__tests__/migration-035.test.ts
// __dirname = .../packages/styrby-web/src/__tests__
// ../../../.. = worktree root (where supabase/ lives)
const MIGRATIONS_DIR = resolve(__dirname, '../../../..', 'supabase/migrations');

function readMigration(filename: string): string {
  return readFileSync(resolve(MIGRATIONS_DIR, filename), 'utf-8');
}

describe('Migration 035: agent_session_groups', () => {
  const sql = readMigration('035_agent_session_groups.sql');

  // ── Table DDL ──────────────────────────────────────────────────────────────

  it('creates agent_session_groups table', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.agent_session_groups');
  });

  it('has id UUID PRIMARY KEY', () => {
    expect(sql).toContain('id');
    expect(sql).toContain('UUID PRIMARY KEY');
    expect(sql).toContain('gen_random_uuid()');
  });

  it('has user_id UUID FK to auth.users with CASCADE', () => {
    expect(sql).toContain('user_id');
    expect(sql).toContain('REFERENCES auth.users(id) ON DELETE CASCADE');
  });

  it('has name TEXT column with empty string default', () => {
    expect(sql).toContain("name                    TEXT NOT NULL DEFAULT ''");
  });

  it('has active_agent_session_id UUID FK to sessions with ON DELETE SET NULL', () => {
    expect(sql).toContain('active_agent_session_id UUID REFERENCES public.sessions(id) ON DELETE SET NULL');
  });

  it('has created_at and updated_at TIMESTAMPTZ columns', () => {
    expect(sql).toContain('created_at');
    expect(sql).toContain('updated_at');
    expect(sql).toContain('TIMESTAMPTZ');
    expect(sql).toContain('DEFAULT now()');
  });

  // ── sessions FK addition ───────────────────────────────────────────────────

  it('adds session_group_id column to sessions table', () => {
    expect(sql).toContain('ALTER TABLE public.sessions');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS session_group_id UUID');
    expect(sql).toContain('REFERENCES public.agent_session_groups(id) ON DELETE SET NULL');
  });

  // ── Indexes ─────────────────────────────────────────────────────────────────

  it('creates idx_sessions_group_id index', () => {
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_sessions_group_id');
    expect(sql).toContain('ON public.sessions(session_group_id)');
    expect(sql).toContain('WHERE session_group_id IS NOT NULL');
  });

  it('creates idx_agent_session_groups_user_id index', () => {
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_agent_session_groups_user_id');
    expect(sql).toContain('ON public.agent_session_groups(user_id)');
  });

  it('creates idx_agent_session_groups_active_session index', () => {
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_agent_session_groups_active_session');
    expect(sql).toContain('WHERE active_agent_session_id IS NOT NULL');
  });

  // ── Updated_at trigger ─────────────────────────────────────────────────────

  it('creates updated_at trigger function', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.set_agent_session_groups_updated_at()');
  });

  it('creates trigger on agent_session_groups', () => {
    expect(sql).toContain('CREATE TRIGGER trg_agent_session_groups_updated_at');
    expect(sql).toContain('BEFORE UPDATE ON public.agent_session_groups');
  });

  // ── RLS ───────────────────────────────────────────────────────────────────

  it('enables RLS on agent_session_groups', () => {
    expect(sql).toContain('ALTER TABLE public.agent_session_groups ENABLE ROW LEVEL SECURITY');
  });

  it('creates RLS policy for user ownership', () => {
    expect(sql).toContain("CREATE POLICY");
    expect(sql).toContain('agent_session_groups');
    expect(sql).toContain('FOR ALL');
    // Query-plan caching pattern (CLAUDE.md "Query Optimization Patterns")
    expect(sql).toContain('(SELECT auth.uid())');
  });

  // ── audit_action enum ─────────────────────────────────────────────────────

  it('adds session_group_created audit action', () => {
    expect(sql).toContain("ADD VALUE IF NOT EXISTS 'session_group_created'");
  });

  it('adds session_group_focus_changed audit action', () => {
    expect(sql).toContain("ADD VALUE IF NOT EXISTS 'session_group_focus_changed'");
  });

  it('adds session_group_deleted audit action', () => {
    expect(sql).toContain("ADD VALUE IF NOT EXISTS 'session_group_deleted'");
  });

  // ── Idempotency guards ─────────────────────────────────────────────────────

  it('uses IF NOT EXISTS on all CREATE TABLE and CREATE INDEX statements', () => {
    // Verify CREATE TABLE uses IF NOT EXISTS
    const createTable = sql.match(/CREATE TABLE/g) ?? [];
    const createTableIfNotExists = sql.match(/CREATE TABLE IF NOT EXISTS/g) ?? [];
    expect(createTableIfNotExists.length).toBe(createTable.length);

    // Verify CREATE INDEX uses IF NOT EXISTS
    const createIndex = sql.match(/CREATE INDEX/g) ?? [];
    const createIndexIfNotExists = sql.match(/CREATE INDEX IF NOT EXISTS/g) ?? [];
    expect(createIndexIfNotExists.length).toBe(createIndex.length);

    // CREATE TRIGGER does not support IF NOT EXISTS in Postgres; that is expected.
    // CREATE OR REPLACE FUNCTION is also safe for idempotent re-runs.
    // So we only require TABLE and INDEX to have the guard.
  });

  it('uses IF NOT EXISTS on ALTER TYPE ADD VALUE statements', () => {
    // Only examine ALTER TYPE ... ADD VALUE lines, not comments.
    const addValueLines = sql
      .split('\n')
      .filter((line) => !line.trim().startsWith('--') && /ADD VALUE/.test(line));

    for (const line of addValueLines) {
      expect(line).toContain('IF NOT EXISTS');
    }
  });

  // ── Table comments ─────────────────────────────────────────────────────────

  it('has COMMENT ON TABLE for agent_session_groups', () => {
    expect(sql).toContain('COMMENT ON TABLE public.agent_session_groups');
  });

  it('has COMMENT ON COLUMN for active_agent_session_id', () => {
    expect(sql).toContain('COMMENT ON COLUMN public.agent_session_groups.active_agent_session_id');
  });

  it('has COMMENT ON COLUMN for sessions.session_group_id', () => {
    expect(sql).toContain('COMMENT ON COLUMN public.sessions.session_group_id');
  });
});
