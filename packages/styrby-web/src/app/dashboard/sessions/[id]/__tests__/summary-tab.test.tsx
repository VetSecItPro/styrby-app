/**
 * Session Summary Tab Component Tests
 *
 * Tests all 5 render states of the SummaryTab component:
 * 1. Free tier upgrade prompt (shows Lock icon + pricing link)
 * 2. Active session placeholder (no summary yet)
 * 3. Generating state (animated clock, session completed but no summary)
 * 4. No summary available (old session with summaryGeneratedAt but no text)
 * 5. Summary available (collapsible card with AI summary text)
 *
 * WHY: The SummaryTab has complex conditional rendering based on
 * userTier, sessionStatus, summary presence, and summaryGeneratedAt.
 * Bugs here could leak Pro-only content to free users or show wrong states.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SummaryTab } from '../summary-tab';

// ============================================================================
// Mocks
// ============================================================================

/**
 * Mock next/link to render a plain <a> tag for testing.
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

// ============================================================================
// Helpers
// ============================================================================

const BASE_PROPS = {
  sessionId: 'session-uuid-001',
  summary: null as string | null,
  summaryGeneratedAt: null as string | null,
  sessionStatus: 'stopped',
  userTier: 'pro' as const,
};

// ============================================================================
// Tests
// ============================================================================

describe('SummaryTab', () => {
  describe('Free tier upgrade prompt', () => {
    it('renders upgrade prompt for free tier users', () => {
      render(<SummaryTab {...BASE_PROPS} userTier="free" />);

      expect(screen.getByText('AI Session Summaries')).toBeInTheDocument();
      expect(screen.getByText('Upgrade to Pro')).toBeInTheDocument();
      expect(
        screen.getByText('Available on Pro and Power plans')
      ).toBeInTheDocument();
    });

    it('links to /pricing page', () => {
      render(<SummaryTab {...BASE_PROPS} userTier="free" />);

      const link = screen.getByRole('link', { name: /upgrade to pro/i });
      expect(link).toHaveAttribute('href', '/pricing');
    });

    it('does not show summary content for free users even if summary exists', () => {
      render(
        <SummaryTab
          {...BASE_PROPS}
          userTier="free"
          summary="This should not be visible"
          summaryGeneratedAt="2025-01-01T00:00:00Z"
        />
      );

      expect(screen.queryByText('This should not be visible')).not.toBeInTheDocument();
      expect(screen.getByText('Upgrade to Pro')).toBeInTheDocument();
    });
  });

  describe('Active session placeholder', () => {
    it.each(['starting', 'running', 'idle', 'paused'])(
      'renders active placeholder for "%s" session status',
      (status) => {
        render(
          <SummaryTab {...BASE_PROPS} sessionStatus={status} userTier="pro" />
        );

        expect(
          screen.getByText('Summary Available After Session')
        ).toBeInTheDocument();
        expect(
          screen.getByText(/ai summary will be automatically generated/i)
        ).toBeInTheDocument();
      }
    );

    it('shows active placeholder for power tier users too', () => {
      render(
        <SummaryTab {...BASE_PROPS} sessionStatus="running" userTier="power" />
      );

      expect(
        screen.getByText('Summary Available After Session')
      ).toBeInTheDocument();
    });
  });

  describe('Generating state', () => {
    it('renders generating state when session is completed but no summary or timestamp', () => {
      render(
        <SummaryTab
          {...BASE_PROPS}
          sessionStatus="stopped"
          summary={null}
          summaryGeneratedAt={null}
          userTier="pro"
        />
      );

      expect(screen.getByText('Generating Summary...')).toBeInTheDocument();
      expect(
        screen.getByText(/analyzing your session/i)
      ).toBeInTheDocument();
    });

    it.each(['stopped', 'expired', 'error'])(
      'renders generating state for "%s" status without summary',
      (status) => {
        render(
          <SummaryTab
            {...BASE_PROPS}
            sessionStatus={status}
            summary={null}
            summaryGeneratedAt={null}
            userTier="pro"
          />
        );

        expect(screen.getByText('Generating Summary...')).toBeInTheDocument();
      }
    );
  });

  describe('No summary available (old session)', () => {
    it('renders "no summary" state when completed with summaryGeneratedAt but no summary text', () => {
      render(
        <SummaryTab
          {...BASE_PROPS}
          sessionStatus="stopped"
          summary={null}
          summaryGeneratedAt="2025-01-01T00:00:00Z"
          userTier="pro"
        />
      );

      expect(screen.getByText('No Summary Available')).toBeInTheDocument();
      expect(
        screen.getByText(/created before ai summaries were enabled/i)
      ).toBeInTheDocument();
    });
  });

  describe('Summary available', () => {
    const SUMMARY_TEXT = 'This session focused on implementing user authentication with JWT tokens.';
    const GENERATED_AT = '2025-06-15T14:30:00Z';

    it('renders the AI summary text', () => {
      render(
        <SummaryTab
          {...BASE_PROPS}
          sessionStatus="stopped"
          summary={SUMMARY_TEXT}
          summaryGeneratedAt={GENERATED_AT}
          userTier="pro"
        />
      );

      expect(screen.getByText(SUMMARY_TEXT)).toBeInTheDocument();
      expect(screen.getByText('AI Summary')).toBeInTheDocument();
    });

    it('displays the generated-at timestamp', () => {
      render(
        <SummaryTab
          {...BASE_PROPS}
          sessionStatus="stopped"
          summary={SUMMARY_TEXT}
          summaryGeneratedAt={GENERATED_AT}
          userTier="pro"
        />
      );

      // The timestamp is formatted as "Generated Jun 15, 2:30 PM" (locale-dependent)
      expect(screen.getByText(/generated/i)).toBeInTheDocument();
    });

    it('starts expanded by default', () => {
      render(
        <SummaryTab
          {...BASE_PROPS}
          sessionStatus="stopped"
          summary={SUMMARY_TEXT}
          summaryGeneratedAt={GENERATED_AT}
          userTier="pro"
        />
      );

      const toggleButton = screen.getByRole('button', {
        name: /ai summary/i,
      });
      // aria-expanded should be true by default
      expect(toggleButton).toHaveAttribute('aria-expanded', 'true');
    });

    it('toggles collapsed/expanded state on click', () => {
      render(
        <SummaryTab
          {...BASE_PROPS}
          sessionStatus="stopped"
          summary={SUMMARY_TEXT}
          summaryGeneratedAt={GENERATED_AT}
          userTier="pro"
        />
      );

      const toggleButton = screen.getByRole('button', {
        name: /ai summary/i,
      });

      // Initially expanded
      expect(toggleButton).toHaveAttribute('aria-expanded', 'true');

      // Click to collapse
      fireEvent.click(toggleButton);
      expect(toggleButton).toHaveAttribute('aria-expanded', 'false');

      // Click to expand again
      fireEvent.click(toggleButton);
      expect(toggleButton).toHaveAttribute('aria-expanded', 'true');
    });

    it('renders summary for power tier users', () => {
      render(
        <SummaryTab
          {...BASE_PROPS}
          sessionStatus="expired"
          summary={SUMMARY_TEXT}
          summaryGeneratedAt={GENERATED_AT}
          userTier="power"
        />
      );

      expect(screen.getByText(SUMMARY_TEXT)).toBeInTheDocument();
    });

    it('has accessible controls attribute on the toggle', () => {
      render(
        <SummaryTab
          {...BASE_PROPS}
          sessionStatus="stopped"
          summary={SUMMARY_TEXT}
          summaryGeneratedAt={GENERATED_AT}
          userTier="pro"
        />
      );

      const toggleButton = screen.getByRole('button', {
        name: /ai summary/i,
      });
      expect(toggleButton).toHaveAttribute('aria-controls', 'summary-content');
    });
  });

  describe('Tier gating logic', () => {
    it('pro tier has summary access', () => {
      render(
        <SummaryTab
          {...BASE_PROPS}
          sessionStatus="stopped"
          summary="Test summary"
          summaryGeneratedAt="2025-01-01T00:00:00Z"
          userTier="pro"
        />
      );

      expect(screen.queryByText('Upgrade to Pro')).not.toBeInTheDocument();
      expect(screen.getByText('Test summary')).toBeInTheDocument();
    });

    it('power tier has summary access', () => {
      render(
        <SummaryTab
          {...BASE_PROPS}
          sessionStatus="stopped"
          summary="Test summary"
          summaryGeneratedAt="2025-01-01T00:00:00Z"
          userTier="power"
        />
      );

      expect(screen.queryByText('Upgrade to Pro')).not.toBeInTheDocument();
      expect(screen.getByText('Test summary')).toBeInTheDocument();
    });

    it('free tier is gated regardless of session state', () => {
      render(
        <SummaryTab
          {...BASE_PROPS}
          sessionStatus="running"
          userTier="free"
        />
      );

      // Should show upgrade prompt, not the active session state
      expect(screen.getByText('AI Session Summaries')).toBeInTheDocument();
      expect(
        screen.queryByText('Summary Available After Session')
      ).not.toBeInTheDocument();
    });
  });
});
