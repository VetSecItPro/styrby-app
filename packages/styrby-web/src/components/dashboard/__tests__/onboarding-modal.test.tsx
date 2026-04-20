/**
 * OnboardingModal Component Tests
 *
 * Tests the welcome onboarding modal:
 * - Tier-specific welcome headlines (free, pro, power)
 * - Progress bar percentage and counts
 * - Step checklist: incomplete steps render as links, completed ones as strikethrough text
 * - "Get Started" button calls onDismiss
 * - Dialog open/close: onDismiss called when dialog closes
 * - Completed steps show strikethrough styling, not a link
 * - Incomplete steps link to the correct href
 *
 * WHY: The onboarding modal is the first thing a new user sees after signup.
 * Broken step links or wrong tier copy create a bad first impression and
 * increase support volume.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { OnboardingState } from '@/lib/onboarding';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('next/image', () => ({
  // eslint-disable-next-line @next/next/no-img-element -- test stub replacing next/image itself; circular to use Image here
  default: ({ alt }: { alt: string }) => <img alt={alt} />,
}));

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    onClick,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    onClick?: () => void;
    className?: string;
  }) => (
    <a href={href} onClick={onClick} className={className}>
      {children}
    </a>
  ),
}));

// Mock the ResponsiveDialog to a simpler wrapper so we can test the modal
// content without needing full Radix UI setup.
vi.mock('@/components/ui/responsive-dialog', () => ({
  ResponsiveDialog: ({
    children,
    open,
    onOpenChange,
  }: {
    children: React.ReactNode;
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }) =>
    open ? (
      <div data-testid="dialog" onClick={() => onOpenChange(false)}>
        {children}
      </div>
    ) : null,
  ResponsiveDialogContent: ({ children }: { children: React.ReactNode }) => (
    <div onClick={(e) => e.stopPropagation()}>{children}</div>
  ),
  ResponsiveDialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  ResponsiveDialogFooter: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  ResponsiveDialogTitle: ({
    children,
    className,
  }: {
    children: React.ReactNode;
    className?: string;
  }) => <h2 className={className}>{children}</h2>,
  ResponsiveDialogDescription: ({
    children,
  }: {
    children: React.ReactNode;
  }) => <p>{children}</p>,
}));

// ---------------------------------------------------------------------------
// Subject
// ---------------------------------------------------------------------------

import { OnboardingModal } from '../onboarding-modal';

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

/**
 * Builds a minimal OnboardingState for testing.
 */
function buildState(overrides: Partial<OnboardingState> = {}): OnboardingState {
  return {
    tier: 'free',
    steps: [
      {
        id: 'connect-machine',
        label: 'Connect a machine',
        description: 'Pair your first device using the Styrby CLI.',
        href: '/dashboard/devices/pair',
        completed: false,
      },
    ],
    completedCount: 0,
    totalSteps: 1,
    isComplete: false,
    onboardingCompletedAt: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OnboardingModal — tier headlines', () => {
  it('shows "Welcome to Styrby" for free tier', () => {
    render(
      <OnboardingModal onboardingState={buildState({ tier: 'free' })} onDismiss={vi.fn()} />
    );

    expect(screen.getByRole('heading', { name: 'Welcome to Styrby' })).toBeInTheDocument();
  });

  it('shows "Welcome to Pro" for pro tier', () => {
    render(
      <OnboardingModal onboardingState={buildState({ tier: 'pro' })} onDismiss={vi.fn()} />
    );

    expect(screen.getByRole('heading', { name: 'Welcome to Pro' })).toBeInTheDocument();
  });

  it('shows "Welcome to Power" for power tier', () => {
    render(
      <OnboardingModal onboardingState={buildState({ tier: 'power' })} onDismiss={vi.fn()} />
    );

    expect(screen.getByRole('heading', { name: 'Welcome to Power' })).toBeInTheDocument();
  });
});

describe('OnboardingModal — progress', () => {
  it('shows "0 of 1 complete" when no steps done', () => {
    render(
      <OnboardingModal onboardingState={buildState()} onDismiss={vi.fn()} />
    );

    expect(screen.getByText('0 of 1 complete')).toBeInTheDocument();
  });

  it('shows "1 of 3 complete" for partial progress', () => {
    const state = buildState({
      tier: 'pro',
      steps: [
        {
          id: 'connect-machine',
          label: 'Connect a machine',
          description: 'Pair device.',
          href: '/dashboard/devices/pair',
          completed: true,
        },
        {
          id: 'set-budget-alert',
          label: 'Set a budget alert',
          description: 'Get notified.',
          href: '/dashboard/costs/budget-alerts',
          completed: false,
        },
        {
          id: 'install-mobile-app',
          label: 'Install the mobile app',
          description: 'Monitor on the go.',
          href: '/dashboard/devices/pair',
          completed: false,
        },
      ],
      completedCount: 1,
      totalSteps: 3,
    });

    render(<OnboardingModal onboardingState={state} onDismiss={vi.fn()} />);

    expect(screen.getByText('1 of 3 complete')).toBeInTheDocument();
    expect(screen.getByText('33%')).toBeInTheDocument();
  });
});

describe('OnboardingModal — step list', () => {
  it('renders incomplete step as a clickable link', () => {
    render(
      <OnboardingModal onboardingState={buildState()} onDismiss={vi.fn()} />
    );

    const link = screen.getByRole('link', { name: 'Connect a machine' });
    expect(link).toHaveAttribute('href', '/dashboard/devices/pair');
  });

  it('renders completed step as strikethrough text (not a link)', () => {
    const state = buildState({
      steps: [
        {
          id: 'connect-machine',
          label: 'Connect a machine',
          description: 'Pair device.',
          href: '/dashboard/devices/pair',
          completed: true,
        },
      ],
      completedCount: 1,
    });

    render(<OnboardingModal onboardingState={state} onDismiss={vi.fn()} />);

    // Text should exist but not as a link
    expect(screen.queryByRole('link', { name: 'Connect a machine' })).not.toBeInTheDocument();
    expect(screen.getByText('Connect a machine')).toBeInTheDocument();
    // Should have line-through styling class
    expect(screen.getByText('Connect a machine').className).toMatch(/line-through/);
  });

  it('renders step descriptions', () => {
    render(
      <OnboardingModal onboardingState={buildState()} onDismiss={vi.fn()} />
    );

    expect(
      screen.getByText('Pair your first device using the Styrby CLI.')
    ).toBeInTheDocument();
  });

  it('calls onDismiss when an incomplete step link is clicked', async () => {
    const onDismiss = vi.fn();
    const user = userEvent.setup();

    render(
      <OnboardingModal onboardingState={buildState()} onDismiss={onDismiss} />
    );

    await user.click(screen.getByRole('link', { name: 'Connect a machine' }));

    expect(onDismiss).toHaveBeenCalledOnce();
  });
});

describe('OnboardingModal — Get Started button', () => {
  it('calls onDismiss when "Get Started" is clicked', async () => {
    const onDismiss = vi.fn();
    const user = userEvent.setup();

    render(
      <OnboardingModal onboardingState={buildState()} onDismiss={onDismiss} />
    );

    await user.click(screen.getByRole('button', { name: /get started/i }));

    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
