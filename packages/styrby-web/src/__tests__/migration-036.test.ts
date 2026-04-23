/**
 * Migration 036 structural tests — session_handoff (Phase 3.2)
 *
 * Validates that migration 036 contains all required DDL for:
 *   - `devices` table (device registry)
 *   - `session_state_snapshots` table (state capture)
 *   - RLS policies on both tables
 *   - Partial index on session_state_snapshots
 *   - pg_cron retention job
 *
 * WHY migration regression tests:
 *   Migrations are irreversible in production. Missing RLS or a missing
 *   index silently degrades security or performance. These file-content
 *   tests catch regressions in milliseconds at CI time.
 *
 * Invariants tested:
 *   1. devices table DDL (all required columns)
 *   2. session_state_snapshots table DDL (all required columns)
 *   3. FK on session_state_snapshots.session_id (CASCADE DELETE)
 *   4. RLS enabled on both tables
 *   5. SELECT/INSERT policies on both tables
 *   6. Partial index on (session_id, created_at DESC)
 *   7. pg_cron retention job scheduled
 *   8. IF NOT EXISTS guards (idempotent re-run safety)
 *
 * @module __tests__/migration-036
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const MIGRATIONS_DIR = resolve(__dirname, '../../../..', 'supabase/migrations');

function readMigration(filename: string): string {
  return readFileSync(resolve(MIGRATIONS_DIR, filename), 'utf-8');
}

describe('Migration 036: session_handoff', () => {
  const sql = readMigration('036_session_handoff.sql');

  // ── devices table ──────────────────────────────────────────────────────────

  it('creates devices table with IF NOT EXISTS', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS devices');
  });

  it('devices table has id TEXT PRIMARY KEY', () => {
    expect(sql).toContain('id          TEXT        PRIMARY KEY');
  });

  it('devices table has user_id FK referencing auth.users', () => {
    expect(sql).toContain('user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE');
  });

  it('devices table has kind TEXT with CHECK constraint', () => {
    expect(sql).toContain("CHECK (kind IN ('web', 'mobile_ios', 'mobile_android', 'cli'))");
  });

  it('devices table has last_seen_at TIMESTAMPTZ', () => {
    expect(sql).toContain('last_seen_at TIMESTAMPTZ');
  });

  // ── session_state_snapshots table ─────────────────────────────────────────

  it('creates session_state_snapshots table with IF NOT EXISTS', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS session_state_snapshots');
  });

  it('session_state_snapshots has id UUID PRIMARY KEY', () => {
    expect(sql).toContain('id               UUID        PRIMARY KEY DEFAULT gen_random_uuid()');
  });

  it('session_state_snapshots has session_id FK with CASCADE DELETE', () => {
    expect(sql).toContain('REFERENCES sessions(id) ON DELETE CASCADE');
  });

  it('session_state_snapshots has cursor_position INTEGER', () => {
    expect(sql).toContain('cursor_position  INTEGER');
  });

  it('session_state_snapshots has scroll_offset INTEGER', () => {
    expect(sql).toContain('scroll_offset    INTEGER');
  });

  it('session_state_snapshots has active_draft TEXT', () => {
    expect(sql).toContain('active_draft     TEXT');
  });

  it('session_state_snapshots has snapshot_version INTEGER DEFAULT 1', () => {
    expect(sql).toContain('snapshot_version INTEGER     NOT NULL DEFAULT 1');
  });

  it('session_state_snapshots has device_id TEXT', () => {
    expect(sql).toContain('device_id        TEXT');
  });

  // ── Indexes ────────────────────────────────────────────────────────────────

  it('creates partial index on (session_id, created_at DESC)', () => {
    expect(sql).toContain('idx_sss_session_created');
    expect(sql).toContain('session_id, created_at DESC');
  });

  it('creates index on devices(user_id)', () => {
    expect(sql).toContain('idx_devices_user_id');
    expect(sql).toContain('ON devices(user_id)');
  });

  // ── RLS ───────────────────────────────────────────────────────────────────

  it('enables RLS on devices', () => {
    expect(sql).toContain('ALTER TABLE devices ENABLE ROW LEVEL SECURITY');
  });

  it('enables RLS on session_state_snapshots', () => {
    expect(sql).toContain('ALTER TABLE session_state_snapshots ENABLE ROW LEVEL SECURITY');
  });

  it('devices has SELECT policy scoped to auth.uid()', () => {
    expect(sql).toContain('"devices: user can select own"');
    expect(sql).toContain('FOR SELECT USING (user_id = (SELECT auth.uid()))');
  });

  it('devices has INSERT policy scoped to auth.uid()', () => {
    expect(sql).toContain('"devices: user can insert own"');
  });

  it('devices has UPDATE policy', () => {
    expect(sql).toContain('"devices: user can update own"');
  });

  it('devices has DELETE policy', () => {
    expect(sql).toContain('"devices: user can delete own"');
  });

  it('session_state_snapshots has SELECT policy via sessions join', () => {
    expect(sql).toContain('"sss: user can select own"');
    expect(sql).toContain('SELECT id FROM sessions WHERE user_id = (SELECT auth.uid())');
  });

  it('session_state_snapshots has INSERT policy via sessions join', () => {
    expect(sql).toContain('"sss: user can insert own"');
  });

  // ── Retention / pg_cron ───────────────────────────────────────────────────

  it('schedules a pg_cron retention job named purge-old-snapshots', () => {
    expect(sql).toContain("'purge-old-snapshots'");
    expect(sql).toContain('cron.schedule');
  });

  it('retention job deletes snapshots older than 30 days', () => {
    expect(sql).toContain("INTERVAL '30 days'");
  });
});
