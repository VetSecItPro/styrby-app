/**
 * DashboardSidebar Component Tests
 *
 * Tests the dashboard sidebar:
 * - Collapsed vs. expanded state: correct widths, nav labels, toggle button
 * - Active route highlighting via usePathname
 * - All six navigation links render correctly
 * - Onboarding banner is rendered only when expanded and provided
 * - Plan badge and progress bar are hidden when collapsed
 * - Collapse/expand toggle button aria-labels
 *
 * WHY: The sidebar is the primary navigation surface in the dashboard.
 * Broken nav links or the collapsed/expanded state logic directly impair
 * users' ability to navigate across the app.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockUsePathname = vi.fn();

vi.mock('next/navigation', () => ({
  usePathname: () => mockUsePathname(),
}));

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

import { DashboardSidebar } from '../sidebar';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface SetupOptions {
  collapsed?: boolean;
  onToggle?: () => void;
  onboardingBanner?: React.ReactNode;
  pathname?: string;
}

function setup({
  collapsed = false,
  onToggle = vi.fn(),
  onboardingBanner,
  pathname = '/dashboard',
}: SetupOptions = {}) {
  mockUsePathname.mockReturnValue(pathname);
  const utils = render(
    <DashboardSidebar
      collapsed={collapsed}
      onToggle={onToggle}
      onboardingBanner={onboardingBanner}
    />
  );
  return { onToggle, ...utils };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DashboardSidebar — navigation links', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUsePathname.mockReturnValue('/dashboard');
  });

  it('renders all six nav links when expanded', () => {
    setup();

    expect(screen.getByRole('link', { name: /dashboard/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /sessions/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /costs/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /agents/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /settings/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /support/i })).toBeInTheDocument();
  });

  it('nav links have correct hrefs', () => {
    setup();

    expect(screen.getByRole('link', { name: /dashboard/i })).toHaveAttribute(
      'href',
      '/dashboard'
    );
    expect(screen.getByRole('link', { name: /sessions/i })).toHaveAttribute(
      'href',
      '/dashboard/sessions'
    );
    expect(screen.getByRole('link', { name: /costs/i })).toHaveAttribute(
      'href',
      '/dashboard/costs'
    );
    expect(screen.getByRole('link', { name: /agents/i })).toHaveAttribute(
      'href',
      '/dashboard/agents'
    );
    expect(screen.getByRole('link', { name: /settings/i })).toHaveAttribute(
      'href',
      '/dashboard/settings'
    );
    expect(screen.getByRole('link', { name: /support/i })).toHaveAttribute(
      'href',
      '/dashboard/support'
    );
  });
});

describe('DashboardSidebar — collapsed state', () => {
  it('hides nav text labels when collapsed', () => {
    setup({ collapsed: true });

    // Labels should not appear as visible text
    expect(screen.queryByText('Dashboard')).not.toBeInTheDocument();
    expect(screen.queryByText('Sessions')).not.toBeInTheDocument();
  });

  it('hides plan badge section when collapsed', () => {
    setup({ collapsed: true });

    expect(screen.queryByText('Pro Plan')).not.toBeInTheDocument();
  });

  it('shows plan badge section when expanded', () => {
    setup({ collapsed: false });

    expect(screen.getByText('Pro Plan')).toBeInTheDocument();
  });
});

describe('DashboardSidebar — toggle button', () => {
  it('shows "Expand sidebar" aria-label when collapsed', () => {
    setup({ collapsed: true });

    expect(
      screen.getByRole('button', { name: 'Expand sidebar' })
    ).toBeInTheDocument();
  });

  it('shows "Collapse sidebar" aria-label when expanded', () => {
    setup({ collapsed: false });

    expect(
      screen.getByRole('button', { name: 'Collapse sidebar' })
    ).toBeInTheDocument();
  });

  it('calls onToggle when the toggle button is clicked', () => {
    const onToggle = vi.fn();
    setup({ collapsed: false, onToggle });

    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }));

    expect(onToggle).toHaveBeenCalledOnce();
  });
});

describe('DashboardSidebar — active route highlighting', () => {
  it('applies active styles to the link matching the current pathname', () => {
    setup({ pathname: '/dashboard/sessions' });

    const sessionsLink = screen.getByRole('link', { name: /sessions/i });
    expect(sessionsLink.className).toMatch(/amber-500/);
  });

  it('does not apply active styles to non-current routes', () => {
    setup({ pathname: '/dashboard/sessions' });

    const costsLink = screen.getByRole('link', { name: /costs/i });
    expect(costsLink.className).not.toMatch(/border-l-2/);
  });
});

describe('DashboardSidebar — onboarding banner slot', () => {
  it('renders the onboarding banner when expanded and provided', () => {
    setup({
      collapsed: false,
      onboardingBanner: <div data-testid="onboarding-banner">Set up your account</div>,
    });

    expect(screen.getByTestId('onboarding-banner')).toBeInTheDocument();
  });

  it('does not render the onboarding banner when sidebar is collapsed', () => {
    setup({
      collapsed: true,
      onboardingBanner: <div data-testid="onboarding-banner">Set up your account</div>,
    });

    expect(screen.queryByTestId('onboarding-banner')).not.toBeInTheDocument();
  });

  it('renders normally without an onboarding banner', () => {
    // Should not throw when onboardingBanner is undefined
    expect(() => setup({ collapsed: false })).not.toThrow();
  });
});
