/**
 * Migration 101 structural tests — consolidate multiple permissive SELECT policies
 *
 * Validates that migration 101 (DB-DEFER-001) collapses the overlapping
 * permissive SELECT policy pairs flagged by the Supabase
 * `multiple_permissive_policies` advisor:
 *   - SHAPE A (4 tables): the `*_select_self` + `*_select_admin` pairs are
 *     dropped and replaced by one `*_select_self_or_admin` policy whose USING
 *     clause is the OR of the two originals (behavior-identical).
 *   - SHAPE B (referral_events): the `service_all` policy is re-scoped
 *     `TO service_role` so it no longer overlaps the authenticated SELECT path
 *     (and no longer implicitly grants public full-table read).
 *   - A self-verifying DO/ASSERT block fails the migration on policy drift.
 *
 * WHY a structural regression test: a future edit that re-introduces a separate
 * self/admin policy, forgets the service_role scoping, or drops the assertion
 * would silently reintroduce the perf overlap (and, for referral_events, a
 * cross-user read). These file-content checks catch that in milliseconds; the
 * live behavior is additionally proven by the Postgres migrations-apply CI job.
 *
 * @module __tests__/migration-101
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const MIGRATIONS_DIR = resolve(__dirname, '../../../..', 'supabase/migrations');

function readMigration(filename: string): string {
  return readFileSync(resolve(MIGRATIONS_DIR, filename), 'utf-8');
}

describe('Migration 101: consolidate permissive SELECT policies', () => {
  const sql = readMigration('101_consolidate_multiple_permissive_select_policies.sql');

  const SHAPE_A = [
    { table: 'consent_flags', merged: 'consent_select_self_or_admin', old: ['consent_select_self', 'consent_select_site_admin'] },
    { table: 'support_access_grants', merged: 'support_access_grants_select_self_or_admin', old: ['support_access_grants_select_self', 'support_access_grants_select_admin'] },
    { table: 'billing_credits', merged: 'billing_credits_select_self_or_admin', old: ['billing_credits_select_self', 'billing_credits_select_admin'] },
    { table: 'churn_save_offers', merged: 'churn_save_offers_select_self_or_admin', old: ['churn_save_offers_select_self', 'churn_save_offers_select_admin'] },
  ];

  // ── SHAPE A: each pair dropped + replaced by a single OR policy ──────────────

  for (const { table, merged, old } of SHAPE_A) {
    it(`${table}: drops both old self/admin SELECT policies`, () => {
      for (const name of old) {
        expect(sql).toContain(`DROP POLICY IF EXISTS ${name} ON public.${table};`);
      }
    });

    it(`${table}: creates one consolidated ${merged} policy`, () => {
      expect(sql).toContain(`CREATE POLICY ${merged}`);
    });

    it(`${table}: consolidated policy is FOR SELECT TO authenticated`, () => {
      // The consolidated policy block must keep the SELECT/authenticated scope.
      const idx = sql.indexOf(`CREATE POLICY ${merged}`);
      expect(idx).toBeGreaterThan(-1);
      const block = sql.slice(idx, idx + 400);
      expect(block).toContain('FOR SELECT');
      expect(block).toContain('TO authenticated');
    });

    it(`${table}: consolidated USING is the OR of self + is_site_admin`, () => {
      const idx = sql.indexOf(`CREATE POLICY ${merged}`);
      const block = sql.slice(idx, idx + 400);
      expect(block).toContain('user_id = (SELECT auth.uid())');
      expect(block).toContain('OR public.is_site_admin((SELECT auth.uid()))');
    });
  }

  // ── SHAPE B: referral_events service policy scoped to service_role ───────────

  it('referral_events: drops + recreates service_all scoped TO service_role', () => {
    expect(sql).toContain('DROP POLICY IF EXISTS referral_events_service_all ON public.referral_events;');
    const idx = sql.indexOf('CREATE POLICY referral_events_service_all');
    expect(idx).toBeGreaterThan(-1);
    const block = sql.slice(idx, idx + 200);
    expect(block).toContain('FOR ALL TO service_role');
    expect(block).toContain('USING (true) WITH CHECK (true)');
  });

  it('referral_events: leaves the owner-scoped referrer_select policy untouched', () => {
    // The migration must NOT drop/recreate the legitimate referrer read path.
    expect(sql).not.toContain('DROP POLICY IF EXISTS referral_events_referrer_select');
    expect(sql).not.toContain('CREATE POLICY referral_events_referrer_select');
  });

  // ── Self-verification block present ─────────────────────────────────────────

  it('ends with a DO/ASSERT block that fails on policy drift', () => {
    expect(sql).toContain('DO $$');
    expect(sql).toContain('RAISE EXCEPTION');
    // Asserts the service policy is scoped to exactly {service_role}.
    expect(sql).toContain("roles = ARRAY['service_role']::name[]");
  });

  it('does not leave any stale *_select_self / *_select_admin CREATE for SHAPE A tables', () => {
    for (const { old } of SHAPE_A) {
      for (const name of old) {
        // Word-boundary match: `_` is a word char, so `consent_select_self\b`
        // does NOT match the merged `consent_select_self_or_admin` (the next
        // char is `_`, no boundary) — only a standalone re-create of the old
        // policy would match.
        expect(sql).not.toMatch(new RegExp(`CREATE POLICY ${name}\\b`));
      }
    }
  });
});
