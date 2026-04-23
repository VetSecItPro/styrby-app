/**
 * Migration 039 structural tests — agent_context_memory (Phase 3.5)
 *
 * Validates that migration 039 contains all required DDL for:
 *   - `agent_context_memory` table with all spec-required columns
 *   - RLS enabled + ownership policy via agent_session_groups join
 *   - UNIQUE index on session_group_id (one memory record per group)
 *   - Version ordering index
 *   - updated_at trigger
 *   - CHECK constraints on token_budget and version
 *   - ON DELETE CASCADE FK to agent_session_groups
 *   - audit_action enum extensions (4 new values)
 *
 * WHY migration regression tests:
 *   - Missing RLS exposes context memory to unauthorized readers (cross-user leak)
 *   - Missing UNIQUE index on session_group_id would allow duplicate memory records
 *     that corrupt the upsert-on-sync pattern
 *   - Missing token_budget CHECK constraints would allow client-supplied budgets
 *     above 8000 to bypass the server-side cap in the DB layer
 *   - These file-content tests catch all three regressions in milliseconds
 *
 * @module __tests__/migration-039
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const MIGRATIONS_DIR = resolve(__dirname, '../../../..', 'supabase/migrations');

function readMigration(filename: string): string {
  return readFileSync(resolve(MIGRATIONS_DIR, filename), 'utf-8');
}

describe('Migration 039: agent_context_memory', () => {
  const sql = readMigration('039_agent_context_memory.sql');

  // ── Table creation ──────────────────────────────────────────────────────────

  it('creates agent_context_memory with IF NOT EXISTS guard', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.agent_context_memory');
  });

  // ── Required columns ────────────────────────────────────────────────────────

  it('has id UUID PRIMARY KEY with gen_random_uuid()', () => {
    expect(sql).toContain('id                  UUID PRIMARY KEY DEFAULT gen_random_uuid()');
  });

  it('has session_group_id UUID NOT NULL with FK to agent_session_groups(id)', () => {
    expect(sql).toContain('session_group_id    UUID NOT NULL REFERENCES public.agent_session_groups(id)');
  });

  it('has ON DELETE CASCADE on session_group_id FK', () => {
    expect(sql).toContain('ON DELETE CASCADE');
  });

  it('has summary_markdown TEXT NOT NULL', () => {
    expect(sql).toContain('summary_markdown    TEXT NOT NULL');
  });

  it('has file_refs JSONB with empty array default', () => {
    expect(sql).toContain("file_refs           JSONB NOT NULL DEFAULT '[]'::jsonb");
  });

  it('has recent_messages JSONB with empty array default', () => {
    expect(sql).toContain("recent_messages     JSONB NOT NULL DEFAULT '[]'::jsonb");
  });

  it('has token_budget INTEGER with DEFAULT 4000', () => {
    expect(sql).toContain('token_budget        INTEGER NOT NULL DEFAULT 4000');
  });

  it('has version INTEGER with DEFAULT 1', () => {
    expect(sql).toContain('version             INTEGER NOT NULL DEFAULT 1');
  });

  it('has created_at TIMESTAMPTZ', () => {
    expect(sql).toContain('created_at          TIMESTAMPTZ NOT NULL DEFAULT now()');
  });

  it('has updated_at TIMESTAMPTZ', () => {
    expect(sql).toContain('updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()');
  });

  // ── CHECK constraints ───────────────────────────────────────────────────────

  it('enforces token_budget minimum (100)', () => {
    expect(sql).toContain('token_budget >= 100');
  });

  it('enforces token_budget maximum (8000)', () => {
    expect(sql).toContain('token_budget <= 8000');
  });

  it('enforces version positive (>= 1)', () => {
    expect(sql).toContain('version >= 1');
  });

  // ── Indexes ─────────────────────────────────────────────────────────────────

  it('creates UNIQUE index on session_group_id', () => {
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_context_memory_group_id_unique');
  });

  it('creates version ordering index', () => {
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_agent_context_memory_version');
  });

  // ── updated_at trigger ──────────────────────────────────────────────────────

  it('creates set_agent_context_memory_updated_at function', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.set_agent_context_memory_updated_at()');
  });

  it('creates updated_at trigger on agent_context_memory', () => {
    expect(sql).toContain('CREATE TRIGGER trg_agent_context_memory_updated_at');
  });

  it('trigger fires BEFORE UPDATE', () => {
    expect(sql).toContain('BEFORE UPDATE ON public.agent_context_memory');
  });

  // ── RLS ─────────────────────────────────────────────────────────────────────

  it('enables RLS on agent_context_memory', () => {
    expect(sql).toContain('ALTER TABLE public.agent_context_memory ENABLE ROW LEVEL SECURITY');
  });

  it('creates RLS policy via agent_session_groups join', () => {
    expect(sql).toContain('CREATE POLICY');
    expect(sql).toContain('agent_session_groups');
  });

  it('RLS policy uses (SELECT auth.uid()) for query-plan caching', () => {
    expect(sql).toContain('(SELECT auth.uid())');
  });

  it('RLS policy has both USING and WITH CHECK clauses', () => {
    expect(sql).toContain('USING (');
    expect(sql).toContain('WITH CHECK (');
  });

  // ── audit_action enum extensions ────────────────────────────────────────────

  it('adds context_memory_synced to audit_action', () => {
    expect(sql).toContain("ADD VALUE IF NOT EXISTS 'context_memory_synced'");
  });

  it('adds context_memory_injected to audit_action', () => {
    expect(sql).toContain("ADD VALUE IF NOT EXISTS 'context_memory_injected'");
  });

  it('adds context_memory_exported to audit_action', () => {
    expect(sql).toContain("ADD VALUE IF NOT EXISTS 'context_memory_exported'");
  });

  it('adds context_memory_imported to audit_action', () => {
    expect(sql).toContain("ADD VALUE IF NOT EXISTS 'context_memory_imported'");
  });

  // ── Security rationale in comments ─────────────────────────────────────────

  it('references GDPR Art. 5(1)(c) data minimisation in comments', () => {
    expect(sql).toContain('GDPR Art. 5(1)(c)');
  });

  it('references SOC2 CC6.1 in comments', () => {
    expect(sql).toContain('SOC2 CC6.1');
  });
});
