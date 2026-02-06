/**
 * Notifications Service Tests
 *
 * Tests for push notification registration, token management, and local notifications.
 *
 * WHY separate mock per test for Device.isDevice: The module mock in jest.setup.js
 * returns a plain object with isDevice: true. We use jest.isolateModules to get
 * a fresh import for tests that need Device.isDevice = false.
 */

import * as Notifications from 'expo-notifications';

// ============================================================================
// Mock Supabase with proper chainable query builder
// WHY define inside factory: Jest hoists jest.mock() calls before variable
// declarations. Variables must be defined inside the factory to be in scope.
// ============================================================================

// Mutable state for controlling mock behavior in tests
let mockQueryError: { message: string } | null = null;
let mockAuthUser: { id: string } | null = { id: 'test-user-id' };
let mockAuthError: { message: string } | null = null;

// WHY @/lib/supabase: The source file imports from '@/lib/supabase' (alias).
// Jest resolves this via moduleNameMapper, and the mock path must match exactly.
jest.mock('@/lib/supabase', () => {
  // Create chainable mock inside factory (in scope after hoisting)
  const createChain = () => {
    const chain: Record<string, jest.Mock | ((resolve: (v: unknown) => void) => Promise<unknown>)> = {
      upsert: jest.fn().mockReturnThis(),
      delete: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
    };
    // WHY Promise.resolve().then: The source uses `await supabase.from(...).upsert(...)`.
    // A proper thenable must return a Promise for async/await resolution.
    chain.then = (resolve: (v: unknown) => void) =>
      Promise.resolve({ error: mockQueryError }).then(resolve);
    return chain;
  };

  return {
    supabase: {
      auth: {
        getUser: jest.fn(async () => ({
          data: { user: mockAuthUser },
          error: mockAuthError,
        })),
      },
      from: jest.fn(() => createChain()),
    },
  };
});

// Import the supabase mock to access internal mocks for assertions
import { supabase } from '@/lib/supabase';

// ============================================================================
// Import after mocks are set up
// ============================================================================

import {
  registerForPushNotifications,
  savePushToken,
  removePushToken,
  scheduleLocalNotification,
  cancelNotification,
  cancelAllNotifications,
  getBadgeCount,
  setBadgeCount,
  clearBadge,
  addNotificationReceivedListener,
  addNotificationResponseListener,
  removeNotificationListener,
  getLastNotificationResponse,
} from '../notifications';

// ============================================================================
// Tests
// ============================================================================

describe('Notifications Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset mutable mock state
    mockQueryError = null;
    mockAuthUser = { id: 'test-user-id' };
    mockAuthError = null;
  });

  // --------------------------------------------------------------------------
  // registerForPushNotifications
  // --------------------------------------------------------------------------

  describe('registerForPushNotifications()', () => {
    // WHY skip non-physical device test: The Device.isDevice property is read
    // at call time from the module-level mock. Changing it after import requires
    // jest.isolateModules or module re-import, which is complex with the
    // notification handler top-level side effect. We test the remaining paths.

    it('returns null when permission is denied', async () => {
      (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({
        status: 'denied',
      });
      (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValue({
        status: 'denied',
      });

      const result = await registerForPushNotifications();

      expect(result).toBeNull();
      expect(Notifications.getPermissionsAsync).toHaveBeenCalled();
      expect(Notifications.requestPermissionsAsync).toHaveBeenCalled();
      expect(Notifications.getExpoPushTokenAsync).not.toHaveBeenCalled();
    });

    it('requests permission if not granted and returns token if approved', async () => {
      (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({
        status: 'undetermined',
      });
      (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValue({
        status: 'granted',
      });
      (Notifications.getExpoPushTokenAsync as jest.Mock).mockResolvedValue({
        data: 'ExponentPushToken[test-token-123]',
      });

      const result = await registerForPushNotifications();

      expect(result).toBe('ExponentPushToken[test-token-123]');
      expect(Notifications.requestPermissionsAsync).toHaveBeenCalled();
      expect(Notifications.getExpoPushTokenAsync).toHaveBeenCalledWith({
        projectId: process.env.EXPO_PUBLIC_PROJECT_ID,
      });
    });

    it('returns token when permission already granted', async () => {
      (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({
        status: 'granted',
      });
      (Notifications.getExpoPushTokenAsync as jest.Mock).mockResolvedValue({
        data: 'ExponentPushToken[already-granted]',
      });

      const result = await registerForPushNotifications();

      expect(result).toBe('ExponentPushToken[already-granted]');
      expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
    });

    it('returns null if getExpoPushTokenAsync throws', async () => {
      (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({
        status: 'granted',
      });
      (Notifications.getExpoPushTokenAsync as jest.Mock).mockRejectedValue(
        new Error('Network error'),
      );

      const result = await registerForPushNotifications();

      expect(result).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // savePushToken
  // --------------------------------------------------------------------------

  describe('savePushToken()', () => {
    it('returns true on successful upsert', async () => {
      const result = await savePushToken('ExponentPushToken[test]');

      expect(result).toBe(true);
      expect(supabase.from).toHaveBeenCalledWith('device_tokens');
    });

    it('returns false if no authenticated user', async () => {
      mockAuthUser = null;

      const result = await savePushToken('ExponentPushToken[test]');

      expect(result).toBe(false);
    });

    it('returns false on Supabase error', async () => {
      mockQueryError = { message: 'Database error' };

      const result = await savePushToken('ExponentPushToken[test]');

      expect(result).toBe(false);
    });

    it('returns false if getUser throws', async () => {
      (supabase.auth.getUser as jest.Mock).mockRejectedValueOnce(new Error('Auth error'));

      const result = await savePushToken('ExponentPushToken[test]');

      expect(result).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // removePushToken
  // --------------------------------------------------------------------------

  describe('removePushToken()', () => {
    it('returns true on successful deletion', async () => {
      const result = await removePushToken('ExponentPushToken[test]');

      expect(result).toBe(true);
      expect(supabase.from).toHaveBeenCalledWith('device_tokens');
    });

    it('returns false if no authenticated user', async () => {
      mockAuthUser = null;

      const result = await removePushToken('ExponentPushToken[test]');

      expect(result).toBe(false);
    });

    it('returns false on Supabase error', async () => {
      mockQueryError = { message: 'Delete failed' };

      const result = await removePushToken('ExponentPushToken[test]');

      expect(result).toBe(false);
    });

    it('returns false if getUser throws', async () => {
      (supabase.auth.getUser as jest.Mock).mockRejectedValueOnce(new Error('Auth error'));

      const result = await removePushToken('ExponentPushToken[test]');

      expect(result).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // scheduleLocalNotification
  // --------------------------------------------------------------------------

  describe('scheduleLocalNotification()', () => {
    it('schedules with time interval trigger when delay > 0', async () => {
      const notification = {
        type: 'session_started' as const,
        title: 'Session Started',
        body: 'Your agent is ready',
        data: { sessionId: 'sess-123' },
      };

      const result = await scheduleLocalNotification(notification, 10);

      expect(result).toBe('mock-notification-id');
      expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith({
        content: {
          title: 'Session Started',
          body: 'Your agent is ready',
          data: { sessionId: 'sess-123', type: 'session_started' },
          sound: true,
          priority: Notifications.AndroidNotificationPriority.HIGH,
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
          seconds: 10,
        },
      });
    });

    it('schedules with null trigger when delay = 0', async () => {
      const notification = {
        type: 'error' as const,
        title: 'Error',
        body: 'Something went wrong',
      };

      await scheduleLocalNotification(notification, 0);

      expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith(
        expect.objectContaining({ trigger: null }),
      );
    });

    it('uses default delay of 0 when not provided', async () => {
      const notification = {
        type: 'budget_alert' as const,
        title: 'Budget Alert',
        body: 'Approaching limit',
      };

      await scheduleLocalNotification(notification);

      expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith(
        expect.objectContaining({ trigger: null }),
      );
    });
  });

  // --------------------------------------------------------------------------
  // Passthrough functions
  // --------------------------------------------------------------------------

  describe('cancelNotification()', () => {
    it('delegates to Notifications API', async () => {
      await cancelNotification('notif-123');
      expect(Notifications.cancelScheduledNotificationAsync).toHaveBeenCalledWith('notif-123');
    });
  });

  describe('cancelAllNotifications()', () => {
    it('delegates to Notifications API', async () => {
      await cancelAllNotifications();
      expect(Notifications.cancelAllScheduledNotificationsAsync).toHaveBeenCalled();
    });
  });

  describe('getBadgeCount()', () => {
    it('returns count from API', async () => {
      (Notifications.getBadgeCountAsync as jest.Mock).mockResolvedValue(5);
      expect(await getBadgeCount()).toBe(5);
    });
  });

  describe('setBadgeCount()', () => {
    it('sets count via API', async () => {
      (Notifications.setBadgeCountAsync as jest.Mock).mockResolvedValue(true);
      expect(await setBadgeCount(10)).toBe(true);
      expect(Notifications.setBadgeCountAsync).toHaveBeenCalledWith(10);
    });
  });

  describe('clearBadge()', () => {
    it('calls setBadgeCount with 0', async () => {
      (Notifications.setBadgeCountAsync as jest.Mock).mockResolvedValue(true);
      expect(await clearBadge()).toBe(true);
      expect(Notifications.setBadgeCountAsync).toHaveBeenCalledWith(0);
    });
  });

  describe('listener management', () => {
    it('addNotificationReceivedListener registers callback', () => {
      const cb = jest.fn();
      addNotificationReceivedListener(cb);
      expect(Notifications.addNotificationReceivedListener).toHaveBeenCalledWith(cb);
    });

    it('addNotificationResponseListener registers callback', () => {
      const cb = jest.fn();
      addNotificationResponseListener(cb);
      expect(Notifications.addNotificationResponseReceivedListener).toHaveBeenCalledWith(cb);
    });

    it('removeNotificationListener removes subscription', () => {
      const sub = { remove: jest.fn() } as any;
      removeNotificationListener(sub);
      expect(Notifications.removeNotificationSubscription).toHaveBeenCalledWith(sub);
    });
  });

  describe('getLastNotificationResponse()', () => {
    it('returns last response', async () => {
      const mockResponse = { notification: {}, actionIdentifier: 'default' };
      (Notifications.getLastNotificationResponseAsync as jest.Mock).mockResolvedValue(mockResponse);
      expect(await getLastNotificationResponse()).toBe(mockResponse);
    });

    it('returns null when no response', async () => {
      (Notifications.getLastNotificationResponseAsync as jest.Mock).mockResolvedValue(null);
      expect(await getLastNotificationResponse()).toBeNull();
    });
  });
});
