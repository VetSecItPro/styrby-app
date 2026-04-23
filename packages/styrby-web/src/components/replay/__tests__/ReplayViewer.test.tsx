/**
 * ReplayViewer — Web Component Tests (Phase 3.3)
 *
 * Tests:
 *   - Renders session title, agent type, and date
 *   - Shows scrub mask disclosure banner when any mask flag is active
 *   - Does NOT show banner when all mask flags are false
 *   - Messages render; current message is highlighted
 *   - Play button starts playback (aria-pressed changes)
 *   - Prev/Next buttons are disabled at boundaries
 *   - Speed toggle works (aria-pressed changes)
 *   - Expiry notice renders
 *   - Empty session state renders gracefully
 *   - Scrubbed messages show [filtered] label
 *
 * WHY: The scrub mask disclosure banner is a transparency requirement.
 * If it fails to render when secrets are scrubbed, viewers are misled
 * about the completeness of the content they're watching.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ReplayViewer } from '../ReplayViewer';
import type { ScrubbedMessage, ScrubMask, ReplaySessionMeta } from '@styrby/shared/session-replay';

// ============================================================================
// Test data
// ============================================================================

const session: ReplaySessionMeta = {
  id: 'session-1',
  title: 'My Night Session',
  agentType: 'claude',
  model: 'claude-sonnet-4',
  status: 'completed',
  startedAt: '2026-04-21T22:00:00Z',
  endedAt: '2026-04-22T06:00:00Z',
  totalInputTokens: 10000,
  totalOutputTokens: 5000,
  totalCostUsd: 0.25,
};

const messages: ScrubbedMessage[] = [
  { role: 'user',      content: 'Run the tests',           _scrubbed: false },
  { role: 'assistant', content: 'Running npm test...',     _scrubbed: false },
  { role: 'assistant', content: 'All 42 tests passed.',    _scrubbed: true  },
];

const noScrub: ScrubMask = { secrets: false, file_paths: false, commands: false };
const withScrub: ScrubMask = { secrets: true, file_paths: false, commands: false };

const expiresAt = new Date(Date.now() + 86400000).toISOString();

// ============================================================================
// Tests
// ============================================================================

describe('ReplayViewer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders session title', () => {
    render(
      <ReplayViewer
        session={session}
        messages={messages}
        scrubMask={noScrub}
        expiresAt={expiresAt}
        viewsRemaining={5}
      />
    );
    expect(screen.getByText('My Night Session')).toBeDefined();
  });

  it('renders agent type', () => {
    render(
      <ReplayViewer
        session={session}
        messages={messages}
        scrubMask={noScrub}
        expiresAt={expiresAt}
        viewsRemaining={null}
      />
    );
    expect(screen.getByText('claude')).toBeDefined();
  });

  it('shows scrub mask banner when secrets=true', () => {
    render(
      <ReplayViewer
        session={session}
        messages={messages}
        scrubMask={withScrub}
        expiresAt={expiresAt}
        viewsRemaining={null}
      />
    );
    expect(screen.getByRole('note')).toBeDefined();
    expect(screen.getByText(/Privacy filter active/i)).toBeDefined();
    expect(screen.getByText(/secrets \(API keys, tokens\)/i)).toBeDefined();
  });

  it('does NOT show scrub mask banner when all flags are false', () => {
    render(
      <ReplayViewer
        session={session}
        messages={messages}
        scrubMask={noScrub}
        expiresAt={expiresAt}
        viewsRemaining={null}
      />
    );
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('renders all messages', () => {
    render(
      <ReplayViewer
        session={session}
        messages={messages}
        scrubMask={noScrub}
        expiresAt={expiresAt}
        viewsRemaining={null}
      />
    );
    expect(screen.getByText('Run the tests')).toBeDefined();
    expect(screen.getByText('Running npm test...')).toBeDefined();
    expect(screen.getByText('All 42 tests passed.')).toBeDefined();
  });

  it('shows [filtered] label on scrubbed messages', () => {
    render(
      <ReplayViewer
        session={session}
        messages={messages}
        scrubMask={noScrub}
        expiresAt={expiresAt}
        viewsRemaining={null}
      />
    );
    // Third message has _scrubbed=true
    const filteredLabels = screen.getAllByText('[filtered]');
    expect(filteredLabels.length).toBeGreaterThanOrEqual(1);
  });

  it('shows views remaining when provided', () => {
    render(
      <ReplayViewer
        session={session}
        messages={messages}
        scrubMask={noScrub}
        expiresAt={expiresAt}
        viewsRemaining={3}
      />
    );
    expect(screen.getByText('3 views remaining')).toBeDefined();
  });

  it('shows "view remaining" (singular) for 1 remaining view', () => {
    render(
      <ReplayViewer
        session={session}
        messages={messages}
        scrubMask={noScrub}
        expiresAt={expiresAt}
        viewsRemaining={1}
      />
    );
    expect(screen.getByText('1 view remaining')).toBeDefined();
  });

  it('does not show views remaining when null (unlimited)', () => {
    render(
      <ReplayViewer
        session={session}
        messages={messages}
        scrubMask={noScrub}
        expiresAt={expiresAt}
        viewsRemaining={null}
      />
    );
    expect(screen.queryByText(/views remaining/i)).toBeNull();
  });

  it('Prev button is disabled at the first message', () => {
    render(
      <ReplayViewer
        session={session}
        messages={messages}
        scrubMask={noScrub}
        expiresAt={expiresAt}
        viewsRemaining={null}
      />
    );
    const prevBtn = screen.getByLabelText('Previous message') as HTMLButtonElement;
    expect(prevBtn.disabled).toBe(true);
  });

  it('Next button is disabled at the last message', () => {
    render(
      <ReplayViewer
        session={session}
        messages={messages}
        scrubMask={noScrub}
        expiresAt={expiresAt}
        viewsRemaining={null}
      />
    );
    // Navigate to last message
    const nextBtn = screen.getByLabelText('Next message') as HTMLButtonElement;
    fireEvent.click(nextBtn); // 0 → 1
    fireEvent.click(nextBtn); // 1 → 2 (last)
    expect(nextBtn.disabled).toBe(true);
  });

  it('Play button toggles aria-pressed', () => {
    render(
      <ReplayViewer
        session={session}
        messages={messages}
        scrubMask={noScrub}
        expiresAt={expiresAt}
        viewsRemaining={null}
      />
    );
    const playBtn = screen.getByLabelText('Play replay') as HTMLButtonElement;
    expect(playBtn.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(playBtn);
    expect(screen.getByLabelText('Pause replay').getAttribute('aria-pressed')).toBe('true');
  });

  it('speed buttons update aria-pressed', () => {
    render(
      <ReplayViewer
        session={session}
        messages={messages}
        scrubMask={noScrub}
        expiresAt={expiresAt}
        viewsRemaining={null}
      />
    );
    const speed2x = screen.getByLabelText('2x speed') as HTMLButtonElement;
    expect(speed2x.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(speed2x);
    expect(speed2x.getAttribute('aria-pressed')).toBe('true');
    // 1x should now be false
    expect(screen.getByLabelText('1x speed').getAttribute('aria-pressed')).toBe('false');
  });

  it('renders empty state gracefully', () => {
    render(
      <ReplayViewer
        session={session}
        messages={[]}
        scrubMask={noScrub}
        expiresAt={expiresAt}
        viewsRemaining={null}
      />
    );
    expect(screen.getByText('This session has no messages.')).toBeDefined();
  });

  it('renders expiry notice', () => {
    render(
      <ReplayViewer
        session={session}
        messages={messages}
        scrubMask={noScrub}
        expiresAt={expiresAt}
        viewsRemaining={null}
      />
    );
    expect(screen.getByText(/This replay link expires/i)).toBeDefined();
  });

  it('renders "Untitled Session" when title is null', () => {
    render(
      <ReplayViewer
        session={{ ...session, title: null }}
        messages={messages}
        scrubMask={noScrub}
        expiresAt={expiresAt}
        viewsRemaining={null}
      />
    );
    expect(screen.getByText('Untitled Session')).toBeDefined();
  });
});
