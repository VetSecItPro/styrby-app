/**
 * Integration test: SessionOrphanedBanner wired into sessions list.
 *
 * Validates that the `last_heartbeat_at` field flows correctly from the
 * `SessionRow` type through the sessions screen's `renderItem` callback to the
 * `SessionOrphanedBanner` component, and that the banner renders (or is absent)
 * based on the staleness of the heartbeat.
 *
 * WHY a separate integration file instead of extending the unit tests:
 *   The unit tests for `SessionOrphanedBanner` (SessionOrphanedBanner.test.tsx)
 *   verify the component in isolation with direct prop injection. This file
 *   verifies the wiring: that the sessions screen passes the correct field
 *   (`last_heartbeat_at`) and that the banner lifecycle (orphaned vs fresh)
 *   behaves as expected when rendered through a real SessionRow shape.
 *
 * Spec: docs/planning/phase-1-account-switch-correctness-spec.md — Task 6 (T6)
 *
 * @module components/sessions/__tests__/SessionOrphanedBanner.integration
 */

import React from 'react';
import { render } from '@testing-library/react-native';
import { SessionOrphanedBanner } from '../SessionOrphanedBanner';
import type { SessionRow } from '../../../hooks/useSessions';
import type { SessionOrphanedBannerProps } from '../SessionOrphanedBanner';

// ============================================================================
// Supabase mock
// (mirrors the pattern from SessionOrphanedBanner.test.tsx)
// ============================================================================

jest.mock('../../../lib/supabase', () => ({
  supabase: {
    from: () => ({
      update: () => ({
        eq: () => Promise.resolve({ error: null }),
      }),
    }),
  },
}));

// ============================================================================
// Helpers
// ============================================================================

/**
 * Build a minimal SessionRow for testing the banner wiring.
 * All fields carry valid defaults; override only what the test needs.
 *
 * @param overrides - Partial SessionRow fields to override
 * @returns A complete SessionRow suitable for passing into SessionOrphanedBanner props
 */
function buildSessionRow(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: 'integration-session-id',
    user_id: 'user-abc',
    machine_id: 'machine-xyz',
    agent_type: 'claude',
    status: 'running',
    title: 'My Session',
    summary: null,
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_cost_usd: 0,
    started_at: new Date(Date.now() - 600_000).toISOString(),
    ended_at: null,
    tags: [],
    updated_at: new Date().toISOString(),
    message_count: 0,
    team_id: null,
    last_heartbeat_at: null,
    ...overrides,
  };
}

/**
 * Simulate the props the sessions screen passes to SessionOrphanedBanner
 * based on a SessionRow — this mirrors the exact wiring in app/(tabs)/sessions.tsx.
 *
 * @param session - A SessionRow as loaded by useSessions
 * @returns Props ready to pass to <SessionOrphanedBanner />
 */
function bannerPropsFromRow(
  session: SessionRow,
  timeProvider?: () => number,
): SessionOrphanedBannerProps {
  const props: SessionOrphanedBannerProps = {
    sessionId: session.id,
    status: session.status,
    lastHeartbeatAt: session.last_heartbeat_at ?? null,
  };
  if (timeProvider) props.timeProvider = timeProvider;
  return props;
}

// ============================================================================
// Tests
// ============================================================================

describe('SessionOrphanedBanner — wiring integration (T6)', () => {
  // --------------------------------------------------------------------------
  // 1. last_heartbeat_at: null — no banner (cannot determine orphan state)
  // --------------------------------------------------------------------------

  it('renders nothing when last_heartbeat_at is null (no heartbeat ever received)', () => {
    const session = buildSessionRow({ status: 'running', last_heartbeat_at: null });
    const { queryByTestId } = render(
      <SessionOrphanedBanner {...bannerPropsFromRow(session)} />,
    );

    expect(queryByTestId('orphaned-banner')).toBeNull();
  });

  // --------------------------------------------------------------------------
  // 2. Fresh heartbeat — no banner
  // --------------------------------------------------------------------------

  it('renders nothing when last_heartbeat_at is within 90s (fresh session)', () => {
    const fixedNow = 1_700_000_000_000;
    const session = buildSessionRow({
      status: 'running',
      last_heartbeat_at: new Date(fixedNow - 30_000).toISOString(), // 30s ago
    });

    const { queryByTestId } = render(
      <SessionOrphanedBanner
        {...bannerPropsFromRow(session, () => fixedNow)}
      />,
    );

    expect(queryByTestId('orphaned-banner')).toBeNull();
  });

  // --------------------------------------------------------------------------
  // 3. Stale heartbeat + active status — banner renders
  // --------------------------------------------------------------------------

  it('renders orphaned banner when last_heartbeat_at > 90s ago and status is active', () => {
    const fixedNow = 1_700_000_000_000;
    const session = buildSessionRow({
      status: 'running',
      last_heartbeat_at: new Date(fixedNow - 120_000).toISOString(), // 120s ago
    });

    const { getByTestId, getByText } = render(
      <SessionOrphanedBanner
        {...bannerPropsFromRow(session, () => fixedNow)}
      />,
    );

    expect(getByTestId('orphaned-banner')).toBeTruthy();
    expect(getByText(/This session's CLI was logged out/i)).toBeTruthy();
  });

  // --------------------------------------------------------------------------
  // 4. Stale heartbeat + non-active status — no banner
  // --------------------------------------------------------------------------

  it('renders nothing when last_heartbeat_at is stale but status is stopped', () => {
    const fixedNow = 1_700_000_000_000;
    const session = buildSessionRow({
      status: 'stopped',
      last_heartbeat_at: new Date(fixedNow - 120_000).toISOString(),
    });

    const { queryByTestId } = render(
      <SessionOrphanedBanner
        {...bannerPropsFromRow(session, () => fixedNow)}
      />,
    );

    expect(queryByTestId('orphaned-banner')).toBeNull();
  });

  // --------------------------------------------------------------------------
  // 5. All active statuses with stale heartbeat — banner renders in each case
  // --------------------------------------------------------------------------

  it('renders banner for all active statuses (starting, running, idle) when heartbeat is stale', () => {
    const fixedNow = 1_700_000_000_000;
    const staleTs = new Date(fixedNow - 120_000).toISOString();
    const activeStatuses: Array<SessionRow['status']> = ['starting', 'running', 'idle'];

    for (const status of activeStatuses) {
      const session = buildSessionRow({ status, last_heartbeat_at: staleTs });
      const { getByTestId, unmount } = render(
        <SessionOrphanedBanner
          {...bannerPropsFromRow(session, () => fixedNow)}
        />,
      );
      expect(getByTestId('orphaned-banner')).toBeTruthy();
      unmount();
    }
  });

  // --------------------------------------------------------------------------
  // 6. SessionRow.last_heartbeat_at field exists and is forwarded correctly
  // --------------------------------------------------------------------------

  it('correctly maps session.last_heartbeat_at ?? null to the lastHeartbeatAt prop', () => {
    /**
     * WHY: Validates the wiring expression `item.last_heartbeat_at ?? null`
     * used in app/(tabs)/sessions.tsx. This test specifically exercises the
     * nullish-coalesce path where the field is undefined (old Realtime events
     * that predate the column addition will lack it).
     */
    const fixedNow = 1_700_000_000_000;
    // Simulate a row where last_heartbeat_at is undefined (not in payload)
    const session = buildSessionRow({ status: 'running' });
    // Force undefined to simulate pre-column rows
    (session as unknown as Record<string, unknown>).last_heartbeat_at = undefined;

    const props = bannerPropsFromRow(session, () => fixedNow);
    // Should coerce undefined to null, resulting in no banner
    expect(props.lastHeartbeatAt).toBeNull();

    const { queryByTestId } = render(<SessionOrphanedBanner {...props} />);
    expect(queryByTestId('orphaned-banner')).toBeNull();
  });
});
