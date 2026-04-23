/**
 * Tests for the Web HandoffBanner component
 *
 * Covers:
 *   - Renders correctly when handoff is available
 *   - Shows device label (mobile_ios -> "iPhone", cli -> "terminal", etc.)
 *   - Shows "unsent message restored" hint when activeDraft is present
 *   - Does NOT show draft hint when activeDraft is null
 *   - "Resume" button calls onResume with the full handoff object
 *   - "Start fresh" button calls onDismiss
 *   - Dismiss X button calls onDismiss
 *   - Component unmounts itself after any action (no double-fire)
 *   - Accessibility: role="alert" present
 *
 * @module __tests__/HandoffBanner
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HandoffBanner } from '../components/session-handoff/HandoffBanner';
import type { HandoffBannerProps } from '../components/session-handoff/HandoffBanner';
import type { HandoffResponse } from '@styrby/shared/session-handoff';

// ============================================================================
// Fixtures
// ============================================================================

function makeHandoff(
  overrides: Partial<Extract<HandoffResponse, { available: true }>> = {},
): Extract<HandoffResponse, { available: true }> {
  return {
    available: true,
    lastDeviceId: 'device-a-0000-0000-0000-000000000000',
    lastDeviceKind: 'mobile_ios',
    cursorPosition: 5,
    scrollOffset: 100,
    activeDraft: null,
    ageMs: 90_000, // 1 min 30 sec
    ...overrides,
  };
}

function renderBanner(propsOverride: Partial<HandoffBannerProps> = {}) {
  const onResume = vi.fn();
  const onDismiss = vi.fn();
  const handoff = makeHandoff();

  const { unmount } = render(
    <HandoffBanner
      handoff={handoff}
      onResume={onResume}
      onDismiss={onDismiss}
      {...propsOverride}
    />,
  );

  return { onResume, onDismiss, handoff, unmount };
}

// ============================================================================
// Tests
// ============================================================================

afterEach(cleanup);

describe('HandoffBanner', () => {
  // --------------------------------------------------------------------------
  // Rendering
  // --------------------------------------------------------------------------

  it('renders the banner with role="alert"', () => {
    renderBanner();
    expect(screen.getByRole('alert')).toBeDefined();
  });

  it('shows "iPhone" label for mobile_ios device', () => {
    renderBanner({ handoff: makeHandoff({ lastDeviceKind: 'mobile_ios' }) });
    expect(screen.getByText(/iPhone/)).toBeDefined();
  });

  it('shows "Android" label for mobile_android device', () => {
    renderBanner({ handoff: makeHandoff({ lastDeviceKind: 'mobile_android' }) });
    expect(screen.getByText(/Android/)).toBeDefined();
  });

  it('shows "terminal" label for cli device', () => {
    renderBanner({ handoff: makeHandoff({ lastDeviceKind: 'cli' }) });
    expect(screen.getByText(/terminal/)).toBeDefined();
  });

  it('shows "Mac/PC" label for web device', () => {
    renderBanner({ handoff: makeHandoff({ lastDeviceKind: 'web' }) });
    expect(screen.getByText(/Mac\/PC/)).toBeDefined();
  });

  it('shows "just now" for snapshots under 1 minute old', () => {
    renderBanner({ handoff: makeHandoff({ ageMs: 30_000 }) });
    expect(screen.getByText(/just now/)).toBeDefined();
  });

  it('shows "1 min ago" for snapshots exactly 1 minute old', () => {
    renderBanner({ handoff: makeHandoff({ ageMs: 60_000 }) });
    expect(screen.getByText(/1 min ago/)).toBeDefined();
  });

  it('shows "4 min ago" for snapshots 4 minutes old', () => {
    renderBanner({ handoff: makeHandoff({ ageMs: 4 * 60_000 }) });
    expect(screen.getByText(/4 min ago/)).toBeDefined();
  });

  it('shows draft hint when activeDraft is non-empty', () => {
    renderBanner({ handoff: makeHandoff({ activeDraft: 'some text' }) });
    expect(screen.getByText(/unsent message restored/i)).toBeDefined();
  });

  it('does NOT show draft hint when activeDraft is null', () => {
    renderBanner({ handoff: makeHandoff({ activeDraft: null }) });
    expect(screen.queryByText(/unsent message restored/i)).toBeNull();
  });

  it('does NOT show draft hint when activeDraft is empty string', () => {
    renderBanner({ handoff: makeHandoff({ activeDraft: '' }) });
    expect(screen.queryByText(/unsent message restored/i)).toBeNull();
  });

  // --------------------------------------------------------------------------
  // Actions
  // --------------------------------------------------------------------------

  it('calls onResume with the full handoff object when Resume is clicked', async () => {
    const user = userEvent.setup();
    const handoff = makeHandoff({ lastDeviceKind: 'cli', activeDraft: 'draft' });
    const onResume = vi.fn();
    render(<HandoffBanner handoff={handoff} onResume={onResume} onDismiss={vi.fn()} />);

    await user.click(screen.getByTestId('handoff-resume-button'));

    expect(onResume).toHaveBeenCalledOnce();
    expect(onResume).toHaveBeenCalledWith(handoff);
  });

  it('calls onDismiss when "Start fresh" is clicked', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(<HandoffBanner handoff={makeHandoff()} onResume={vi.fn()} onDismiss={onDismiss} />);

    await user.click(screen.getByTestId('handoff-start-fresh-button'));

    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('calls onDismiss when the X dismiss button is clicked', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(<HandoffBanner handoff={makeHandoff()} onResume={vi.fn()} onDismiss={onDismiss} />);

    await user.click(screen.getByTestId('handoff-dismiss-button'));

    expect(onDismiss).toHaveBeenCalledOnce();
  });

  // --------------------------------------------------------------------------
  // Visibility / self-unmount
  // --------------------------------------------------------------------------

  it('hides itself after Resume is clicked (does not render twice)', async () => {
    const user = userEvent.setup();
    render(
      <HandoffBanner handoff={makeHandoff()} onResume={vi.fn()} onDismiss={vi.fn()} />,
    );

    expect(screen.getByTestId('handoff-banner')).toBeDefined();

    await user.click(screen.getByTestId('handoff-resume-button'));

    expect(screen.queryByTestId('handoff-banner')).toBeNull();
  });

  it('hides itself after Dismiss is clicked', async () => {
    const user = userEvent.setup();
    render(
      <HandoffBanner handoff={makeHandoff()} onResume={vi.fn()} onDismiss={vi.fn()} />,
    );

    await user.click(screen.getByTestId('handoff-dismiss-button'));

    expect(screen.queryByTestId('handoff-banner')).toBeNull();
  });
});
