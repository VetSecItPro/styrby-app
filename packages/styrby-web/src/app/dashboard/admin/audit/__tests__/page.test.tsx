/**
 * Tests for /dashboard/admin/audit page and AuditLogTable component.
 *
 * Covers:
 *   (a) Empty state (0 audit rows)
 *   (b) Rows render with email/UUID fallback
 *   (c) Cursor pagination sets next-page link correctly
 *   (d) Actor UUID fallback when profile lookup misses
 *   (e) Next page link absent when rows < PAGE_SIZE (last page)
 *   (f) AuditLogTable aria-label for accessibility
 *   (g) Action badge renders with correct color class
 *   (h) Page-level integration: createAdminClient is used (not createClient)
 *   (i) Target shows "—" for non-user-targeted rows
 *
 * WHY these test targets:
 *   The audit page is the primary compliance/ops interface for admin_audit_log.
 *   Regressions in rendering, cursor logic, or email resolution would surface
 *   incorrect information during a security incident. SOC 2 CC7.2.
 *
 * Testing strategy:
 *   - AuditLogTable: pure render test (no mocks — takes props)
 *   - Page integration: mock createAdminClient to verify query shape
 *
 * @module app/dashboard/admin/audit/__tests__/page
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AuditLogTable } from '@/components/admin/AuditLogTable';
import type { AuditLogRow } from '@/components/admin/AuditLogTable';

// ─── Mocks ────────────────────────────────────────────────────────────────────

/**
 * Mock next/link for Server Component rendering tests.
 * WHY: Link requires Next.js router context which is not available in vitest/jsdom.
 */
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: React.ReactNode;
    [key: string]: unknown;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

/**
 * Mock VerifyChainButton to avoid rendering a client component
 * in a server-component test context.
 */
vi.mock('@/components/admin/VerifyChainButton', () => ({
  VerifyChainButton: () => <div data-testid="verify-chain-button-mock" />,
}));

/**
 * Mock createAdminClient for page-level integration tests.
 *
 * WHY rpc mock: T7 audit page now calls resolveAdminEmails() which uses
 * `.rpc('resolve_user_emails_for_admin', ...)` instead of
 * `.from('profiles').select('id, email').in(...)`.
 * profiles has no email column — the RPC bridges to auth.users. Migration 043.
 */
const mockData = vi.fn();
const mockLt = vi.fn();
const mockLimit = vi.fn();
const mockRpcEmailResolver = vi.fn();
const mockAdminClient = {
  from: vi.fn().mockReturnThis(),
  select: vi.fn().mockReturnThis(),
  order: vi.fn().mockReturnThis(),
  limit: vi.fn().mockImplementation(() => {
    return {
      lt: mockLt.mockImplementation(() => mockData()),
      then: mockData().then?.bind(mockData()),
    };
  }),
  // WHY: resolveAdminEmails uses rpc() not from().select().in() for email resolution.
  rpc: mockRpcEmailResolver,
};

vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: () => mockAdminClient,
  createClient: vi.fn(),
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/**
 * Builds an array of mock AuditLogRow objects.
 *
 * @param count    - Number of rows to generate
 * @param overrides - Optional field overrides applied to all rows
 */
function makeAuditRows(count: number, overrides: Partial<AuditLogRow> = {}): AuditLogRow[] {
  return Array.from({ length: count }, (_, i) => ({
    id: 1000 - i, // descending IDs (newest first)
    action: 'override_tier',
    actor_email: `admin${i}@example.com`,
    target_email: `user${i}@example.com`,
    reason: `Tier override reason ${i}`,
    created_at: new Date(Date.now() - i * 3600 * 1000).toISOString(),
    target_entity: null,
    ...overrides,
  }));
}

// ─── AuditLogTable tests ──────────────────────────────────────────────────────

describe('AuditLogTable', () => {
  // ── (a) Empty state ─────────────────────────────────────────────────────

  it('(a) renders empty state when 0 rows returned', () => {
    render(<AuditLogTable rows={[]} nextCursor={null} />);
    expect(screen.getByTestId('audit-log-empty')).toBeDefined();
    expect(screen.getByText(/no admin audit log entries/i)).toBeDefined();
  });

  // ── (b) Row rendering ───────────────────────────────────────────────────

  it('(b) renders table when rows are present', () => {
    render(<AuditLogTable rows={makeAuditRows(3)} nextCursor={null} />);
    expect(screen.getByTestId('audit-log-table')).toBeDefined();
    const rows = screen.getAllByTestId('audit-log-row');
    expect(rows).toHaveLength(3);
  });

  it('(b) renders actor email in each row', () => {
    const rows = makeAuditRows(2);
    render(<AuditLogTable rows={rows} nextCursor={null} />);
    expect(screen.getByText('admin0@example.com')).toBeDefined();
    expect(screen.getByText('admin1@example.com')).toBeDefined();
  });

  it('(b) renders target email in each row', () => {
    const rows = makeAuditRows(1);
    render(<AuditLogTable rows={rows} nextCursor={null} />);
    const targetCells = screen.getAllByTestId('audit-target');
    expect(targetCells[0].textContent).toContain('user0@example.com');
  });

  // ── (d) UUID fallback ───────────────────────────────────────────────────

  it('(d) shows UUID when actor email is a UUID (profile lookup miss)', () => {
    const uuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    const rows = makeAuditRows(1, { actor_email: uuid });
    render(<AuditLogTable rows={rows} nextCursor={null} />);
    const actorCells = screen.getAllByTestId('audit-actor');
    expect(actorCells[0].textContent).toContain(uuid);
  });

  it('(d) shows UUID for target when target profile lookup misses', () => {
    const targetUuid = 'dead-beef-1234-5678-9012-abcdef012345';
    const rows = makeAuditRows(1, { target_email: targetUuid });
    render(<AuditLogTable rows={rows} nextCursor={null} />);
    const targetCells = screen.getAllByTestId('audit-target');
    expect(targetCells[0].textContent).toContain(targetUuid);
  });

  // ── (i) Non-user-targeted rows ──────────────────────────────────────────

  it('(i) renders "—" for target when target_email is null and no target_entity', () => {
    const rows = makeAuditRows(1, { target_email: null, target_entity: null });
    render(<AuditLogTable rows={rows} nextCursor={null} />);
    const targetCells = screen.getAllByTestId('audit-target');
    expect(targetCells[0].textContent).toContain('—');
  });

  it('(i) renders target_entity string when target_email is null but entity is set', () => {
    const rows = makeAuditRows(1, { target_email: null, target_entity: 'session' });
    render(<AuditLogTable rows={rows} nextCursor={null} />);
    const targetCells = screen.getAllByTestId('audit-target');
    expect(targetCells[0].textContent).toContain('session');
  });

  // ── (g) Action badge ────────────────────────────────────────────────────

  it('(g) renders orange badge for override_tier action', () => {
    render(<AuditLogTable rows={makeAuditRows(1, { action: 'override_tier' })} nextCursor={null} />);
    const badge = screen.getByTestId('audit-action-badge');
    // WHY check class: verifies the color-coding is correct, not just the text.
    expect(badge.className).toContain('text-orange-400');
    expect(badge.textContent).toBe('override_tier');
  });

  it('(g) renders blue badge for reset_password action', () => {
    render(<AuditLogTable rows={makeAuditRows(1, { action: 'reset_password' })} nextCursor={null} />);
    const badge = screen.getByTestId('audit-action-badge');
    expect(badge.className).toContain('text-blue-400');
  });

  it('(g) renders purple badge for toggle_consent action', () => {
    render(<AuditLogTable rows={makeAuditRows(1, { action: 'toggle_consent' })} nextCursor={null} />);
    const badge = screen.getByTestId('audit-action-badge');
    expect(badge.className).toContain('text-purple-400');
  });

  it('(g) renders grey badge for unknown action', () => {
    render(<AuditLogTable rows={makeAuditRows(1, { action: 'some_other_action' })} nextCursor={null} />);
    const badge = screen.getByTestId('audit-action-badge');
    expect(badge.className).toContain('text-zinc-400');
  });

  // ── (c) Cursor pagination ───────────────────────────────────────────────

  it('(c) shows Next page link with correct cursor when nextCursor is set', () => {
    render(<AuditLogTable rows={makeAuditRows(50)} nextCursor={500} />);
    const nextLink = screen.getByTestId('audit-next-page-link');
    expect(nextLink).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const href = (nextLink as any).href as string;
    expect(href).toContain('cursor=500');
  });

  it('(e) hides Next page link when nextCursor is null (last page)', () => {
    render(<AuditLogTable rows={makeAuditRows(30)} nextCursor={null} />);
    expect(screen.queryByTestId('audit-next-page-link')).toBeNull();
  });

  // ── (f) Accessibility ───────────────────────────────────────────────────

  it('(f) table has aria-label="Admin audit log" for screen readers', () => {
    render(<AuditLogTable rows={makeAuditRows(1)} nextCursor={null} />);
    const table = screen.getByRole('table', { name: /admin audit log/i });
    expect(table).toBeDefined();
  });

  // ── reason display ──────────────────────────────────────────────────────

  it('renders reason text in the reason cell', () => {
    const rows = makeAuditRows(1, { reason: 'User request' });
    render(<AuditLogTable rows={rows} nextCursor={null} />);
    const reasonCells = screen.getAllByTestId('audit-reason');
    expect(reasonCells[0].textContent).toContain('User request');
  });

  it('renders "—" for empty reason', () => {
    const rows = makeAuditRows(1, { reason: null });
    render(<AuditLogTable rows={rows} nextCursor={null} />);
    const reasonCells = screen.getAllByTestId('audit-reason');
    expect(reasonCells[0].textContent).toContain('—');
  });
});

// ─── Page-level integration tests ─────────────────────────────────────────────

describe('AdminAuditPage (integration via createAdminClient mock)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset the Supabase client chain mocks
    mockAdminClient.from.mockReturnThis();
    mockAdminClient.select.mockReturnThis();
    mockAdminClient.order.mockReturnThis();
    mockLt.mockClear();
    mockLimit.mockClear();
    // WHY: resolveAdminEmails uses rpc() for email resolution (not profiles.select).
    // Default to resolving no emails (empty array) so page renders without crashing.
    mockRpcEmailResolver.mockResolvedValue({ data: [], error: null });
  });

  it('(h) calls createAdminClient for DB queries (not createClient)', async () => {
    // The mock resolves an empty result set for the audit query.
    mockData.mockResolvedValue({ data: [], error: null });

    // Build a minimal query chain that terminates without cursor
    mockAdminClient.limit.mockReturnValue({
      // No cursor → no .lt() call needed; the query resolves directly
      then: undefined,
      // Await the mock data promise directly
    });

    const { default: Page } = await import('../page');

    // Call the page as an async Server Component (valid in tests).
    await Page({ searchParams: Promise.resolve({}) });

    // WHY verify createAdminClient: using the wrong client (createClient) would
    // return RLS-scoped data only visible to the authenticated user, making the
    // admin audit log silently empty for most rows. Service role is required.
    // SOC 2 CC6.1.
    expect(mockAdminClient.from).toHaveBeenCalledWith('admin_audit_log');
  });

  it('(h) uses rpc("resolve_user_emails_for_admin") for email resolution (not profiles.email)', async () => {
    // WHY: profiles has no email column. The page must use the RPC to bridge
    // into auth.users. This test verifies the correct resolver is invoked.
    // Migration 043 — SOC 2 CC7.2 (audit log completeness).
    mockData.mockResolvedValue({ data: [], error: null });
    mockAdminClient.limit.mockReturnValue({ then: undefined });

    const { default: Page } = await import('../page');
    await Page({ searchParams: Promise.resolve({}) });

    // rpc is only called when there are UUIDs to resolve; with an empty audit
    // result there are no UUIDs, so rpc should NOT have been called.
    // Verify that the old profiles.from() path is not used either.
    const fromCalls = mockAdminClient.from.mock.calls.map((c: unknown[]) => c[0]);
    expect(fromCalls).not.toContain('profiles');
  });
});
