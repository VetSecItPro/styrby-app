/**
 * Migration 037 structural tests — session_replay_tokens (Phase 3.3)
 *
 * Validates that migration 037 contains all required DDL for:
 *   - `session_replay_tokens` table with all spec-required columns
 *   - RLS enabled + 4 policies (SELECT / INSERT / UPDATE / DELETE)
 *   - Partial unique index on token_hash (non-revoked rows only)
 *   - Secondary indexes on session_id and created_by
 *   - CASCADE DELETE on session_id FK
 *   - Correct DEFAULT values (expires_at 24h, max_views 10, views_used 0)
 *   - CHECK constraints (max_views > 0, views_used >= 0, views <= max_views)
 *
 * WHY migration regression tests:
 *   - Missing RLS silently exposes tokens to unauthorized readers
 *   - Missing index on token_hash turns every view into a full table scan
 *   - Missing CASCADE DELETE causes FK violations when sessions are deleted
 *   - These file-content tests catch all three regressions in milliseconds
 *
 * @module __tests__/migration-037
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const MIGRATIONS_DIR = resolve(__dirname, '../../../..', 'supabase/migrations');

function readMigration(filename: string): string {
  return readFileSync(resolve(MIGRATIONS_DIR, filename), 'utf-8');
}

describe('Migration 037: session_replay_tokens', () => {
  const sql = readMigration('037_session_replay_tokens.sql');

  // ── Table creation ──────────────────────────────────────────────────────────

  it('creates session_replay_tokens with IF NOT EXISTS guard', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS session_replay_tokens');
  });

  // ── Required columns ────────────────────────────────────────────────────────

  it('has id UUID PRIMARY KEY with gen_random_uuid()', () => {
    expect(sql).toContain('id            UUID        PRIMARY KEY DEFAULT gen_random_uuid()');
  });

  it('has session_id UUID with FK to sessions(id) ON DELETE CASCADE', () => {
    expect(sql).toContain('REFERENCES sessions(id) ON DELETE CASCADE');
  });

  it('has created_by UUID FK to profiles(id)', () => {
    expect(sql).toContain('REFERENCES profiles(id) ON DELETE CASCADE');
  });

  it('has token_hash TEXT UNIQUE NOT NULL', () => {
    expect(sql).toContain('token_hash    TEXT        UNIQUE NOT NULL');
  });

  it('has expires_at TIMESTAMPTZ with 24-hour default', () => {
    expect(sql).toContain("expires_at    TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours'");
  });

  it('has max_views INTEGER with DEFAULT 10', () => {
    expect(sql).toContain('max_views     INTEGER     DEFAULT 10');
  });

  it('has views_used INTEGER DEFAULT 0 NOT NULL', () => {
    expect(sql).toContain('views_used    INTEGER     NOT NULL DEFAULT 0');
  });

  it('has scrub_mask JSONB with default', () => {
    expect(sql).toContain('scrub_mask    JSONB       NOT NULL DEFAULT');
    // Verify the default includes secrets:true
    expect(sql).toContain('"secrets":true');
  });

  it('has revoked_at TIMESTAMPTZ NULL', () => {
    expect(sql).toContain('revoked_at    TIMESTAMPTZ');
  });

  it('has created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()', () => {
    expect(sql).toContain('created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()');
  });

  // ── CHECK constraints ───────────────────────────────────────────────────────

  it('has CHECK constraint that max_views > 0 when not null', () => {
    expect(sql).toContain('max_views IS NULL OR max_views > 0');
  });

  it('has CHECK constraint that views_used >= 0', () => {
    expect(sql).toContain('views_used >= 0');
  });

  it('has CHECK constraint enforcing views_used <= max_views', () => {
    expect(sql).toContain('max_views IS NULL OR views_used <= max_views');
  });

  // ── Indexes ──────────────────────────────────────────────────────────────────

  it('creates a partial unique index on token_hash (WHERE revoked_at IS NULL)', () => {
    expect(sql).toContain('ON session_replay_tokens(token_hash)');
    expect(sql).toContain('WHERE revoked_at IS NULL');
  });

  it('creates an index on session_id', () => {
    expect(sql).toContain('ON session_replay_tokens(session_id)');
  });

  it('creates an index on created_by with DESC created_at', () => {
    expect(sql).toContain('ON session_replay_tokens(created_by, created_at DESC)');
  });

  // ── RLS ─────────────────────────────────────────────────────────────────────

  it('enables RLS on session_replay_tokens', () => {
    expect(sql).toContain('ALTER TABLE session_replay_tokens ENABLE ROW LEVEL SECURITY');
  });

  it('has SELECT policy scoped to created_by = auth.uid()', () => {
    expect(sql).toContain("creator can select own");
    expect(sql).toContain('FOR SELECT USING (created_by = (SELECT auth.uid()))');
  });

  it('has INSERT policy with WITH CHECK', () => {
    expect(sql).toContain("creator can insert own");
    expect(sql).toContain('FOR INSERT WITH CHECK (created_by = (SELECT auth.uid()))');
  });

  it('has UPDATE policy scoped to creator', () => {
    expect(sql).toContain("creator can update own");
    expect(sql).toContain('FOR UPDATE USING (created_by = (SELECT auth.uid()))');
  });

  it('has DELETE policy scoped to creator', () => {
    expect(sql).toContain("creator can delete own");
    expect(sql).toContain('FOR DELETE USING (created_by = (SELECT auth.uid()))');
  });

  // ── SOC2 citation ───────────────────────────────────────────────────────────

  it('contains SOC2 CC7.2 audit citation', () => {
    expect(sql).toContain('SOC2 CC7.2');
  });

  // ── No IF NOT EXISTS on RLS (Postgres idempotency) ─────────────────────────

  it('uses CREATE POLICY (idempotent in standard migrations)', () => {
    expect(sql).toContain('CREATE POLICY');
  });
});
