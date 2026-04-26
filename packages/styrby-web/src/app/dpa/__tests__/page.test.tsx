/**
 * Tests for /dpa page — Download PDF button
 *
 * Coverage:
 *   - Page renders without throwing
 *   - Download PDF button is present with correct aria-label
 *   - Button has data-print-hide attribute (hidden in print output)
 *   - Button click calls window.print()
 *   - DPA heading is rendered
 *   - Related links include Subprocessors link
 *
 * WHY: The Download PDF button is an enterprise workflow feature. If the
 * button regresses (missing aria-label, missing data-print-hide, broken
 * onClick), enterprise customers cannot save the DPA for their records.
 * data-print-hide must be present or the button will appear in the PDF.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

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

// Mock window.print — it doesn't exist in jsdom
const mockPrint = vi.fn();
Object.defineProperty(window, 'print', {
  value: mockPrint,
  writable: true,
});

// ---------------------------------------------------------------------------
// Subject
// ---------------------------------------------------------------------------

import DpaPage from '../page';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('/dpa page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders without throwing', () => {
    expect(() => render(<DpaPage />)).not.toThrow();
  });

  it('renders the DPA main heading', () => {
    render(<DpaPage />);
    expect(
      screen.getByRole('heading', { name: 'Data Processing Agreement' })
    ).toBeInTheDocument();
  });

  it('renders the Download PDF button', () => {
    render(<DpaPage />);

    const btn = screen.getByRole('button', { name: 'Open print dialog to save this DPA as a PDF' });
    expect(btn).toBeInTheDocument();
  });

  it('button is wrapped in a data-print-hide container (hidden in printed PDF)', () => {
    render(<DpaPage />);

    const btn = screen.getByRole('button', { name: 'Open print dialog to save this DPA as a PDF' });
    // WHY closest: the wrapper div carries data-print-hide so the button AND
    // its helper text are both suppressed in the printed PDF output.
    const hiddenContainer = btn.closest('[data-print-hide]');
    expect(hiddenContainer).not.toBeNull();
  });

  it('button click calls window.print()', async () => {
    const user = userEvent.setup();
    render(<DpaPage />);

    const btn = screen.getByRole('button', { name: 'Open print dialog to save this DPA as a PDF' });
    await user.click(btn);

    expect(mockPrint).toHaveBeenCalledTimes(1);
  });

  it('renders link to Subprocessors page', () => {
    render(<DpaPage />);

    const link = screen.getByRole('link', { name: 'Subprocessors' });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute('href', '/legal/subprocessors');
  });

  it('renders link to Privacy Policy', () => {
    render(<DpaPage />);

    const links = screen.getAllByRole('link', { name: 'Privacy Policy' });
    expect(links.length).toBeGreaterThan(0);
  });

  it('does not use text-zinc-600 for meaningful content (a11y regression)', () => {
    const { container } = render(<DpaPage />);

    const zinc600Elements = container.querySelectorAll('.text-zinc-600');
    expect(zinc600Elements.length).toBe(0);
  });
});
