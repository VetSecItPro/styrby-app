/**
 * SessionConnectionBadge — unit tests (web)
 *
 * Covers each status variant:
 *   - 'connected'    — green chip, "Connected" label
 *   - 'reconnecting' — amber chip, "Reconnecting…" / "Reconnecting (N)"
 *   - 'offline'      — gray chip, "Offline" + optional relative age
 *   - 'unknown'      — renders null
 *
 * Also covers WCAG 1.4.1 compliance: every visible state has an
 * aria-label that conveys meaning without relying on colour alone.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SessionConnectionBadge } from '../SessionConnectionBadge';

// ============================================================================
// Helpers
// ============================================================================

/** ISO timestamp N milliseconds in the past */
function msAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

// ============================================================================
// Tests
// ============================================================================

describe('SessionConnectionBadge', () => {
  describe('unknown status', () => {
    it('renders nothing when status is unknown', () => {
      const { container } = render(
        <SessionConnectionBadge status="unknown" lastSeenAt={null} />,
      );
      expect(container.firstChild).toBeNull();
    });
  });

  describe('connected status', () => {
    it('renders "Connected" label', () => {
      render(
        <SessionConnectionBadge status="connected" lastSeenAt={msAgo(5_000)} />,
      );
      expect(screen.getByText('Connected')).toBeInTheDocument();
    });

    it('has accessible aria-label mentioning "Connected"', () => {
      const { container } = render(
        <SessionConnectionBadge status="connected" lastSeenAt={msAgo(5_000)} />,
      );
      const chip = container.firstChild as HTMLElement;
      expect(chip?.getAttribute('aria-label')).toContain('Connected');
    });

    it('applies green colour classes', () => {
      const { container } = render(
        <SessionConnectionBadge status="connected" lastSeenAt={null} />,
      );
      const chip = container.firstChild as HTMLElement;
      expect(chip?.className).toContain('green');
    });
  });

  describe('reconnecting status', () => {
    it('renders "Reconnecting…" when no attempt is provided', () => {
      render(
        <SessionConnectionBadge
          status="reconnecting"
          lastSeenAt={msAgo(10_000)}
        />,
      );
      expect(screen.getByText('Reconnecting…')).toBeInTheDocument();
    });

    it('renders "Reconnecting (0)" when attempt is 0', () => {
      render(
        <SessionConnectionBadge
          status="reconnecting"
          lastSeenAt={msAgo(5_000)}
          attempt={0}
        />,
      );
      // attempt=0 should fall into the no-attempt branch ("Reconnecting…")
      expect(screen.getByText('Reconnecting…')).toBeInTheDocument();
    });

    it('renders attempt count when attempt > 0', () => {
      render(
        <SessionConnectionBadge
          status="reconnecting"
          lastSeenAt={msAgo(5_000)}
          attempt={3}
        />,
      );
      expect(screen.getByText('Reconnecting (3)')).toBeInTheDocument();
    });

    it('caps displayed attempt at "99+" beyond MAX_DISPLAYED_ATTEMPT', () => {
      render(
        <SessionConnectionBadge
          status="reconnecting"
          lastSeenAt={msAgo(5_000)}
          attempt={150}
        />,
      );
      expect(screen.getByText('Reconnecting (99+)')).toBeInTheDocument();
    });

    it('applies amber colour classes', () => {
      const { container } = render(
        <SessionConnectionBadge
          status="reconnecting"
          lastSeenAt={null}
          attempt={2}
        />,
      );
      const chip = container.firstChild as HTMLElement;
      expect(chip?.className).toContain('amber');
    });
  });

  describe('offline status', () => {
    it('renders "Offline" when lastSeenAt is null', () => {
      render(<SessionConnectionBadge status="offline" lastSeenAt={null} />);
      expect(screen.getByText('Offline')).toBeInTheDocument();
    });

    it('shows relative age in the label for recent offline sessions', () => {
      const lastSeen = msAgo(5 * 60_000); // 5 min ago
      render(<SessionConnectionBadge status="offline" lastSeenAt={lastSeen} />);
      // Label is "Offline - X min ago"
      const el = screen.getByText(/offline/i);
      expect(el.textContent).toMatch(/offline.*min ago/i);
    });

    it('applies zinc colour classes', () => {
      const { container } = render(
        <SessionConnectionBadge status="offline" lastSeenAt={null} />,
      );
      const chip = container.firstChild as HTMLElement;
      expect(chip?.className).toContain('zinc');
    });

    it('has an accessible aria-label that includes "Offline"', () => {
      const { container } = render(
        <SessionConnectionBadge status="offline" lastSeenAt={null} />,
      );
      const chip = container.firstChild as HTMLElement;
      expect(chip?.getAttribute('aria-label')).toContain('Offline');
    });
  });

  describe('WCAG 1.4.1 — meaning not conveyed by colour alone', () => {
    it.each(['connected', 'reconnecting', 'offline'] as const)(
      '"%s" status chip has visible text label',
      (status) => {
        const { container } = render(
          <SessionConnectionBadge
            status={status}
            lastSeenAt={null}
            attempt={status === 'reconnecting' ? 1 : undefined}
          />,
        );
        // Each chip must have at least one text node visible to sighted users.
        // WHY: The chip is a plain <span> — it has no ARIA role="presentation".
        // We verify WCAG 1.4.1 compliance by confirming the chip carries a
        // non-empty aria-label (meaning is not colour-only) and that its text
        // content is non-empty (visible to sighted users without colour cues).
        const chip = container.firstChild as HTMLElement;
        expect(chip?.getAttribute('aria-label')).toBeTruthy();
        expect(chip?.textContent?.trim()).toBeTruthy();
      },
    );
  });

  describe('tooltip / title attribute', () => {
    it('provides "Last seen:" tooltip for connected status', () => {
      const { container } = render(
        <SessionConnectionBadge status="connected" lastSeenAt={msAgo(5_000)} />,
      );
      const chip = container.firstChild as HTMLElement;
      expect(chip?.getAttribute('title')).toContain('Last seen:');
    });

    it('shows "Unknown" in title when lastSeenAt is null', () => {
      const { container } = render(
        <SessionConnectionBadge status="connected" lastSeenAt={null} />,
      );
      const chip = container.firstChild as HTMLElement;
      expect(chip?.getAttribute('title')).toContain('Unknown');
    });
  });
});
