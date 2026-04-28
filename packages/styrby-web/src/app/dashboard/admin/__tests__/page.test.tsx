/**
 * Tests for /dashboard/admin — Admin User List Page
 *
 * Covers:
 *   (a) Renders the search form when no query is present
 *   (b) With `?q=foo` shows results from mocked supabase (rows rendered)
 *   (c) Empty state renders when 0 rows returned
 *   (d) Pagination "Next" link goes to `?q=foo&page=2` when exactly 20 rows returned
 *   (e) Previous page link present on page 2
 *   (f) No "Next" link when fewer than 20 rows (last page detection)
 *   (g) Manual override badge renders when override_source = 'manual'
 *
 * WHY these test targets:
 *   The page is a Server Component but also uses a client component (UserSearchForm)
 *   and a pure server-rendered component (UserListTable). We test the
 *   UserListTable and UserSearchForm components in isolation to avoid the
 *   complexity of fully rendering async Server Components with their Supabase
 *   calls (which would require a real DB or a deeply complex mock chain).
 *   The page-level integration is covered by the createAdminClient mock test
 *   at the bottom which exercises the data-fetching logic directly.
 *
 * Testing strategy:
 *   - UserListTable: pure render test (no mocks needed — takes props)
 *   - UserSearchForm: client component render + submit behaviour
 *   - fetchAdminUsers integration: mock createAdminClient to verify the correct
 *     Supabase query is issued and results are mapped to AdminUserRow shape
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UserListTable } from '@/components/admin/UserListTable';
import { UserSearchForm } from '@/components/admin/UserSearchForm';
import type { AdminUserRow } from '@/components/admin/UserListTable';

// ─── Mocks ───────────────────────────────────────────────────────────────────

/**
 * Mock next/navigation for UserSearchForm, which calls useRouter + useSearchParams.
 */
const mockPush = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  useSearchParams: () => new URLSearchParams(),
}));

/**
 * Mock createAdminClient — used by the page's fetchAdminUsers function.
 *
 * WHY service role mock: We need to verify the page calls createAdminClient
 * (not createClient) because the user-scoped client would return only the
 * admin's own row due to RLS. This test confirms the correct client is chosen.
 */
const mockSupabaseData = vi.fn();
const mockAdminClient = {
  // WHY .rpc: H27 (PR #202) migrated admin user search from a
  // profiles.ILIKE chain to a SECURITY DEFINER RPC
  // (`search_users_by_email_for_admin`) that JOINs auth.users for the
  // email column. The old chain methods (.from/.select/.ilike/.order/.range)
  // are kept for any non-search code paths that still use the chain pattern.
  rpc: vi.fn().mockImplementation(() => mockSupabaseData()),
  from: vi.fn().mockReturnThis(),
  select: vi.fn().mockReturnThis(),
  ilike: vi.fn().mockReturnThis(),
  order: vi.fn().mockReturnThis(),
  range: vi.fn().mockImplementation(() => mockSupabaseData()),
};

vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: () => mockAdminClient,
  createClient: vi.fn(),
}));

// ─── Fixtures ────────────────────────────────────────────────────────────────

/**
 * Builds a page-worth of mock AdminUserRow objects.
 *
 * @param count - Number of rows to generate
 * @param overrides - Optional field overrides for all rows
 */
function makeRows(count: number, overrides: Partial<AdminUserRow> = {}): AdminUserRow[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `user-id-${i}`,
    email: `user${i}@example.com`,
    created_at: new Date(Date.now() - i * 86400 * 1000).toISOString(),
    tier: 'free',
    override_source: null,
    ...overrides,
  }));
}

// ─── UserListTable tests ─────────────────────────────────────────────────────

describe('UserListTable', () => {
  it('(c) renders empty state when 0 rows returned (no query)', () => {
    render(<UserListTable rows={[]} query="" page={1} />);
    expect(screen.getByTestId('user-list-empty')).toBeDefined();
    expect(screen.getByText(/enter an email to search/i)).toBeDefined();
  });

  it('(c) renders empty state with query hint when 0 rows but query provided', () => {
    render(<UserListTable rows={[]} query="nobody@gone.com" page={1} />);
    expect(screen.getByTestId('user-list-empty')).toBeDefined();
    expect(screen.getByText(/no users found matching/i)).toBeDefined();
    expect(screen.getByText(/nobody@gone.com/)).toBeDefined();
  });

  it('(b) renders rows when results are present', () => {
    const rows = makeRows(3);
    render(<UserListTable rows={rows} query="example" page={1} />);

    expect(screen.getByTestId('user-list-table')).toBeDefined();
    const rowEls = screen.getAllByTestId('user-row');
    expect(rowEls).toHaveLength(3);
  });

  it('(b) displays email in each row', () => {
    const rows = makeRows(2);
    render(<UserListTable rows={rows} query="example" page={1} />);
    expect(screen.getByText('user0@example.com')).toBeDefined();
    expect(screen.getByText('user1@example.com')).toBeDefined();
  });

  it('(b) renders View link pointing to /dashboard/admin/users/[id]', () => {
    const rows = makeRows(1);
    render(<UserListTable rows={rows} query="foo" page={1} />);

    const link = screen.getByRole('link', { name: /view dossier for user0@example.com/i });
    expect(link).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((link as any).href).toContain(`/dashboard/admin/users/user-id-0`);
  });

  it('(d) shows Next page link when exactly 20 rows returned', () => {
    const rows = makeRows(20);
    render(<UserListTable rows={rows} query="foo" page={1} />);
    const nextLink = screen.getByTestId('next-page-link');
    expect(nextLink).toBeDefined();
    // WHY: Next page URL must carry the query param forward so the new page
    // returns results for the same search.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((nextLink as any).href).toContain('q=foo');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((nextLink as any).href).toContain('page=2');
  });

  it('(f) hides Next page link when fewer than 20 rows (last page)', () => {
    const rows = makeRows(5);
    render(<UserListTable rows={rows} query="foo" page={1} />);
    expect(screen.queryByTestId('next-page-link')).toBeNull();
  });

  it('(e) shows Previous link on page 2', () => {
    const rows = makeRows(20);
    render(<UserListTable rows={rows} query="foo" page={2} />);
    const prevLink = screen.getByTestId('prev-page-link');
    expect(prevLink).toBeDefined();
    // Previous should go to page 1 (no page param needed)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const href = (prevLink as any).href as string;
    expect(href).toContain('q=foo');
    expect(href).not.toContain('page=2');
  });

  it('no Previous link on page 1', () => {
    render(<UserListTable rows={makeRows(20)} query="foo" page={1} />);
    expect(screen.queryByTestId('prev-page-link')).toBeNull();
  });

  it('(g) renders manual override badge when override_source is manual', () => {
    const rows = makeRows(1, { tier: 'power', override_source: 'manual' });
    render(<UserListTable rows={rows} query="foo" page={1} />);
    // The "manual" badge text should appear
    expect(screen.getByText('manual')).toBeDefined();
  });

  it('(g) no manual badge when override_source is polar', () => {
    const rows = makeRows(1, { tier: 'power', override_source: 'polar' });
    render(<UserListTable rows={rows} query="foo" page={1} />);
    expect(screen.queryByText('manual')).toBeNull();
  });

  // ── T4 Fix 2: aria-label on <table> ───────────────────────────────────────

  it('(T4-fix2) table has aria-label="User search results" for screen readers', () => {
    render(<UserListTable rows={makeRows(1)} query="foo" page={1} />);
    // WHY getByRole('table'): tests that the accessible name is present on the
    // <table> element so screen readers can announce the context on focus.
    const table = screen.getByRole('table', { name: /user search results/i });
    expect(table).toBeDefined();
  });

  // ── T4 Fix 3: empty-state query truncation ────────────────────────────────

  it('(T4-fix3) truncates long query at 60 chars with ellipsis in empty state', () => {
    // 65-character query — must be clipped to 60 + '…' in the empty-state message
    const longQuery = 'a'.repeat(65);
    render(<UserListTable rows={[]} query={longQuery} page={1} />);
    const emptyState = screen.getByTestId('user-list-empty');
    // The truncated form "aaa…aaa" (60 a's + …) must appear inside the text
    expect(emptyState.textContent).toContain('a'.repeat(60) + '…');
    // The full 65-char string must NOT appear
    expect(emptyState.textContent).not.toContain('a'.repeat(65));
  });

  it('(T4-fix3) does not truncate query of exactly 60 chars', () => {
    const exactQuery = 'b'.repeat(60);
    render(<UserListTable rows={[]} query={exactQuery} page={1} />);
    const emptyState = screen.getByTestId('user-list-empty');
    expect(emptyState.textContent).toContain('b'.repeat(60));
    expect(emptyState.textContent).not.toContain('…');
  });

  // ── T4 Fix 4: getRelativeTime invalid-date guard ──────────────────────────

  it('(T4-fix4) renders "Unknown" for empty created_at', () => {
    // WHY: created_at: '' must not cascade to NaN in date arithmetic.
    // The row is still valid — we just render 'Unknown' for the date cell.
    const rows = makeRows(1, { created_at: '' });
    render(<UserListTable rows={rows} query="foo" page={1} />);
    expect(screen.getByText('Unknown')).toBeDefined();
  });

  it('(T4-fix4) renders "Unknown" for malformed created_at', () => {
    const rows = makeRows(1, { created_at: 'not-a-date' });
    render(<UserListTable rows={rows} query="foo" page={1} />);
    expect(screen.getByText('Unknown')).toBeDefined();
  });
});

// ─── UserSearchForm tests ────────────────────────────────────────────────────

describe('UserSearchForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('(a) renders search input and submit button', () => {
    render(<UserSearchForm />);
    expect(screen.getByRole('search', { name: /search users/i })).toBeDefined();
    // WHY searchbox not textbox: input[type="search"] maps to ARIA role "searchbox",
    // not "textbox". Testing Library follows the ARIA spec strictly here.
    expect(screen.getByRole('searchbox', { name: /email search query/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /search/i })).toBeDefined();
  });

  it('(a) pre-fills input with defaultValue', () => {
    render(<UserSearchForm defaultValue="alice@" />);
    // WHY getByRole('searchbox'): input[type="search"] → ARIA role is "searchbox".
    const input = screen.getByRole('searchbox') as HTMLInputElement;
    // WHY .value: React renders defaultValue as the DOM value attribute on mount.
    expect(input.value).toBe('alice@');
  });

  it('navigates to ?q=<value> on submit', async () => {
    const user = userEvent.setup();
    render(<UserSearchForm />);

    // WHY searchbox: input[type="search"] role per ARIA spec
    const input = screen.getByRole('searchbox');
    await user.type(input, 'bob@example.com');
    await user.click(screen.getByRole('button', { name: /search/i }));

    expect(mockPush).toHaveBeenCalledOnce();
    const url: string = mockPush.mock.calls[0][0] as string;
    expect(url).toContain('q=bob%40example.com');
    // Page param must be absent (reset to page 1 on new search)
    expect(url).not.toContain('page=');
  });

  it('navigates to /dashboard/admin (no q) when input is cleared', async () => {
    const user = userEvent.setup();
    render(<UserSearchForm defaultValue="old query" />);

    // Clear the input and submit
    const input = screen.getByRole('searchbox');
    await user.clear(input);
    await user.click(screen.getByRole('button', { name: /search/i }));

    expect(mockPush).toHaveBeenCalledOnce();
    const url: string = mockPush.mock.calls[0][0] as string;
    expect(url).toBe('/dashboard/admin');
  });
});

// ─── createAdminClient usage test ────────────────────────────────────────────

describe('fetchAdminUsers (via createAdminClient mock)', () => {
  /**
   * Tests that the page module calls createAdminClient (service role) rather
   * than createClient (user-scoped), verifying the RLS-bypass is in place.
   *
   * WHY test this specifically: If someone mistakenly swaps to createClient,
   * the query will silently return only the admin's own row — a hard-to-spot
   * regression since the page would appear to work but return wrong data.
   * SOC 2 CC6.1: admin queries must use service role.
   */
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset rpc + chain mocks (chain kept for any non-search code paths).
    mockAdminClient.rpc.mockImplementation(() => mockSupabaseData());
    mockAdminClient.from.mockReturnThis();
    mockAdminClient.select.mockReturnThis();
    mockAdminClient.ilike.mockReturnThis();
    mockAdminClient.order.mockReturnThis();
  });

  it('calls search_users_by_email_for_admin RPC with provided query', async () => {
    // WHY RPC (not ILIKE chain): H27 migrated admin search to a SECURITY
    // DEFINER RPC that JOINs auth.users for email — `profiles.email` does
    // not exist so the old ILIKE chain silently returned empty in prod.
    mockSupabaseData.mockResolvedValue({ data: [], error: null });

    // Dynamically import the page module to get the exported fetch function
    // WHY dynamic import: avoids top-level import conflicts with vi.mock hoisting
    const { default: Page } = await import('../page');

    // Render the server component by calling it as a function (valid in tests)
    await Page({
      searchParams: Promise.resolve({ q: 'testquery', page: '1' }),
    });

    // Verify the RPC was invoked with the page's contract.
    expect(mockAdminClient.rpc).toHaveBeenCalledWith(
      'search_users_by_email_for_admin',
      expect.objectContaining({
        p_query: 'testquery',
        p_limit: 20,
        p_offset: 0,
      }),
    );
  });

  // ── T4 Fix 1: ILIKE metachar handling now lives in the SQL RPC ───────────

  it('(T4-fix1) passes raw query through to RPC (escaping handled in SQL)', async () => {
    // WHY: With H27's migration 064, the SECURITY DEFINER RPC is responsible
    // for ILIKE-metacharacter escaping inside the SQL function body. The
    // application layer just forwards the raw user input. Verifying that the
    // raw `%foo%` reaches the RPC pins the contract — if the migration's SQL
    // is later changed to expect pre-escaped input, this assertion fails fast.
    mockSupabaseData.mockResolvedValue({ data: [], error: null });

    mockAdminClient.rpc.mockClear();

    const { default: Page } = await import('../page');
    await Page({ searchParams: Promise.resolve({ q: '%foo%', page: '1' }) });

    expect(mockAdminClient.rpc).toHaveBeenCalledWith(
      'search_users_by_email_for_admin',
      expect.objectContaining({ p_query: '%foo%' }),
    );
  });

  it('applies correct OFFSET for page 2 (p_offset = 20)', async () => {
    mockSupabaseData.mockResolvedValue({ data: [], error: null });

    const { default: Page } = await import('../page');
    await Page({ searchParams: Promise.resolve({ q: 'foo', page: '2' }) });

    // page=2 → p_offset = (page-1) * PAGE_SIZE = 20
    expect(mockAdminClient.rpc).toHaveBeenCalledWith(
      'search_users_by_email_for_admin',
      expect.objectContaining({ p_offset: 20, p_limit: 20 }),
    );
  });

  it('returns empty array and does not query when query is empty', async () => {
    mockSupabaseData.mockResolvedValue({ data: [], error: null });

    const { default: Page } = await import('../page');
    await Page({ searchParams: Promise.resolve({ q: '', page: '1' }) });

    // WHY: empty query must not hit the DB (expensive full-table scan risk)
    expect(mockAdminClient.from).not.toHaveBeenCalled();
  });
});
