/**
 * Migration 027 structural tests.
 *
 * Validates that the feedback loop migration contains all required DDL
 * and pg_cron configuration. These are file-content regression tests —
 * they run fast, require no DB connection, and catch accidental deletions
 * or renames before CI deploys the migration to production.
 *
 * WHY regression tests for migrations: Migrations are irreversible in
 * production. A missing cron job registration or trigger means NPS prompts
 * never fire. Catching these at test time costs seconds; catching them in
 * production costs days of manual remediation.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Path: packages/styrby-web/src/__tests__/feedback/migration-027.test.ts
// __dirname = .../packages/styrby-web/src/__tests__/feedback
// ../../.. = .../packages/styrby-web
// ../../../.. = .../packages
// ../../../../.. = worktree root (where supabase/ lives)
const MIGRATIONS_DIR = resolve(__dirname, '../../../../..', 'supabase/migrations');

function readMigration(filename: string): string {
  return readFileSync(resolve(MIGRATIONS_DIR, filename), 'utf-8');
}

describe('Migration 027: feedback_loop', () => {
  const sql = readMigration('027_feedback_loop.sql');

  // ── Schema: user_feedback_prompts ────────────────────────────────────────
  it('creates user_feedback_prompts table', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS user_feedback_prompts');
  });

  it('has UNIQUE constraint on (user_id, kind)', () => {
    expect(sql).toContain('UNIQUE (user_id, kind)');
  });

  it('has index on due_at for scheduler polling', () => {
    expect(sql).toContain('idx_feedback_prompts_due');
    expect(sql).toContain('dispatched_at IS NULL');
  });

  it('has RLS enabled on user_feedback_prompts', () => {
    expect(sql).toContain('ALTER TABLE user_feedback_prompts ENABLE ROW LEVEL SECURITY');
  });

  // ── Schema: user_feedback extensions ─────────────────────────────────────
  it('adds kind column to user_feedback', () => {
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS kind TEXT");
    expect(sql).toContain("'nps', 'general', 'session_postmortem', 'icp_soft'");
  });

  it('adds score column (0-10) to user_feedback', () => {
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS score INTEGER');
    expect(sql).toContain('score >= 0 AND score <= 10');
  });

  it('adds nps_window column to user_feedback', () => {
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS nps_window TEXT");
    expect(sql).toContain("'7d', '30d'");
  });

  it('adds rating column for post-mortems', () => {
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS rating TEXT");
    expect(sql).toContain("'useful', 'not_useful'");
  });

  it('adds reason column for post-mortems', () => {
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS reason TEXT');
  });

  it('adds context_json column (no PII)', () => {
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS context_json JSONB');
  });

  it('adds prompt_id FK column', () => {
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS prompt_id UUID');
  });

  // ── Trigger: fn_schedule_nps_prompts ─────────────────────────────────────
  it('creates fn_schedule_nps_prompts trigger function', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION fn_schedule_nps_prompts()');
  });

  it('inserts nps_7d and nps_30d rows in trigger', () => {
    expect(sql).toContain("'nps_7d'");
    expect(sql).toContain("'nps_30d'");
    expect(sql).toContain("INTERVAL '7 days'");
    expect(sql).toContain("INTERVAL '30 days'");
  });

  it('uses ON CONFLICT DO NOTHING for idempotency', () => {
    expect(sql).toContain('ON CONFLICT (user_id, kind) DO NOTHING');
  });

  it('binds trigger to profiles table', () => {
    expect(sql).toContain('CREATE TRIGGER tr_schedule_nps_on_signup');
    expect(sql).toContain('AFTER INSERT ON profiles');
  });

  // ── pg_cron: fn_dispatch_due_nps_prompts ──────────────────────────────────
  it('creates fn_dispatch_due_nps_prompts dispatch function', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION fn_dispatch_due_nps_prompts()');
  });

  it('dispatch function writes audit_log (SOC2 CC7.2)', () => {
    expect(sql).toContain('audit_log');
    expect(sql).toContain('nps_prompt_dispatched');
  });

  it('dispatch function uses SKIP LOCKED for concurrency safety', () => {
    expect(sql).toContain('SKIP LOCKED');
  });

  it('dispatch function caps at 500 prompts per run', () => {
    expect(sql).toContain('LIMIT 500');
  });

  // ── pg_cron job ───────────────────────────────────────────────────────────
  it('schedules styrby_nps_prompt_dispatch every 15 minutes', () => {
    expect(sql).toContain('styrby_nps_prompt_dispatch');
    expect(sql).toContain('*/15 * * * *');
  });

  // ── Backfill ──────────────────────────────────────────────────────────────
  it('backfills existing profiles with nps_7d prompts', () => {
    expect(sql).toContain('INSERT INTO user_feedback_prompts (user_id, kind, due_at)');
    expect(sql).toContain('FROM profiles p');
  });
});

// =============================================================================
// Vercel cron config
// =============================================================================

describe('Vercel cron config (vercel.json)', () => {
  // vercel.json is at packages/styrby-web/vercel.json
  // __dirname = .../packages/styrby-web/src/__tests__/feedback
  // ../../../ = .../packages/styrby-web (3 levels up)
  const vercelJsonPath = resolve(__dirname, '../../..', 'vercel.json');
  const vercelJson = readFileSync(vercelJsonPath, 'utf-8');

  it('includes nps-prompt-dispatch cron every 15 minutes', () => {
    expect(vercelJson).toContain('/api/cron/nps-prompt-dispatch');
    expect(vercelJson).toContain('*/15 * * * *');
  });
});
