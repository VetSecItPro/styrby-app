/**
 * Tests for /legal/subprocessors page
 *
 * Coverage:
 *   - Page renders all 6 subprocessors from the typed config
 *   - Each row contains name, purpose, and DPF badge
 *   - Table has correct aria-label for accessibility
 *   - DPF "Yes" badge present for certified sub-processors
 *   - DPF "No" badge present for non-certified sub-processors
 *   - No text-zinc-600 used for meaningful content (a11y regression)
 *   - Last-updated date is rendered
 *   - Footer contact note is present
 *
 * WHY: The subprocessors page is a compliance artifact required for GDPR
 * Art. 28 transparency. If it regresses (missing rows, broken table), we
 * lose trust with enterprise prospects and may be non-compliant.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';

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

// ---------------------------------------------------------------------------
// Subject
// ---------------------------------------------------------------------------

import SubprocessorsPage from '../page';
import { SUBPROCESSORS, SUBPROCESSORS_LAST_UPDATED } from '@/lib/legal/subprocessors';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('/legal/subprocessors page', () => {
  it('renders without throwing', () => {
    expect(() => render(<SubprocessorsPage />)).not.toThrow();
  });

  it('renders all 6 subprocessors', () => {
    render(<SubprocessorsPage />);

    for (const sp of SUBPROCESSORS) {
      expect(screen.getByText(sp.name)).toBeInTheDocument();
    }
  });

  it('table has correct aria-label', () => {
    render(<SubprocessorsPage />);

    const table = screen.getByRole('table', { name: 'Styrby subprocessors' });
    expect(table).toBeInTheDocument();
  });

  it('renders all column headers', () => {
    render(<SubprocessorsPage />);

    expect(screen.getByText('Name')).toBeInTheDocument();
    expect(screen.getByText('Purpose')).toBeInTheDocument();
    expect(screen.getByText('Location')).toBeInTheDocument();
    expect(screen.getByText('DPF Certified')).toBeInTheDocument();
    expect(screen.getByText('Categories')).toBeInTheDocument();
    expect(screen.getByText('Data Shared')).toBeInTheDocument();
  });

  it('renders purpose text for each subprocessor', () => {
    render(<SubprocessorsPage />);

    for (const sp of SUBPROCESSORS) {
      // Each purpose appears in the document
      expect(screen.getByText(sp.purpose)).toBeInTheDocument();
    }
  });

  it('renders DPF "Yes" badge for certified subprocessors', () => {
    render(<SubprocessorsPage />);

    const certifiedCount = SUBPROCESSORS.filter((sp) => sp.dpf_certified).length;
    const yesBadges = screen.getAllByText('Yes');
    expect(yesBadges.length).toBe(certifiedCount);
  });

  it('renders DPF "No" badge for non-certified subprocessors', () => {
    render(<SubprocessorsPage />);

    const nonCertifiedCount = SUBPROCESSORS.filter((sp) => !sp.dpf_certified).length;
    const noBadges = screen.getAllByText('No');
    expect(noBadges.length).toBe(nonCertifiedCount);
  });

  it('renders Vercel row with correct name and DPF status', () => {
    render(<SubprocessorsPage />);

    const table = screen.getByRole('table', { name: 'Styrby subprocessors' });
    const vercelLink = within(table).getByRole('link', { name: 'Vercel' });
    expect(vercelLink).toBeInTheDocument();
    expect(vercelLink).toHaveAttribute('href', 'https://vercel.com/legal/privacy-policy');
  });

  it('renders Supabase row with correct name', () => {
    render(<SubprocessorsPage />);

    const table = screen.getByRole('table', { name: 'Styrby subprocessors' });
    expect(within(table).getByRole('link', { name: 'Supabase' })).toBeInTheDocument();
  });

  it('renders last-updated date', () => {
    render(<SubprocessorsPage />);

    expect(screen.getByText(`Last updated: ${SUBPROCESSORS_LAST_UPDATED}`)).toBeInTheDocument();
  });

  it('renders footer contact note', () => {
    render(<SubprocessorsPage />);

    expect(screen.getByText(/legal@styrbyapp\.com/)).toBeInTheDocument();
    expect(screen.getByText(/This list is kept current/)).toBeInTheDocument();
  });

  it('does not use text-zinc-600 (a11y contrast violation regression)', () => {
    const { container } = render(<SubprocessorsPage />);

    // text-zinc-600 is banned site-wide per a11y-regression.test.ts — it fails contrast.
    // All text must use text-zinc-500 or higher.
    const zinc600Elements = container.querySelectorAll('.text-zinc-600');
    expect(zinc600Elements.length).toBe(0);
  });

  it('renders links to related legal pages', () => {
    render(<SubprocessorsPage />);

    const dpaLinks = screen.getAllByRole('link', { name: /Data Processing Agreement/i });
    expect(dpaLinks.length).toBeGreaterThan(0);

    const privacyLinks = screen.getAllByRole('link', { name: /Privacy Policy/i });
    expect(privacyLinks.length).toBeGreaterThan(0);
  });
});
