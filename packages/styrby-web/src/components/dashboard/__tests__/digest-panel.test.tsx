/**
 * Tests for DigestPanel — covers the three render states (free/empty/populated)
 * and the formatRelative helper.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DigestPanel, formatRelative, type DigestRow } from '../digest-panel';

describe('DigestPanel', () => {
  it('shows the upgrade prompt for free users', () => {
    render(<DigestPanel digest={null} userTier="free" />);
    expect(screen.getByText(/upgrade to pro/i)).toBeInTheDocument();
    expect(screen.getByText(/get a weekly ai summary/i)).toBeInTheDocument();
  });

  it('shows the empty state for pro users with no digest yet', () => {
    render(<DigestPanel digest={null} userTier="pro" />);
    expect(screen.getByText(/your first digest will appear/i)).toBeInTheDocument();
    expect(screen.getByText(/this sunday/i)).toBeInTheDocument();
  });

  it('shows the empty state for growth users with no digest yet (daily cadence)', () => {
    render(<DigestPanel digest={null} userTier="growth" />);
    expect(screen.getByText(/tomorrow morning/i)).toBeInTheDocument();
  });

  it('renders the populated digest with content + session count', () => {
    const digest: DigestRow = {
      period: 'weekly',
      period_start: new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString(),
      period_end: new Date().toISOString(),
      session_count: 12,
      content: 'You spent the week refactoring billing and shipping the digest cron.',
      generated_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    };
    render(<DigestPanel digest={digest} userTier="pro" />);

    expect(screen.getByText('This week')).toBeInTheDocument();
    expect(screen.getByText('12 sessions')).toBeInTheDocument();
    expect(
      screen.getByText(/refactoring billing and shipping the digest cron/i)
    ).toBeInTheDocument();
  });

  it('shows fallback copy when content is null (LLM failed)', () => {
    const digest: DigestRow = {
      period: 'daily',
      period_start: new Date().toISOString(),
      period_end: new Date().toISOString(),
      session_count: 3,
      content: null,
      generated_at: new Date().toISOString(),
    };
    render(<DigestPanel digest={digest} userTier="growth" />);
    expect(screen.getByText(/being generated/i)).toBeInTheDocument();
  });
});

describe('formatRelative', () => {
  const now = new Date('2026-05-05T12:00:00Z');
  it('reports "just now" for sub-minute deltas', () => {
    expect(formatRelative(new Date(now.getTime() - 30_000).toISOString(), now)).toBe('just now');
  });
  it('reports minutes', () => {
    expect(formatRelative(new Date(now.getTime() - 5 * 60_000).toISOString(), now)).toBe('5 minutes ago');
  });
  it('reports hours', () => {
    expect(formatRelative(new Date(now.getTime() - 3 * 3600_000).toISOString(), now)).toBe('3 hours ago');
  });
  it('reports days', () => {
    expect(formatRelative(new Date(now.getTime() - 2 * 86400_000).toISOString(), now)).toBe('2 days ago');
  });
  it('reports weeks', () => {
    expect(formatRelative(new Date(now.getTime() - 14 * 86400_000).toISOString(), now)).toBe('2 weeks ago');
  });
});
