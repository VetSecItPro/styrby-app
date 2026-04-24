/**
 * Tests for /legal/retention-proof page
 *
 * Coverage:
 *   - Page renders static retention policy table (all data types)
 *   - Table has correct aria-label
 *   - Table has a Status column with enforcement badges
 *   - Enforced rows render a ✅ Enforced badge (data-enforcement="enforced")
 *   - Target rows render a 📋 Target badge (data-enforcement="target")
 *   - Live proof section renders ONLY the sessions count (enforced rules only)
 *   - Live counts section renders when API returns data
 *   - Fallback message renders when API returns null (network error)
 *   - Page heading and GDPR Art. 5(1)(e) reference are present
 *   - Enforcement legend explains ✅ vs 📋
 *
 * WHY: The retention-proof page is a public compliance artifact. If the
 * policy table regresses, we lose GDPR documentation; if the fallback
 * breaks, users see a crashed page instead of a graceful degradation.
 * Critically, the status column is the fix for a GDPR diligence issue:
 * publishing unenforced claims as "proof" is a compliance liability.
 *
 * Test strategy: We mock fetch() globally to control the API response.
 * The page is an async Server Component — React Testing Library renders
 * async components via await render().
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

// Mock global fetch so we can control the API response
const mockFetch = vi.fn();
global.fetch = mockFetch as typeof fetch;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates a mock fetch response that returns the given JSON body. */
function mockApiSuccess(body: object) {
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => body,
  } as Response);
}

/** Simulates a network error or API failure. */
function mockApiFailure() {
  mockFetch.mockResolvedValue({
    ok: false,
    status: 503,
    json: async () => ({ error: true }),
  } as Response);
}

// ---------------------------------------------------------------------------
// Subject
// ---------------------------------------------------------------------------

// Import AFTER mocks so fetch is already mocked
import RetentionProofPage from '../page';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('/legal/retention-proof page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('static content', () => {
    it('renders without throwing', async () => {
      mockApiSuccess({ sessions_purged_30d: 0, as_of: new Date().toISOString() });
      const Page = RetentionProofPage as () => Promise<React.ReactElement>;
      const jsx = await Page();
      expect(() => render(jsx)).not.toThrow();
    });

    it('renders page heading with target-policy framing', async () => {
      mockApiSuccess({ sessions_purged_30d: 42, as_of: new Date().toISOString() });
      const Page = RetentionProofPage as () => Promise<React.ReactElement>;
      render(await Page());
      // WHY: The heading was changed from "Data Retention Proof" to clearly
      // distinguish target policy from enforced rules.
      expect(
        screen.getByRole('heading', { name: /Data Retention.*Target Policy.*Live Proof/i })
      ).toBeInTheDocument();
    });

    it('renders GDPR Art. 5(1)(e) citation', async () => {
      mockApiSuccess({ sessions_purged_30d: 0, as_of: new Date().toISOString() });
      const Page = RetentionProofPage as () => Promise<React.ReactElement>;
      render(await Page());
      expect(screen.getByText(/GDPR Article 5\(1\)\(e\)/)).toBeInTheDocument();
    });

    it('renders policy table with correct aria-label', async () => {
      mockApiSuccess({ sessions_purged_30d: 0, as_of: new Date().toISOString() });
      const Page = RetentionProofPage as () => Promise<React.ReactElement>;
      render(await Page());
      expect(screen.getByRole('table', { name: 'Styrby data retention policy' })).toBeInTheDocument();
    });

    it('renders all data type rows in the policy table', async () => {
      mockApiSuccess({ sessions_purged_30d: 0, as_of: new Date().toISOString() });
      const Page = RetentionProofPage as () => Promise<React.ReactElement>;
      render(await Page());

      const expectedRows = [
        'Sessions',
        'Session messages',
        'Audit log entries',
        'Data export requests',
        'Account (profile)',
        'Cost records',
      ];

      for (const row of expectedRows) {
        expect(screen.getByText(row)).toBeInTheDocument();
      }
    });

    it('renders "Retention Policy at a Glance" section heading', async () => {
      mockApiSuccess({ sessions_purged_30d: 0, as_of: new Date().toISOString() });
      const Page = RetentionProofPage as () => Promise<React.ReactElement>;
      render(await Page());
      expect(screen.getByRole('heading', { name: 'Retention Policy at a Glance' })).toBeInTheDocument();
    });

    it('renders "Live Proof" section heading', async () => {
      mockApiSuccess({ sessions_purged_30d: 5, as_of: new Date().toISOString() });
      const Page = RetentionProofPage as () => Promise<React.ReactElement>;
      render(await Page());
      expect(
        screen.getByRole('heading', { name: /Live Proof.*Records Purged/i })
      ).toBeInTheDocument();
    });

    it('renders "Status" column header in the policy table', async () => {
      mockApiSuccess({ sessions_purged_30d: 0, as_of: new Date().toISOString() });
      const Page = RetentionProofPage as () => Promise<React.ReactElement>;
      render(await Page());
      expect(screen.getByRole('columnheader', { name: /Status/i })).toBeInTheDocument();
    });

    it('renders enforcement legend explaining ✅ Enforced and 📋 Target', async () => {
      mockApiSuccess({ sessions_purged_30d: 0, as_of: new Date().toISOString() });
      const Page = RetentionProofPage as () => Promise<React.ReactElement>;
      const { container } = render(await Page());

      // Multiple Enforced/Target labels are expected (legend + badge column)
      expect(screen.getAllByText(/Enforced/i).length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText(/Target/i).length).toBeGreaterThanOrEqual(1);

      // Legend should describe what each means
      expect(container.textContent).toMatch(/active automated cron or scheduled job/);
      expect(container.textContent).toMatch(/automated enforcement in progress/);
    });
  });

  describe('enforcement status column', () => {
    it('renders ✅ enforced badges for enforced rows (Sessions, Session messages, Data export requests)', async () => {
      mockApiSuccess({ sessions_purged_30d: 0, as_of: new Date().toISOString() });
      const Page = RetentionProofPage as () => Promise<React.ReactElement>;
      const { container } = render(await Page());

      // data-enforcement="enforced" should appear on the three enforced rows
      const enforcedBadges = container.querySelectorAll('[data-enforcement="enforced"]');
      // Sessions, Session messages, Data export requests = 3 enforced rows
      expect(enforcedBadges.length).toBe(3);
    });

    it('renders 📋 target badges for unenforced rows (Account, Audit log, Cost records)', async () => {
      mockApiSuccess({ sessions_purged_30d: 0, as_of: new Date().toISOString() });
      const Page = RetentionProofPage as () => Promise<React.ReactElement>;
      const { container } = render(await Page());

      // data-enforcement="target" should appear on the three target rows
      const targetBadges = container.querySelectorAll('[data-enforcement="target"]');
      // Account (profile), Audit log entries, Cost records = 3 target rows
      expect(targetBadges.length).toBe(3);
    });

    it('Sessions row has enforced status', async () => {
      mockApiSuccess({ sessions_purged_30d: 0, as_of: new Date().toISOString() });
      const Page = RetentionProofPage as () => Promise<React.ReactElement>;
      const { container } = render(await Page());

      // Find the Sessions row and check its badge
      const table = screen.getByRole('table', { name: 'Styrby data retention policy' });
      const rows = table.querySelectorAll('tbody tr');
      const sessionsRow = Array.from(rows).find((r) => r.textContent?.includes('Sessions') && !r.textContent?.includes('Session messages'));
      expect(sessionsRow).toBeDefined();
      expect(sessionsRow!.querySelector('[data-enforcement="enforced"]')).not.toBeNull();
    });

    it('Audit log entries row has target status', async () => {
      mockApiSuccess({ sessions_purged_30d: 0, as_of: new Date().toISOString() });
      const Page = RetentionProofPage as () => Promise<React.ReactElement>;
      const { container } = render(await Page());

      const table = screen.getByRole('table', { name: 'Styrby data retention policy' });
      const rows = table.querySelectorAll('tbody tr');
      const auditRow = Array.from(rows).find((r) => r.textContent?.includes('Audit log entries'));
      expect(auditRow).toBeDefined();
      expect(auditRow!.querySelector('[data-enforcement="target"]')).not.toBeNull();
    });

    it('Cost records row has target status', async () => {
      mockApiSuccess({ sessions_purged_30d: 0, as_of: new Date().toISOString() });
      const Page = RetentionProofPage as () => Promise<React.ReactElement>;
      const { container } = render(await Page());

      const table = screen.getByRole('table', { name: 'Styrby data retention policy' });
      const rows = table.querySelectorAll('tbody tr');
      const costRow = Array.from(rows).find((r) => r.textContent?.includes('Cost records'));
      expect(costRow).toBeDefined();
      expect(costRow!.querySelector('[data-enforcement="target"]')).not.toBeNull();
    });
  });

  describe('live counts — API success', () => {
    it('renders the sessions_purged_30d count', async () => {
      mockApiSuccess({ sessions_purged_30d: 127, as_of: '2026-04-24T09:00:00.000Z' });
      const Page = RetentionProofPage as () => Promise<React.ReactElement>;
      render(await Page());

      // The count should appear as formatted number
      expect(screen.getByText('127')).toBeInTheDocument();
    });

    it('renders "sessions soft-deleted" label', async () => {
      mockApiSuccess({ sessions_purged_30d: 42, as_of: new Date().toISOString() });
      const Page = RetentionProofPage as () => Promise<React.ReactElement>;
      render(await Page());

      expect(screen.getByText(/Sessions soft-deleted \(last 30 days\)/i)).toBeInTheDocument();
    });

    it('does NOT render the fallback unavailable message on success', async () => {
      mockApiSuccess({ sessions_purged_30d: 0, as_of: new Date().toISOString() });
      const Page = RetentionProofPage as () => Promise<React.ReactElement>;
      render(await Page());

      expect(screen.queryByText(/Retention data temporarily unavailable/i)).not.toBeInTheDocument();
    });

    it('live proof section shows only sessions count — no fake counts for unenforced rules', async () => {
      mockApiSuccess({ sessions_purged_30d: 55, as_of: new Date().toISOString() });
      const Page = RetentionProofPage as () => Promise<React.ReactElement>;
      render(await Page());

      // Sessions count card MUST appear
      expect(screen.getByText(/Sessions soft-deleted \(last 30 days\)/i)).toBeInTheDocument();

      // WHY: audit logs, cost records, and account purges are target rules —
      // no cron backs them in migration 025. Displaying counts for them would
      // be fabricating "proof" that doesn't exist.
      // We check that there is no live-count label for these unenforced types.
      expect(screen.queryByText(/Audit log.*soft.deleted/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/Audit log.*\(last 30 days\)/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/Cost records.*\(last 30 days\)/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/Accounts.*hard.deleted.*\(last 30 days\)/i)).not.toBeInTheDocument();
    });

    it('live proof section includes note that only enforced rules appear here', async () => {
      mockApiSuccess({ sessions_purged_30d: 5, as_of: new Date().toISOString() });
      const Page = RetentionProofPage as () => Promise<React.ReactElement>;
      render(await Page());

      // WHY: Users (and auditors) should understand why not all rules have counts.
      expect(screen.getByText(/Live counts are shown only for/i)).toBeInTheDocument();
    });
  });

  describe('live counts — API failure', () => {
    it('renders fallback message when API returns 503', async () => {
      mockApiFailure();
      const Page = RetentionProofPage as () => Promise<React.ReactElement>;
      render(await Page());

      expect(
        screen.getByText(/Retention data temporarily unavailable/i)
      ).toBeInTheDocument();
    });

    it('fallback message notes that policy still applies', async () => {
      mockApiFailure();
      const Page = RetentionProofPage as () => Promise<React.ReactElement>;
      render(await Page());

      expect(
        screen.getByText(/policy table above still applies/i)
      ).toBeInTheDocument();
    });

    it('renders policy table even when API fails', async () => {
      mockApiFailure();
      const Page = RetentionProofPage as () => Promise<React.ReactElement>;
      render(await Page());

      // Static policy table must always render regardless of API state
      expect(screen.getByRole('table', { name: 'Styrby data retention policy' })).toBeInTheDocument();
      expect(screen.getByText('Sessions')).toBeInTheDocument();
    });

    it('does NOT render the live count stats on API failure', async () => {
      mockApiFailure();
      const Page = RetentionProofPage as () => Promise<React.ReactElement>;
      render(await Page());

      expect(screen.queryByText(/Sessions soft-deleted \(last 30 days\)/i)).not.toBeInTheDocument();
    });

    it('status column still renders enforced/target badges when API fails', async () => {
      mockApiFailure();
      const Page = RetentionProofPage as () => Promise<React.ReactElement>;
      const { container } = render(await Page());

      // The enforcement status badges must render regardless of API state
      const enforcedBadges = container.querySelectorAll('[data-enforcement="enforced"]');
      const targetBadges = container.querySelectorAll('[data-enforcement="target"]');
      expect(enforcedBadges.length).toBe(3);
      expect(targetBadges.length).toBe(3);
    });
  });

  describe('footer disclaimer', () => {
    it('renders disclaimer about target rules and future automation', async () => {
      mockApiSuccess({ sessions_purged_30d: 0, as_of: new Date().toISOString() });
      const Page = RetentionProofPage as () => Promise<React.ReactElement>;
      render(await Page());

      // WHY: The footer must acknowledge that target rules will be automated
      // in a future release — this is the honest disclosure required for
      // GDPR Art. 5(1)(e) due diligence.
      expect(
        screen.getByText(/Target rules without automated enforcement will be backed by scheduled jobs in a future release/i)
      ).toBeInTheDocument();
    });

    it('footer references migration 025', async () => {
      mockApiSuccess({ sessions_purged_30d: 0, as_of: new Date().toISOString() });
      const Page = RetentionProofPage as () => Promise<React.ReactElement>;
      render(await Page());

      // Multiple references to migration 025 are expected
      const migRefs = screen.getAllByText(/migration 025/i);
      expect(migRefs.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('a11y', () => {
    it('does not use text-zinc-600 for meaningful content', async () => {
      mockApiSuccess({ sessions_purged_30d: 0, as_of: new Date().toISOString() });
      const Page = RetentionProofPage as () => Promise<React.ReactElement>;
      const { container } = render(await Page());

      const zinc600Elements = container.querySelectorAll('.text-zinc-600');
      // text-zinc-600 should not appear in this page (per a11y regression rule)
      expect(zinc600Elements.length).toBe(0);
    });

    it('live proof section has role="status" on fallback for screen readers', async () => {
      mockApiFailure();
      const Page = RetentionProofPage as () => Promise<React.ReactElement>;
      render(await Page());

      const status = screen.getByRole('status');
      expect(status).toBeInTheDocument();
    });

    it('enforcement badges have aria-labels for screen reader context', async () => {
      mockApiSuccess({ sessions_purged_30d: 0, as_of: new Date().toISOString() });
      const Page = RetentionProofPage as () => Promise<React.ReactElement>;
      const { container } = render(await Page());

      const badges = container.querySelectorAll('[data-enforcement]');
      for (const badge of Array.from(badges)) {
        expect(badge.getAttribute('aria-label')).toBeTruthy();
      }
    });
  });
});
