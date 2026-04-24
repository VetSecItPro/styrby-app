/**
 * Tests for RecentAuditCard server component.
 *
 * Covers:
 *   (a) Empty state: no audit rows returns empty-state text
 *   (b) Rows render: audit rows display action, actor email, reason, timestamp
 *   (c) Email resolver: uses rpc('resolve_user_emails_for_admin') NOT profiles.email
 *   (d) UUID fallback: unknown actor IDs show UUID not crash
 *   (e) Audit query error: renders error card, not empty state
 *   (f) Email resolver error: falls back to UUIDs gracefully (non-fatal)
 *
 * WHY these tests:
 *   RecentAuditCard had a production bug where it queried `profiles.email`
 *   (which does not exist). Tests previously passed because they mocked the
 *   profiles response with an email field. These tests explicitly verify the
 *   correct resolver path (RPC) and that the UUID fallback works when
 *   email resolution fails. SOC 2 CC7.2 (audit log completeness).
 *
 * Testing strategy:
 *   Mock createAdminClient and resolveAdminEmails at the module boundary.
 *   Call RecentAuditCard as an async function (Next.js Server Component
 *   pattern in vitest/jsdom). Render with @testing-library/react.
 *
 * @module components/admin/dossier/__tests__/RecentAuditCard
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { render, screen } from '@testing-library/react';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: vi.fn(),
}));

/**
 * Mock resolveAdminEmails to avoid the actual RPC call in tests.
 * WHY: The RPC requires a service-role Supabase client with DB access.
 * Mocking at the module boundary isolates the component from infrastructure.
 */
vi.mock('@/lib/admin/resolveEmails', () => ({
  resolveAdminEmails: vi.fn(),
}));

import { createAdminClient } from '@/lib/supabase/server';
import { resolveAdminEmails } from '@/lib/admin/resolveEmails';
import { RecentAuditCard } from '../RecentAuditCard';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** A minimal audit log row shape returned by the DB query. */
interface RawAuditRow {
  id: number;
  action: string;
  actor_id: string;
  reason: string | null;
  created_at: string;
}

/**
 * Builds mock raw audit rows (as returned by the Supabase query, before
 * email resolution). These are NOT the same as display rows.
 */
function makeRawRows(count: number, overrides: Partial<RawAuditRow> = {}): RawAuditRow[] {
  return Array.from({ length: count }, (_, i) => ({
    id: 1000 - i,
    action: 'override_tier',
    actor_id: `actor-uuid-${i}`,
    reason: `Reason ${i}`,
    created_at: new Date(Date.now() - i * 3600 * 1000).toISOString(),
    ...overrides,
  }));
}

/**
 * Configures the createAdminClient mock for a RecentAuditCard render.
 *
 * @param rows  - Rows returned by the audit log query (or null to simulate error)
 * @param error - Error object returned by the query (null = success)
 */
function mockAuditQuery(rows: RawAuditRow[] | null, error: { message: string } | null = null) {
  (createAdminClient as Mock).mockReturnValue({
    from: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue({ data: rows, error }),
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('RecentAuditCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // WHY default email resolver mock: resolves no emails (empty map).
    // Individual tests override this when they need email resolution.
    (resolveAdminEmails as Mock).mockResolvedValue({});
  });

  // ── (a) Empty state ──────────────────────────────────────────────────────

  it('(a) renders empty state when no audit rows for the user', async () => {
    mockAuditQuery([]);

    const jsx = await RecentAuditCard({ userId: 'user-123' });
    render(jsx);

    expect(screen.getByTestId('no-audit-rows')).toBeDefined();
    expect(screen.getByText(/no admin actions recorded/i)).toBeDefined();
  });

  // ── (b) Row rendering ────────────────────────────────────────────────────

  it('(b) renders audit rows with resolved email', async () => {
    const rows = makeRawRows(2);
    mockAuditQuery(rows);
    (resolveAdminEmails as Mock).mockResolvedValue({
      'actor-uuid-0': 'admin0@example.com',
      'actor-uuid-1': 'admin1@example.com',
    });

    const jsx = await RecentAuditCard({ userId: 'user-123' });
    render(jsx);

    expect(screen.getByTestId('recent-audit-card')).toBeDefined();
    const auditRows = screen.getAllByTestId('audit-row');
    expect(auditRows).toHaveLength(2);

    const actorCells = screen.getAllByTestId('audit-actor');
    expect(actorCells[0].textContent).toContain('admin0@example.com');
    expect(actorCells[1].textContent).toContain('admin1@example.com');
  });

  it('(b) renders reason and action badge in rows', async () => {
    const rows = makeRawRows(1, { action: 'reset_password', reason: 'User request' });
    mockAuditQuery(rows);
    (resolveAdminEmails as Mock).mockResolvedValue({ 'actor-uuid-0': 'admin@example.com' });

    const jsx = await RecentAuditCard({ userId: 'user-123' });
    render(jsx);

    const reasonCell = screen.getByTestId('audit-reason');
    expect(reasonCell.textContent).toContain('User request');

    const actionBadge = screen.getByTestId('audit-action');
    expect(actionBadge.textContent).toBe('reset_password');
  });

  // ── (c) Email resolver uses RPC, NOT profiles.email ─────────────────────

  it('(c) calls resolveAdminEmails (RPC-based), never queries profiles.email', async () => {
    const rows = makeRawRows(3);
    mockAuditQuery(rows);
    (resolveAdminEmails as Mock).mockResolvedValue({
      'actor-uuid-0': 'admin0@example.com',
      'actor-uuid-1': 'admin1@example.com',
      'actor-uuid-2': 'admin2@example.com',
    });

    await RecentAuditCard({ userId: 'user-123' });

    // WHY verify resolveAdminEmails was called: this is the test that guards
    // against the regression. The old code called `from('profiles').select('email')`.
    // If someone reverts to the old path, this test fails.
    expect(resolveAdminEmails).toHaveBeenCalledOnce();

    // Verify the IDs passed to the resolver are the unique actor IDs from the rows.
    const [, passedIds] = (resolveAdminEmails as Mock).mock.calls[0] as [unknown, string[]];
    expect(passedIds).toContain('actor-uuid-0');
    expect(passedIds).toContain('actor-uuid-1');
    expect(passedIds).toContain('actor-uuid-2');

    // WHY check from() calls: from('profiles') must never be called for email
    // resolution. profiles has no email column. SOC 2 CC7.2 regression guard.
    const fromCalls = ((createAdminClient as Mock).mock.results[0]?.value as { from: Mock }).from.mock.calls.map(
      (c: unknown[]) => c[0],
    );
    expect(fromCalls).not.toContain('profiles');
  });

  it('(c) does not call resolveAdminEmails when there are no rows', async () => {
    mockAuditQuery([]);

    await RecentAuditCard({ userId: 'user-123' });

    // WHY: An empty audit result has no actor IDs to resolve. The resolver
    // should not be called with an empty array (wastes a round-trip). The
    // resolveAdminEmails helper itself has a guard, but the component should
    // also short-circuit. This verifies that behavior.
    expect(resolveAdminEmails).not.toHaveBeenCalled();
  });

  // ── (d) UUID fallback ────────────────────────────────────────────────────

  it('(d) falls back to actor UUID when email resolution returns empty map', async () => {
    const actorUuid = 'dead-beef-1234-5678-9012-abcdef012345';
    const rows = makeRawRows(1, { actor_id: actorUuid });
    mockAuditQuery(rows);
    (resolveAdminEmails as Mock).mockResolvedValue({}); // no emails resolved

    const jsx = await RecentAuditCard({ userId: 'user-123' });
    render(jsx);

    const actorCell = screen.getByTestId('audit-actor');
    // WHY UUID fallback: deleted admin accounts or bootstrap admins have no
    // resolvable email. UUID is still actionable for ops. SOC 2 CC7.2.
    expect(actorCell.textContent).toContain(actorUuid);
  });

  // ── (e) Audit query error ────────────────────────────────────────────────

  it('(e) renders error card when audit log query fails', async () => {
    mockAuditQuery(null, { message: 'relation "admin_audit_log" does not exist' });

    const jsx = await RecentAuditCard({ userId: 'user-123' });
    render(jsx);

    // WHY error card: ops must be able to distinguish DB failure from empty log.
    // SOC 2 CC7.2: audit log availability is security-relevant.
    expect(screen.getByTestId('recent-audit-card-error')).toBeDefined();
    expect(screen.getByText(/failed to load audit log/i)).toBeDefined();
  });

  // ── (f) Email resolver error ─────────────────────────────────────────────

  it('(f) renders rows with UUID fallback when email resolver fails', async () => {
    const rows = makeRawRows(1, { actor_id: 'my-uuid-actor' });
    mockAuditQuery(rows);
    // Simulate resolver returning empty (as it does on RPC error internally).
    (resolveAdminEmails as Mock).mockResolvedValue({});

    const jsx = await RecentAuditCard({ userId: 'user-123' });
    render(jsx);

    // WHY: email resolver failure is non-fatal. Page should still render
    // with UUID fallbacks. The resolver logs internally; we just verify
    // the page does not crash and shows the UUID.
    expect(screen.getByTestId('recent-audit-card')).toBeDefined();
    const actorCells = screen.getAllByTestId('audit-actor');
    expect(actorCells[0].textContent).toContain('my-uuid-actor');
  });

  // ── deduplication ──────────────────────────────────────────────────────

  it('deduplicates actor IDs before calling resolveAdminEmails', async () => {
    // Same actor appears in all 3 rows — should only be resolved once.
    const rows = makeRawRows(3, { actor_id: 'same-admin-uuid' });
    mockAuditQuery(rows);
    (resolveAdminEmails as Mock).mockResolvedValue({ 'same-admin-uuid': 'admin@example.com' });

    await RecentAuditCard({ userId: 'user-123' });

    const [, passedIds] = (resolveAdminEmails as Mock).mock.calls[0] as [unknown, string[]];
    // WHY: de-duplication avoids resolving the same UUID multiple times.
    // Batch resolver pattern: 1 query for N unique IDs regardless of row count.
    expect(passedIds).toHaveLength(1);
    expect(passedIds[0]).toBe('same-admin-uuid');
  });
});
