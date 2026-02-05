/**
 * useNotifications Hook
 *
 * Manages push notification registration, foreground handling, and
 * deep-link navigation when a user taps a notification.
 *
 * Navigation strategy:
 * 1. First checks for an explicit `screen` field in the notification data
 *    (set by the backend/CLI when sending the push). This is the preferred
 *    approach because it decouples navigation targets from notification types.
 * 2. Falls back to the `type`-based switch for backwards compatibility with
 *    notifications that don't include an explicit screen field.
 * 3. If a `sessionId` is present alongside the `screen` field, it is forwarded
 *    as a query parameter so the destination screen can load the right data.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { useRouter } from 'expo-router';
import * as Notifications from 'expo-notifications';
import {
  registerForPushNotifications,
  savePushToken,
  removePushToken,
  addNotificationReceivedListener,
  addNotificationResponseListener,
  removeNotificationListener,
  getLastNotificationResponse,
  clearBadge,
  type NotificationType,
} from '../services/notifications';

/**
 * Supported deep-link screen targets for notification-driven navigation.
 * These correspond to the file-system routes in `app/(tabs)/`.
 */
type NotificationScreen = 'chat' | 'dashboard' | 'sessions' | 'costs' | 'settings';

/**
 * Shape of the `data` payload attached to Styrby push notifications.
 * The backend sets these fields when scheduling a push via Expo or APNs/FCM.
 */
interface NotificationData {
  /** Notification category for backwards-compatible routing */
  type?: NotificationType;
  /** Explicit screen target (preferred over type-based routing) */
  screen?: NotificationScreen;
  /** Session ID to pass to the destination screen as a query parameter */
  sessionId?: string;
}

/** Return type of the useNotifications hook */
interface UseNotificationsResult {
  /** The device's Expo push token, or null if not registered */
  expoPushToken: string | null;
  /** The most recently received foreground notification */
  notification: Notifications.Notification | null;
  /** Whether the push token has been saved to Supabase */
  isRegistered: boolean;
  /** Human-readable error message, or null if no error */
  error: string | null;
  /** Manually trigger push notification registration */
  register: () => Promise<void>;
  /** Remove the push token from Supabase (e.g. on logout) */
  unregister: () => Promise<void>;
}

/**
 * Hook for managing push notifications throughout the app lifecycle.
 *
 * Handles three concerns:
 * 1. Registration: requests permissions, obtains an Expo push token,
 *    and persists it to the `device_tokens` table in Supabase.
 * 2. Foreground handling: updates local state when a notification arrives
 *    while the app is in the foreground.
 * 3. Tap navigation: when the user taps a notification (from background or
 *    killed state), navigates to the appropriate screen using expo-router.
 *
 * @returns {UseNotificationsResult} Push token, notification state, and control functions
 */
export function useNotifications(): UseNotificationsResult {
  const router = useRouter();
  const [expoPushToken, setExpoPushToken] = useState<string | null>(null);
  const [notification, setNotification] = useState<Notifications.Notification | null>(null);
  const [isRegistered, setIsRegistered] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const notificationListener = useRef<Notifications.Subscription>();
  const responseListener = useRef<Notifications.Subscription>();

  /**
   * Navigates to a screen based on the explicit `screen` field in the
   * notification data payload.
   *
   * WHY this exists separately from the type-based switch: the `screen` field
   * gives the backend full control over navigation without coupling to the
   * notification type enum. This is more flexible and future-proof -- new
   * notification types don't require mobile app updates to route correctly.
   *
   * @param screen - The target screen name
   * @param sessionId - Optional session ID to pass as a query parameter
   * @returns true if navigation was handled, false otherwise
   */
  const navigateToScreen = useCallback(
    (screen: NotificationScreen, sessionId?: string): boolean => {
      switch (screen) {
        case 'chat':
          if (sessionId) {
            router.push({
              pathname: '/(tabs)/chat',
              params: { sessionId },
            });
          } else {
            router.push('/(tabs)/chat');
          }
          return true;

        case 'dashboard':
          router.push('/(tabs)/');
          return true;

        case 'sessions':
          router.push('/(tabs)/sessions');
          return true;

        case 'costs':
          router.push('/(tabs)/costs');
          return true;

        case 'settings':
          router.push('/(tabs)/settings');
          return true;

        default:
          return false;
      }
    },
    [router]
  );

  /**
   * Handles navigation when the user taps a notification.
   *
   * Uses a two-tier routing strategy:
   * 1. If the notification data contains an explicit `screen` field, navigate
   *    directly to that screen (with optional `sessionId` as a param).
   * 2. Otherwise, fall back to the legacy `type`-based routing for backwards
   *    compatibility with older notification payloads.
   *
   * @param response - The notification response from expo-notifications
   * @returns void
   */
  const handleNotificationResponse = useCallback(
    (response: Notifications.NotificationResponse) => {
      const data = response.notification.request.content.data as NotificationData | undefined;

      // Clear badge when user interacts with any notification
      clearBadge();

      if (!data) {
        // No data payload at all -- go to dashboard as a safe default
        router.push('/(tabs)/');
        return;
      }

      // Strategy 1: Explicit screen field (preferred)
      if (data.screen) {
        const handled = navigateToScreen(data.screen, data.sessionId);
        if (handled) return;
      }

      // Strategy 2: Legacy type-based routing (backwards compatibility)
      const notificationType = data.type;

      switch (notificationType) {
        case 'permission_request':
          // Permission requests need the chat screen to approve/deny
          if (data.sessionId) {
            router.push({
              pathname: '/(tabs)/chat',
              params: { sessionId: data.sessionId },
            });
          } else {
            router.push('/(tabs)/chat');
          }
          break;

        case 'session_started':
        case 'session_ended':
          router.push('/(tabs)/sessions');
          break;

        case 'error':
        case 'agent_message':
          // Errors and agent messages are shown in the chat
          if (data.sessionId) {
            router.push({
              pathname: '/(tabs)/chat',
              params: { sessionId: data.sessionId },
            });
          } else {
            router.push('/(tabs)/chat');
          }
          break;

        case 'budget_alert':
          router.push('/(tabs)/costs');
          break;

        default:
          router.push('/(tabs)/');
      }
    },
    [router, navigateToScreen]
  );

  /**
   * Requests push notification permissions, obtains an Expo push token,
   * and persists it to the Supabase `device_tokens` table.
   *
   * @returns void
   */
  const register = useCallback(async () => {
    try {
      setError(null);
      const token = await registerForPushNotifications();

      if (token) {
        setExpoPushToken(token);
        const saved = await savePushToken(token);
        setIsRegistered(saved);

        if (!saved) {
          setError('Failed to save push token');
        }
      } else {
        setError('Failed to get push token');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      setError(message);
    }
  }, []);

  /**
   * Removes the push token from Supabase and resets local state.
   * Call this on logout to stop receiving notifications on this device.
   *
   * @returns void
   */
  const unregister = useCallback(async () => {
    if (expoPushToken) {
      await removePushToken(expoPushToken);
      setExpoPushToken(null);
      setIsRegistered(false);
    }
  }, [expoPushToken]);

  // Set up notification listeners on mount
  useEffect(() => {
    // Register for push notifications on mount
    register();

    // Listen for incoming notifications while app is foregrounded
    notificationListener.current = addNotificationReceivedListener((notification) => {
      setNotification(notification);
    });

    // Listen for user tapping notification (app in background)
    responseListener.current = addNotificationResponseListener(handleNotificationResponse);

    // WHY: Check if the app was cold-launched by tapping a notification.
    // `getLastNotificationResponseAsync` returns the response that caused
    // the app to open, but only on the first call after launch. This
    // handles the case where the app was fully killed and the user taps
    // a notification to open it.
    getLastNotificationResponse().then((response) => {
      if (response) {
        handleNotificationResponse(response);
      }
    });

    // Cleanup listeners on unmount
    return () => {
      if (notificationListener.current) {
        removeNotificationListener(notificationListener.current);
      }
      if (responseListener.current) {
        removeNotificationListener(responseListener.current);
      }
    };
  }, [register, handleNotificationResponse]);

  return {
    expoPushToken,
    notification,
    isRegistered,
    error,
    register,
    unregister,
  };
}
