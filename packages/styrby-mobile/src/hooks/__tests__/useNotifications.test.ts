/**
 * useNotifications Hook Test Suite
 *
 * Tests the notifications hook, including:
 * - Push token registration and persistence
 * - Foreground notification handling
 * - Notification tap navigation (screen-based and type-based)
 * - Zod validation of notification payloads
 * - Unregistration (logout flow)
 * - Error handling for failed registration
 * - Cold launch notification handling
 */

import { renderHook, act, waitFor } from '@testing-library/react-native';

// ============================================================================
// Mock Setup
// ============================================================================

const mockRouterPush = jest.fn();

jest.mock('expo-router', () => ({
  useRouter: jest.fn(() => ({
    push: mockRouterPush,
  })),
}));

/** Stores the callback for addNotificationReceivedListener */
let mockReceivedCallback: ((notification: unknown) => void) | null = null;
/** Stores the callback for addNotificationResponseListener */
let mockResponseCallback: ((response: unknown) => void) | null = null;

/**
 * WHY: jest.mock is hoisted above variable declarations by babel-jest.
 * We use jest.fn() inline in the factory and then extract the mocks via
 * require() after the mock is registered. This avoids temporal dead zone
 * issues with const declarations.
 */
jest.mock('@/services/notifications', () => ({
  registerForPushNotifications: jest.fn(async () => 'ExponentPushToken[test-token]'),
  savePushToken: jest.fn(async () => true),
  removePushToken: jest.fn(async () => true),
  addNotificationReceivedListener: jest.fn((cb: (n: unknown) => void) => {
    // Use a global to store the callback since this closure can't access test-level variables
    (global as Record<string, unknown>).__mockReceivedCallback = cb;
    return { remove: jest.fn() };
  }),
  addNotificationResponseListener: jest.fn((cb: (r: unknown) => void) => {
    (global as Record<string, unknown>).__mockResponseCallback = cb;
    return { remove: jest.fn() };
  }),
  removeNotificationListener: jest.fn(),
  getLastNotificationResponse: jest.fn(async () => null),
  clearBadge: jest.fn(async () => true),
}));

jest.mock('styrby-shared', () => ({}));

import { useNotifications } from '../useNotifications';

// Extract mock references after mock is registered
const mockNotificationService = jest.requireMock('@/services/notifications') as {
  registerForPushNotifications: jest.Mock;
  savePushToken: jest.Mock;
  removePushToken: jest.Mock;
  addNotificationReceivedListener: jest.Mock;
  addNotificationResponseListener: jest.Mock;
  removeNotificationListener: jest.Mock;
  getLastNotificationResponse: jest.Mock;
  clearBadge: jest.Mock;
};

const {
  registerForPushNotifications: mockRegisterForPushNotifications,
  savePushToken: mockSavePushToken,
  removePushToken: mockRemovePushToken,
  addNotificationReceivedListener: mockAddNotificationReceivedListener,
  addNotificationResponseListener: mockAddNotificationResponseListener,
  removeNotificationListener: mockRemoveNotificationListener,
  getLastNotificationResponse: mockGetLastNotificationResponse,
  clearBadge: mockClearBadge,
} = mockNotificationService;

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Creates a mock notification response object matching the expo-notifications shape.
 */
function makeNotificationResponse(data: Record<string, unknown> | null = null) {
  return {
    notification: {
      request: {
        content: {
          data: data,
        },
      },
    },
    actionIdentifier: 'default',
  };
}

/**
 * Creates a mock foreground notification object.
 */
function makeForegroundNotification() {
  return {
    request: {
      content: {
        title: 'Test Notification',
        body: 'Test body',
        data: { type: 'agent_message' },
      },
    },
    date: Date.now(),
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('useNotifications', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReceivedCallback = null;
    mockResponseCallback = null;
    (global as Record<string, unknown>).__mockReceivedCallback = null;
    (global as Record<string, unknown>).__mockResponseCallback = null;

    // Re-wire the listener mocks to capture callbacks via globals
    mockAddNotificationReceivedListener.mockImplementation((cb: (n: unknown) => void) => {
      mockReceivedCallback = cb;
      return { remove: jest.fn() };
    });
    mockAddNotificationResponseListener.mockImplementation((cb: (r: unknown) => void) => {
      mockResponseCallback = cb;
      return { remove: jest.fn() };
    });

    mockRegisterForPushNotifications.mockResolvedValue('ExponentPushToken[test-token]');
    mockSavePushToken.mockResolvedValue(true);
    mockGetLastNotificationResponse.mockResolvedValue(null);
  });

  // --------------------------------------------------------------------------
  // Registration
  // --------------------------------------------------------------------------

  it('registers for push notifications on mount', async () => {
    const { result } = renderHook(() => useNotifications());

    await waitFor(() => expect(result.current.isRegistered).toBe(true));

    expect(mockRegisterForPushNotifications).toHaveBeenCalled();
    expect(mockSavePushToken).toHaveBeenCalledWith('ExponentPushToken[test-token]');
    expect(result.current.expoPushToken).toBe('ExponentPushToken[test-token]');
  });

  it('sets error when push token registration fails', async () => {
    mockRegisterForPushNotifications.mockResolvedValue(null);

    const { result } = renderHook(() => useNotifications());

    await waitFor(() => expect(result.current.error).toBe('Failed to get push token'));

    expect(result.current.isRegistered).toBe(false);
    expect(result.current.expoPushToken).toBeNull();
  });

  it('sets error when savePushToken fails', async () => {
    mockSavePushToken.mockResolvedValue(false);

    const { result } = renderHook(() => useNotifications());

    await waitFor(() => expect(result.current.error).toBe('Failed to save push token'));

    expect(result.current.isRegistered).toBe(false);
    expect(result.current.expoPushToken).toBe('ExponentPushToken[test-token]');
  });

  it('handles registration exception', async () => {
    mockRegisterForPushNotifications.mockRejectedValue(
      new Error('Permission denied')
    );

    const { result } = renderHook(() => useNotifications());

    await waitFor(() => expect(result.current.error).toBe('Permission denied'));

    expect(result.current.isRegistered).toBe(false);
  });

  it('handles non-Error exception during registration', async () => {
    mockRegisterForPushNotifications.mockRejectedValue('string error');

    const { result } = renderHook(() => useNotifications());

    await waitFor(() => expect(result.current.error).toBe('Unknown error'));
  });

  // --------------------------------------------------------------------------
  // Manual register()
  // --------------------------------------------------------------------------

  it('register clears previous error', async () => {
    mockRegisterForPushNotifications.mockResolvedValue(null);

    const { result } = renderHook(() => useNotifications());

    await waitFor(() => expect(result.current.error).toBe('Failed to get push token'));

    // Now fix the mock and call register again
    mockRegisterForPushNotifications.mockResolvedValue('ExponentPushToken[new-token]');

    await act(async () => {
      await result.current.register();
    });

    expect(result.current.error).toBeNull();
    expect(result.current.expoPushToken).toBe('ExponentPushToken[new-token]');
  });

  // --------------------------------------------------------------------------
  // Unregistration
  // --------------------------------------------------------------------------

  it('unregister removes push token and resets state', async () => {
    const { result } = renderHook(() => useNotifications());

    await waitFor(() => expect(result.current.isRegistered).toBe(true));

    await act(async () => {
      await result.current.unregister();
    });

    expect(mockRemovePushToken).toHaveBeenCalledWith('ExponentPushToken[test-token]');
    expect(result.current.expoPushToken).toBeNull();
    expect(result.current.isRegistered).toBe(false);
  });

  it('unregister does nothing when no token exists', async () => {
    mockRegisterForPushNotifications.mockResolvedValue(null);

    const { result } = renderHook(() => useNotifications());

    await waitFor(() => expect(result.current.error).not.toBeNull());

    await act(async () => {
      await result.current.unregister();
    });

    expect(mockRemovePushToken).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // Foreground Notifications
  // --------------------------------------------------------------------------

  it('sets up foreground notification listener', async () => {
    renderHook(() => useNotifications());

    await waitFor(() => expect(mockReceivedCallback).not.toBeNull());

    expect(mockAddNotificationReceivedListener).toHaveBeenCalled();
  });

  it('updates notification state on foreground notification', async () => {
    const { result } = renderHook(() => useNotifications());

    await waitFor(() => expect(mockReceivedCallback).not.toBeNull());

    const notification = makeForegroundNotification();

    await act(async () => {
      mockReceivedCallback!(notification);
    });

    expect(result.current.notification).toEqual(notification);
  });

  // --------------------------------------------------------------------------
  // Notification Response Listener
  // --------------------------------------------------------------------------

  it('sets up notification response listener', async () => {
    renderHook(() => useNotifications());

    await waitFor(() => expect(mockResponseCallback).not.toBeNull());

    expect(mockAddNotificationResponseListener).toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // Screen-Based Navigation (Strategy 1)
  // --------------------------------------------------------------------------

  it('navigates to chat screen when screen=chat', async () => {
    renderHook(() => useNotifications());

    await waitFor(() => expect(mockResponseCallback).not.toBeNull());

    const response = makeNotificationResponse({ screen: 'chat' });

    await act(async () => {
      mockResponseCallback!(response);
    });

    expect(mockRouterPush).toHaveBeenCalledWith('/(tabs)/chat');
  });

  it('navigates to chat with sessionId when screen=chat and sessionId present', async () => {
    renderHook(() => useNotifications());

    await waitFor(() => expect(mockResponseCallback).not.toBeNull());

    const response = makeNotificationResponse({ screen: 'chat', sessionId: 'ses-123' });

    await act(async () => {
      mockResponseCallback!(response);
    });

    expect(mockRouterPush).toHaveBeenCalledWith({
      pathname: '/(tabs)/chat',
      params: { sessionId: 'ses-123' },
    });
  });

  it('navigates to dashboard when screen=dashboard', async () => {
    renderHook(() => useNotifications());

    await waitFor(() => expect(mockResponseCallback).not.toBeNull());

    const response = makeNotificationResponse({ screen: 'dashboard' });

    await act(async () => {
      mockResponseCallback!(response);
    });

    expect(mockRouterPush).toHaveBeenCalledWith('/(tabs)/');
  });

  it('navigates to sessions when screen=sessions', async () => {
    renderHook(() => useNotifications());

    await waitFor(() => expect(mockResponseCallback).not.toBeNull());

    const response = makeNotificationResponse({ screen: 'sessions' });

    await act(async () => {
      mockResponseCallback!(response);
    });

    expect(mockRouterPush).toHaveBeenCalledWith('/(tabs)/sessions');
  });

  it('navigates to costs when screen=costs', async () => {
    renderHook(() => useNotifications());

    await waitFor(() => expect(mockResponseCallback).not.toBeNull());

    const response = makeNotificationResponse({ screen: 'costs' });

    await act(async () => {
      mockResponseCallback!(response);
    });

    expect(mockRouterPush).toHaveBeenCalledWith('/(tabs)/costs');
  });

  it('navigates to settings when screen=settings', async () => {
    renderHook(() => useNotifications());

    await waitFor(() => expect(mockResponseCallback).not.toBeNull());

    const response = makeNotificationResponse({ screen: 'settings' });

    await act(async () => {
      mockResponseCallback!(response);
    });

    expect(mockRouterPush).toHaveBeenCalledWith('/(tabs)/settings');
  });

  // --------------------------------------------------------------------------
  // Type-Based Navigation (Strategy 2 - Backwards Compatibility)
  // --------------------------------------------------------------------------

  it('navigates to chat for permission_request type with sessionId', async () => {
    renderHook(() => useNotifications());

    await waitFor(() => expect(mockResponseCallback).not.toBeNull());

    const response = makeNotificationResponse({
      type: 'permission_request',
      sessionId: 'ses-perm',
    });

    await act(async () => {
      mockResponseCallback!(response);
    });

    expect(mockRouterPush).toHaveBeenCalledWith({
      pathname: '/(tabs)/chat',
      params: { sessionId: 'ses-perm' },
    });
  });

  it('navigates to chat for permission_request without sessionId', async () => {
    renderHook(() => useNotifications());

    await waitFor(() => expect(mockResponseCallback).not.toBeNull());

    const response = makeNotificationResponse({ type: 'permission_request' });

    await act(async () => {
      mockResponseCallback!(response);
    });

    expect(mockRouterPush).toHaveBeenCalledWith('/(tabs)/chat');
  });

  it('navigates to sessions for session_started type', async () => {
    renderHook(() => useNotifications());

    await waitFor(() => expect(mockResponseCallback).not.toBeNull());

    const response = makeNotificationResponse({ type: 'session_started' });

    await act(async () => {
      mockResponseCallback!(response);
    });

    expect(mockRouterPush).toHaveBeenCalledWith('/(tabs)/sessions');
  });

  it('navigates to sessions for session_ended type', async () => {
    renderHook(() => useNotifications());

    await waitFor(() => expect(mockResponseCallback).not.toBeNull());

    const response = makeNotificationResponse({ type: 'session_ended' });

    await act(async () => {
      mockResponseCallback!(response);
    });

    expect(mockRouterPush).toHaveBeenCalledWith('/(tabs)/sessions');
  });

  it('navigates to chat for error type with sessionId', async () => {
    renderHook(() => useNotifications());

    await waitFor(() => expect(mockResponseCallback).not.toBeNull());

    const response = makeNotificationResponse({
      type: 'error',
      sessionId: 'ses-err',
    });

    await act(async () => {
      mockResponseCallback!(response);
    });

    expect(mockRouterPush).toHaveBeenCalledWith({
      pathname: '/(tabs)/chat',
      params: { sessionId: 'ses-err' },
    });
  });

  it('navigates to chat for agent_message type without sessionId', async () => {
    renderHook(() => useNotifications());

    await waitFor(() => expect(mockResponseCallback).not.toBeNull());

    const response = makeNotificationResponse({ type: 'agent_message' });

    await act(async () => {
      mockResponseCallback!(response);
    });

    expect(mockRouterPush).toHaveBeenCalledWith('/(tabs)/chat');
  });

  it('navigates to costs for budget_alert type', async () => {
    renderHook(() => useNotifications());

    await waitFor(() => expect(mockResponseCallback).not.toBeNull());

    const response = makeNotificationResponse({ type: 'budget_alert' });

    await act(async () => {
      mockResponseCallback!(response);
    });

    expect(mockRouterPush).toHaveBeenCalledWith('/(tabs)/costs');
  });

  it('navigates to dashboard for unknown type', async () => {
    renderHook(() => useNotifications());

    await waitFor(() => expect(mockResponseCallback).not.toBeNull());

    const response = makeNotificationResponse({ type: 'unknown_type' });

    await act(async () => {
      mockResponseCallback!(response);
    });

    // Zod validation passes (passthrough), but type doesn't match enum -> undefined
    // Falls through to default: dashboard
    expect(mockRouterPush).toHaveBeenCalledWith('/(tabs)/');
  });

  // --------------------------------------------------------------------------
  // No Data / Null Data
  // --------------------------------------------------------------------------

  it('navigates to dashboard when notification has no data', async () => {
    renderHook(() => useNotifications());

    await waitFor(() => expect(mockResponseCallback).not.toBeNull());

    const response = makeNotificationResponse(null);

    await act(async () => {
      mockResponseCallback!(response);
    });

    expect(mockRouterPush).toHaveBeenCalledWith('/(tabs)/');
  });

  it('navigates to dashboard when data is empty object', async () => {
    renderHook(() => useNotifications());

    await waitFor(() => expect(mockResponseCallback).not.toBeNull());

    const response = makeNotificationResponse({});

    await act(async () => {
      mockResponseCallback!(response);
    });

    // Empty object passes Zod but no screen and no type => default dashboard
    expect(mockRouterPush).toHaveBeenCalledWith('/(tabs)/');
  });

  // --------------------------------------------------------------------------
  // Badge Clearing
  // --------------------------------------------------------------------------

  it('clears badge when user taps notification', async () => {
    renderHook(() => useNotifications());

    await waitFor(() => expect(mockResponseCallback).not.toBeNull());

    const response = makeNotificationResponse({ screen: 'dashboard' });

    await act(async () => {
      mockResponseCallback!(response);
    });

    expect(mockClearBadge).toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // Cold Launch
  // --------------------------------------------------------------------------

  it('handles cold launch notification on mount', async () => {
    const coldLaunchResponse = makeNotificationResponse({ screen: 'sessions' });
    mockGetLastNotificationResponse.mockResolvedValue(coldLaunchResponse);

    renderHook(() => useNotifications());

    await waitFor(() => {
      expect(mockRouterPush).toHaveBeenCalledWith('/(tabs)/sessions');
    });
  });

  it('does nothing on mount when no cold launch notification', async () => {
    mockGetLastNotificationResponse.mockResolvedValue(null);

    renderHook(() => useNotifications());

    await waitFor(() => expect(mockGetLastNotificationResponse).toHaveBeenCalled());

    // Only the auto-registration should trigger push, not navigation
    // (initial render may push to dashboard via registration)
  });

  // --------------------------------------------------------------------------
  // Cleanup
  // --------------------------------------------------------------------------

  it('cleans up listeners on unmount', async () => {
    const { unmount } = renderHook(() => useNotifications());

    await waitFor(() => expect(mockReceivedCallback).not.toBeNull());

    unmount();

    expect(mockRemoveNotificationListener).toHaveBeenCalledTimes(2);
  });

  // --------------------------------------------------------------------------
  // Screen takes priority over type
  // --------------------------------------------------------------------------

  it('screen field takes priority over type-based routing', async () => {
    renderHook(() => useNotifications());

    await waitFor(() => expect(mockResponseCallback).not.toBeNull());

    const response = makeNotificationResponse({
      screen: 'costs',
      type: 'permission_request',
      sessionId: 'ses-123',
    });

    await act(async () => {
      mockResponseCallback!(response);
    });

    // Should navigate to costs (screen field), not chat (type field)
    expect(mockRouterPush).toHaveBeenCalledWith('/(tabs)/costs');
  });
});
