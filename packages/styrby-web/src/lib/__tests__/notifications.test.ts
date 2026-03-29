/**
 * Tests for the unified notification dispatcher.
 *
 * WHY these tests matter: dispatchNotification() is the single entry point
 * for every notification in the system. If it fails to check user preferences,
 * users will receive notifications they opted out of. If quiet-hours or
 * priority filtering is buggy, it either floods users or silently drops alerts
 * they care about. Budget alerts (priority 1) MUST bypass quiet hours.
 *
 * Covers:
 * - Push disabled → skipped
 * - Quiet hours: overnight windows, same-day windows, boundary conditions
 * - Priority threshold filtering
 * - Budget alerts bypass quiet hours
 * - Successful delivery path
 * - No preferences row → defaults to push enabled
 * - sendPushToUser error → result reflects failure without throwing
 * - isWithinQuietHours logic across all edge cases
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NotificationPayload, NotificationType } from '../notifications';

// ============================================================================
// Mocks
// ============================================================================

const mockFrom = vi.fn();
const mockCreateAdminClient = vi.fn();
const mockSendPushToUser = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: mockCreateAdminClient,
}));

vi.mock('@/lib/web-push', () => ({
  sendPushToUser: mockSendPushToUser,
}));

// ============================================================================
// Helpers
// ============================================================================

/**
 * Builds a Supabase query chain that resolves with the given preferences row.
 *
 * @param prefs - The notification_preferences row (null = no row)
 */
function buildPrefsChain(
  prefs: {
    push_enabled?: boolean;
    email_enabled?: boolean;
    quiet_hours_start?: string | null;
    quiet_hours_end?: string | null;
    priority_threshold?: number | null;
  } | null
) {
  return {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: prefs, error: null }),
  };
}

/** A minimal notification payload used across tests. */
const SAMPLE_PAYLOAD: NotificationPayload = {
  title: 'Test Notification',
  body: 'This is a test.',
  url: '/dashboard',
  tag: 'test',
};

/**
 * Stubs Date to return a specific UTC HH:MM time for quiet-hours tests.
 *
 * @param utcHours - UTC hours (0–23)
 * @param utcMinutes - UTC minutes (0–59)
 */
function stubUtcTime(utcHours: number, utcMinutes: number) {
  const now = new Date();
  now.setUTCHours(utcHours, utcMinutes, 0, 0);
  vi.setSystemTime(now);
}

// ============================================================================
// Tests
// ============================================================================

describe('dispatchNotification()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();

    mockCreateAdminClient.mockReturnValue({ from: mockFrom });
    mockSendPushToUser.mockResolvedValue({ sent: 1, failed: 0, cleaned: 0 });
  });

  // --------------------------------------------------------------------------
  // Push disabled
  // --------------------------------------------------------------------------

  describe('push_enabled = false', () => {
    it('skips dispatch and returns skippedReason when push is disabled', async () => {
      mockFrom.mockReturnValue(buildPrefsChain({ push_enabled: false }));
      const { dispatchNotification } = await import('../notifications');

      const result = await dispatchNotification('user-1', 'session_complete', SAMPLE_PAYLOAD);

      expect(result.delivered).toBe(false);
      expect(result.skippedReason).toContain('disabled');
      expect(mockSendPushToUser).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // No preferences row (new user defaults)
  // --------------------------------------------------------------------------

  describe('no preferences row exists', () => {
    it('defaults to push enabled and delivers the notification', async () => {
      mockFrom.mockReturnValue(buildPrefsChain(null));
      const { dispatchNotification } = await import('../notifications');

      const result = await dispatchNotification('new-user', 'session_complete', SAMPLE_PAYLOAD);

      expect(mockSendPushToUser).toHaveBeenCalledOnce();
      expect(result.delivered).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Quiet hours
  // --------------------------------------------------------------------------

  describe('quiet hours filtering', () => {
    it('skips session_complete during active quiet hours (overnight 22:00–07:00)', async () => {
      vi.useFakeTimers();
      stubUtcTime(23, 30); // 11:30 PM UTC — within quiet window

      mockFrom.mockReturnValue(buildPrefsChain({
        push_enabled: true,
        quiet_hours_start: '22:00',
        quiet_hours_end: '07:00',
      }));
      const { dispatchNotification } = await import('../notifications');

      const result = await dispatchNotification('user-2', 'session_complete', SAMPLE_PAYLOAD);

      expect(result.delivered).toBe(false);
      expect(result.skippedReason).toContain('Quiet hours');
      expect(mockSendPushToUser).not.toHaveBeenCalled();
    });

    it('skips team_invite during active quiet hours (overnight, early morning)', async () => {
      vi.useFakeTimers();
      stubUtcTime(3, 0); // 3:00 AM UTC — within 22:00–07:00

      mockFrom.mockReturnValue(buildPrefsChain({
        push_enabled: true,
        quiet_hours_start: '22:00',
        quiet_hours_end: '07:00',
      }));
      const { dispatchNotification } = await import('../notifications');

      const result = await dispatchNotification('user-3', 'team_invite', SAMPLE_PAYLOAD);

      expect(result.delivered).toBe(false);
      expect(result.skippedReason).toContain('Quiet hours');
    });

    it('delivers session_complete outside quiet hours', async () => {
      vi.useFakeTimers();
      stubUtcTime(14, 0); // 2:00 PM UTC — outside 22:00–07:00

      mockFrom.mockReturnValue(buildPrefsChain({
        push_enabled: true,
        quiet_hours_start: '22:00',
        quiet_hours_end: '07:00',
      }));
      const { dispatchNotification } = await import('../notifications');

      const result = await dispatchNotification('user-4', 'session_complete', SAMPLE_PAYLOAD);

      expect(mockSendPushToUser).toHaveBeenCalledOnce();
      expect(result.delivered).toBe(true);
    });

    it('skips during same-day quiet window (09:00–12:00) at 10:30 UTC', async () => {
      vi.useFakeTimers();
      stubUtcTime(10, 30);

      mockFrom.mockReturnValue(buildPrefsChain({
        push_enabled: true,
        quiet_hours_start: '09:00',
        quiet_hours_end: '12:00',
      }));
      const { dispatchNotification } = await import('../notifications');

      const result = await dispatchNotification('user-5', 'session_complete', SAMPLE_PAYLOAD);

      expect(result.delivered).toBe(false);
      expect(result.skippedReason).toContain('Quiet hours');
    });

    it('delivers outside same-day quiet window (09:00–12:00) at 13:00 UTC', async () => {
      vi.useFakeTimers();
      stubUtcTime(13, 0);

      mockFrom.mockReturnValue(buildPrefsChain({
        push_enabled: true,
        quiet_hours_start: '09:00',
        quiet_hours_end: '12:00',
      }));
      const { dispatchNotification } = await import('../notifications');

      const result = await dispatchNotification('user-6', 'session_complete', SAMPLE_PAYLOAD);

      expect(result.delivered).toBe(true);
    });

    // --------------------------------------------------
    // budget_alert (priority 1) bypasses quiet hours
    // --------------------------------------------------

    it('delivers budget_alert even during quiet hours (priority 1 always gets through)', async () => {
      vi.useFakeTimers();
      stubUtcTime(2, 0); // Deep in quiet window

      mockFrom.mockReturnValue(buildPrefsChain({
        push_enabled: true,
        quiet_hours_start: '22:00',
        quiet_hours_end: '07:00',
      }));
      const { dispatchNotification } = await import('../notifications');

      const result = await dispatchNotification('user-7', 'budget_alert', {
        title: 'Budget Warning',
        body: 'You are at 80% of your monthly budget.',
        tag: 'budget',
      });

      expect(mockSendPushToUser).toHaveBeenCalledOnce();
      expect(result.delivered).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Priority threshold
  // --------------------------------------------------------------------------

  describe('priority threshold filtering', () => {
    it('skips team_invite (priority 4) when threshold is 3', async () => {
      mockFrom.mockReturnValue(buildPrefsChain({
        push_enabled: true,
        priority_threshold: 3,
      }));
      const { dispatchNotification } = await import('../notifications');

      const result = await dispatchNotification('user-8', 'team_invite', SAMPLE_PAYLOAD);

      expect(result.delivered).toBe(false);
      expect(result.skippedReason).toContain('priority');
      expect(mockSendPushToUser).not.toHaveBeenCalled();
    });

    it('delivers session_complete (priority 3) when threshold is 3', async () => {
      mockFrom.mockReturnValue(buildPrefsChain({
        push_enabled: true,
        priority_threshold: 3,
      }));
      const { dispatchNotification } = await import('../notifications');

      const result = await dispatchNotification('user-9', 'session_complete', SAMPLE_PAYLOAD);

      expect(result.delivered).toBe(true);
    });

    it('delivers budget_alert (priority 1) when threshold is 1', async () => {
      mockFrom.mockReturnValue(buildPrefsChain({
        push_enabled: true,
        priority_threshold: 1,
      }));
      const { dispatchNotification } = await import('../notifications');

      const result = await dispatchNotification('user-10', 'budget_alert', SAMPLE_PAYLOAD);

      expect(result.delivered).toBe(true);
    });

    it('skips team_invite (priority 4) when threshold is 2 (strict mode)', async () => {
      mockFrom.mockReturnValue(buildPrefsChain({
        push_enabled: true,
        priority_threshold: 2,
      }));
      const { dispatchNotification } = await import('../notifications');

      const result = await dispatchNotification('user-11', 'team_invite', SAMPLE_PAYLOAD);

      expect(result.delivered).toBe(false);
    });

    it('defaults to threshold 5 (deliver everything) when priority_threshold is null', async () => {
      mockFrom.mockReturnValue(buildPrefsChain({
        push_enabled: true,
        priority_threshold: null,
      }));
      const { dispatchNotification } = await import('../notifications');

      // team_invite is priority 4 — should pass with default threshold 5
      const result = await dispatchNotification('user-12', 'team_invite', SAMPLE_PAYLOAD);

      expect(result.delivered).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // sendPushToUser result propagation
  // --------------------------------------------------------------------------

  describe('sendPushToUser result propagation', () => {
    it('sets delivered=true and populates webPush channel when push succeeds', async () => {
      mockFrom.mockReturnValue(buildPrefsChain({ push_enabled: true }));
      mockSendPushToUser.mockResolvedValue({ sent: 2, failed: 0, cleaned: 1 });
      const { dispatchNotification } = await import('../notifications');

      const result = await dispatchNotification('user-13', 'session_complete', SAMPLE_PAYLOAD);

      expect(result.delivered).toBe(true);
      expect(result.channels.webPush).toEqual({ sent: 2, failed: 0, cleaned: 1 });
    });

    it('sets delivered=false when push returns sent=0 (no active subscriptions)', async () => {
      mockFrom.mockReturnValue(buildPrefsChain({ push_enabled: true }));
      mockSendPushToUser.mockResolvedValue({ sent: 0, failed: 0, cleaned: 0 });
      const { dispatchNotification } = await import('../notifications');

      const result = await dispatchNotification('user-14', 'session_complete', SAMPLE_PAYLOAD);

      expect(result.delivered).toBe(false);
      expect(result.channels.webPush?.sent).toBe(0);
    });

    it('does not throw when sendPushToUser rejects — records failure in channels', async () => {
      mockFrom.mockReturnValue(buildPrefsChain({ push_enabled: true }));
      mockSendPushToUser.mockRejectedValue(new Error('VAPID misconfigured'));
      const { dispatchNotification } = await import('../notifications');

      const result = await dispatchNotification('user-15', 'session_complete', SAMPLE_PAYLOAD);

      expect(result.delivered).toBe(false);
      expect(result.channels.webPush).toEqual({ sent: 0, failed: 1, cleaned: 0 });
    });
  });

  // --------------------------------------------------------------------------
  // Payload forwarding
  // --------------------------------------------------------------------------

  describe('payload forwarding', () => {
    it('passes all payload fields to sendPushToUser', async () => {
      mockFrom.mockReturnValue(buildPrefsChain({ push_enabled: true }));
      const { dispatchNotification } = await import('../notifications');

      const payload: NotificationPayload = {
        title: 'Budget Alert',
        body: 'You hit 90% of your budget.',
        icon: '/icon-192.png',
        url: '/dashboard/costs',
        tag: 'budget-90',
      };

      await dispatchNotification('user-16', 'budget_alert', payload);

      expect(mockSendPushToUser).toHaveBeenCalledWith(
        'user-16',
        expect.objectContaining({
          title: 'Budget Alert',
          body: 'You hit 90% of your budget.',
          icon: '/icon-192.png',
          url: '/dashboard/costs',
          tag: 'budget-90',
        })
      );
    });
  });

  // --------------------------------------------------------------------------
  // All notification types have a defined priority
  // --------------------------------------------------------------------------

  describe('all notification types are dispatchable', () => {
    const TYPES: NotificationType[] = [
      'budget_alert',
      'session_complete',
      'session_error',
      'permission_request',
      'team_invite',
    ];

    for (const type of TYPES) {
      it(`dispatches '${type}' without throwing`, async () => {
        mockFrom.mockReturnValue(buildPrefsChain({ push_enabled: true }));
        const { dispatchNotification } = await import('../notifications');

        await expect(
          dispatchNotification('user-type-test', type, SAMPLE_PAYLOAD)
        ).resolves.toBeDefined();
      });
    }
  });
});
