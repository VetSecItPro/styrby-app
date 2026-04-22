/**
 * Tests for useInAppNotifications hook.
 *
 * WHY: The notification feed is a retention-critical surface. Bugs in
 * pagination, real-time sync, or unread count tracking directly hurt user
 * trust in the in-app notification feed.
 *
 * Covers:
 * - Initial load returns notifications and loading=false after fetch
 * - Filters out sentinel rows (budget_threshold + __threshold_check__ title)
 * - markAsRead performs optimistic update, reduces unreadCount
 * - markAllAsRead sets unreadCount to 0
 * - hasMore=true when page is full (20 items), false when partial
 * - Returns error state when fetch fails
 * - Cleans up realtime channel on unmount
 */

import { renderHook, act, waitFor } from '@testing-library/react-native';
import { useInAppNotifications } from '../useInAppNotifications';

// ============================================================================
// Mocks
// ============================================================================

const mockGetUser = jest.fn();
const mockRemoveChannel = jest.fn();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockChannel: any = {
  on: jest.fn().mockReturnThis(),
  subscribe: jest.fn().mockReturnThis(),
};

// Mutable store for per-test notification data
let mockNotificationsData: unknown[] | null = [];
let mockNotificationsError: { message: string } | null = null;

jest.mock('../lib/supabase', () => ({
  supabase: {
    auth: {
      getUser: () => mockGetUser(),
    },
    from: (table: string) => {
      if (table === 'notifications') {
        return {
          select: jest.fn().mockReturnThis(),
          order: jest.fn().mockReturnThis(),
          range: jest.fn().mockResolvedValue({
            data: mockNotificationsData,
            error: mockNotificationsError,
          }),
          update: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnThis(),
            is: jest.fn().mockResolvedValue({ data: null, error: null }),
          }),
          is: jest.fn().mockReturnValue({
            update: jest.fn().mockReturnValue({
              is: jest.fn().mockResolvedValue({ data: null, error: null }),
            }),
          }),
        };
      }
      return {};
    },
    channel: jest.fn().mockReturnValue(mockChannel),
    removeChannel: mockRemoveChannel,
  },
}));

// ============================================================================
// Fixtures
// ============================================================================

function makeNotification(overrides: Record<string, unknown> = {}) {
  return {
    id: 'notif-1',
    user_id: 'user-1',
    type: 'agent_finished',
    title: 'Claude Code session finished',
    body: 'Refactored auth module',
    read_at: null,
    created_at: new Date().toISOString(),
    metadata: null,
    ...overrides,
  };
}

// ============================================================================
// Setup
// ============================================================================

beforeEach(() => {
  jest.clearAllMocks();
  mockNotificationsData = [];
  mockNotificationsError = null;

  mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } } });

  mockChannel.on.mockReturnThis();
  mockChannel.subscribe.mockReturnThis();
});

// ============================================================================
// Tests
// ============================================================================

describe('useInAppNotifications', () => {
  it('returns empty list and loading=false after successful fetch', async () => {
    mockNotificationsData = [];
    const { result } = renderHook(() => useInAppNotifications());

    expect(result.current.loading).toBe(true);

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.notifications).toHaveLength(0);
    expect(result.current.unreadCount).toBe(0);
  });

  it('loads notifications and counts unread correctly', async () => {
    mockNotificationsData = [
      makeNotification({ id: 'n1', read_at: null }),
      makeNotification({ id: 'n2', read_at: new Date().toISOString() }),
      makeNotification({ id: 'n3', read_at: null }),
    ];

    const { result } = renderHook(() => useInAppNotifications());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.notifications).toHaveLength(3);
    expect(result.current.unreadCount).toBe(2);
  });

  it('filters out sentinel budget_threshold rows', async () => {
    mockNotificationsData = [
      makeNotification({ id: 'n1', type: 'agent_finished' }),
      makeNotification({
        id: 'sentinel',
        type: 'budget_threshold',
        title: '__threshold_check__',
      }),
    ];

    const { result } = renderHook(() => useInAppNotifications());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.notifications).toHaveLength(1);
    expect(result.current.notifications[0].id).toBe('n1');
  });

  it('returns error state when fetch fails', async () => {
    mockNotificationsError = { message: 'DB connection failed' };
    mockNotificationsData = null;

    const { result } = renderHook(() => useInAppNotifications());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe('DB connection failed');
  });

  it('markAsRead applies optimistic update and reduces unreadCount', async () => {
    mockNotificationsData = [makeNotification({ id: 'n1', read_at: null })];

    const { result } = renderHook(() => useInAppNotifications());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.unreadCount).toBe(1);

    await act(async () => {
      await result.current.markAsRead('n1');
    });

    expect(result.current.notifications[0].read_at).not.toBeNull();
    expect(result.current.unreadCount).toBe(0);
  });

  it('markAllAsRead sets unreadCount to 0', async () => {
    mockNotificationsData = [
      makeNotification({ id: 'n1', read_at: null }),
      makeNotification({ id: 'n2', read_at: null }),
    ];

    const { result } = renderHook(() => useInAppNotifications());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.unreadCount).toBe(2);

    await act(async () => {
      await result.current.markAllAsRead();
    });

    expect(result.current.unreadCount).toBe(0);
  });

  it('sets hasMore=true when page is full (20 items)', async () => {
    mockNotificationsData = Array.from({ length: 20 }, (_, i) =>
      makeNotification({ id: `n${i}` })
    );

    const { result } = renderHook(() => useInAppNotifications());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.hasMore).toBe(true);
  });

  it('sets hasMore=false when page is partial', async () => {
    mockNotificationsData = [makeNotification({ id: 'n1' })];

    const { result } = renderHook(() => useInAppNotifications());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.hasMore).toBe(false);
  });

  it('cleans up realtime channel on unmount', async () => {
    mockNotificationsData = [];
    const { unmount } = renderHook(() => useInAppNotifications());

    await waitFor(() => {
      expect(mockChannel.subscribe).toHaveBeenCalled();
    });

    unmount();
    expect(mockRemoveChannel).toHaveBeenCalled();
  });
});
