/**
 * OnboardingBanner Component Tests
 *
 * Tests the sidebar onboarding progress banner:
 * - Compact (collapsed) state by default: shows Setup X/Y and a progress bar
 * - Expands to show the full step list when clicked
 * - Collapses back when the collapse chevron is clicked
 * - Dismiss button (X) removes the banner entirely
 * - Steps: incomplete renders as a link, completed as strikethrough
 * - All-done state: triggers markOnboardingComplete (fetch /api/onboarding/complete)
 *   and shows "You're all set!" message
 * - Auto-dismisses 2 seconds after "all set" message appears
 *
 * WHY: The onboarding banner is the ongoing nudge that drives users to complete
 * critical setup steps (connecting a machine, setting budget alerts). If it
 * breaks, users miss those steps and have poor time-to-value.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { OnboardingState } from '@/lib/onboarding';

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

// Spy on global fetch for the markOnboardingComplete call
const mockFetch = vi.fn().mockResolvedValue({ ok: true });

beforeEach(() => {
  vi.useFakeTimers();
  global.fetch = mockFetch;
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Subject
// ---------------------------------------------------------------------------

import { OnboardingBanner } from '../onboarding-banner';

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function buildState(overrides: Partial<OnboardingState> = {}): OnboardingState {
  return {
    tier: 'pro',
    steps: [
      {
        id: 'connect-machine',
        label: 'Connect a machine',
        description: 'Pair device.',
        href: '/dashboard/devices/pair',
        completed: false,
      },
      {
        id: 'set-budget-alert',
        label: 'Set a budget alert',
        description: 'Get notified.',
        href: '/dashboard/costs/budget-alerts',
        completed: false,
      },
    ],
    completedCount: 0,
    totalSteps: 2,
    isComplete: false,
    onboardingCompletedAt: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OnboardingBanner — compact view', () => {
  it('renders Setup X/Y in compact mode by default', () => {
    render(<OnboardingBanner onboardingState={buildState()} />);

    expect(screen.getByText('Setup: 0/2')).toBeInTheDocument();
  });

  it('does NOT show the step list in compact mode', () => {
    render(<OnboardingBanner onboardingState={buildState()} />);

    expect(screen.queryByRole('link', { name: 'Connect a machine' })).not.toBeInTheDocument();
  });
});

describe('OnboardingBanner — expanded view', () => {
  it('shows the step list after clicking the compact button', () => {
    render(<OnboardingBanner onboardingState={buildState()} />);

    // The compact button contains "Setup: 0/2" text
    const compactBtn = screen.getByRole('button', { name: /setup/i });
    fireEvent.click(compactBtn);

    expect(screen.getByRole('link', { name: 'Connect a machine' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Set a budget alert' })).toBeInTheDocument();
  });

  it('collapses back when the collapse chevron is clicked', () => {
    render(<OnboardingBanner onboardingState={buildState()} />);

    // Expand first
    fireEvent.click(screen.getByRole('button', { name: /setup/i }));
    expect(screen.getByRole('link', { name: 'Connect a machine' })).toBeInTheDocument();

    // Collapse
    fireEvent.click(screen.getByRole('button', { name: /collapse onboarding banner/i }));

    expect(screen.queryByRole('link', { name: 'Connect a machine' })).not.toBeInTheDocument();
  });

  it('renders completed steps as strikethrough (not links)', () => {
    const state = buildState({
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
      ],
      completedCount: 1,
    });

    render(<OnboardingBanner onboardingState={state} />);
    fireEvent.click(screen.getByRole('button', { name: /setup/i }));

    // Completed step is text, not link
    expect(screen.queryByRole('link', { name: 'Connect a machine' })).not.toBeInTheDocument();
    const completedText = screen.getByText('Connect a machine');
    expect(completedText.className).toMatch(/line-through/);

    // Incomplete step is a link
    expect(screen.getByRole('link', { name: 'Set a budget alert' })).toBeInTheDocument();
  });
});

describe('OnboardingBanner — dismiss', () => {
  it('removes the banner when the X dismiss button is clicked (in expanded view)', () => {
    render(<OnboardingBanner onboardingState={buildState()} />);

    // Expand to reveal dismiss button
    fireEvent.click(screen.getByRole('button', { name: /setup/i }));
    fireEvent.click(screen.getByRole('button', { name: /dismiss onboarding banner/i }));

    expect(screen.queryByText(/setup/i)).not.toBeInTheDocument();
  });
});

describe('OnboardingBanner — all steps complete', () => {
  it('calls fetch /api/onboarding/complete when all steps are done', async () => {
    const state = buildState({
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
          completed: true,
        },
      ],
      completedCount: 2,
      totalSteps: 2,
    });

    render(<OnboardingBanner onboardingState={state} />);

    // Flush the synchronous 0ms timer that calls markOnboardingComplete
    await act(async () => {
      vi.advanceTimersByTime(0);
    });

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/onboarding/complete',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('shows "You\'re all set!" message when all steps are done', async () => {
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
      totalSteps: 1,
    });

    render(<OnboardingBanner onboardingState={state} />);

    await act(async () => {
      vi.advanceTimersByTime(0);
    });

    expect(screen.getByText(/you're all set/i)).toBeInTheDocument();
  });

  it('auto-dismisses the banner 2 seconds after "all set" appears', async () => {
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
      totalSteps: 1,
    });

    render(<OnboardingBanner onboardingState={state} />);

    // t=0: "allDone" state appears
    await act(async () => { vi.advanceTimersByTime(0); });
    expect(screen.getByText(/you're all set/i)).toBeInTheDocument();

    // t=2000: auto-dismiss fires
    await act(async () => { vi.advanceTimersByTime(2000); });
    expect(screen.queryByText(/you're all set/i)).not.toBeInTheDocument();
  });

  it('does not call fetch more than once (no duplicate completion calls)', async () => {
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
      totalSteps: 1,
    });

    render(<OnboardingBanner onboardingState={state} />);

    await act(async () => { vi.advanceTimersByTime(100); });

    expect(mockFetch).toHaveBeenCalledOnce();
  });
});
