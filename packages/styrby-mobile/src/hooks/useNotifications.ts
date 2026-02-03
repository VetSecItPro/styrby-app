/**
 * useNotifications Hook
 *
 * Manages push notification registration and handling.
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
} from '@/services/notifications';

interface UseNotificationsResult {
  expoPushToken: string | null;
  notification: Notifications.Notification | null;
  isRegistered: boolean;
  error: string | null;
  register: () => Promise<void>;
  unregister: () => Promise<void>;
}

/**
 * Hook for managing push notifications.
 */
export function useNotifications(): UseNotificationsResult {
  const router = useRouter();
  const [expoPushToken, setExpoPushToken] = useState<string | null>(null);
  const [notification, setNotification] = useState<Notifications.Notification | null>(null);
  const [isRegistered, setIsRegistered] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const notificationListener = useRef<Notifications.Subscription>();
  const responseListener = useRef<Notifications.Subscription>();

  // Handle notification response (user tapped notification)
  const handleNotificationResponse = useCallback(
    (response: Notifications.NotificationResponse) => {
      const data = response.notification.request.content.data;
      const notificationType = data?.type as NotificationType | undefined;

      // Clear badge when user interacts with notification
      clearBadge();

      // Navigate based on notification type
      switch (notificationType) {
        case 'permission_request':
          // Navigate to chat tab with the relevant session
          router.push('/(tabs)/chat');
          break;
        case 'session_started':
        case 'session_ended':
          // Navigate to sessions tab
          router.push('/(tabs)/sessions');
          break;
        case 'error':
        case 'agent_message':
          // Navigate to chat tab
          router.push('/(tabs)/chat');
          break;
        case 'budget_alert':
          // Navigate to settings (would have budget info)
          router.push('/(tabs)/settings');
          break;
        default:
          // Default to dashboard
          router.push('/(tabs)');
      }
    },
    [router]
  );

  // Register for push notifications
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

  // Unregister from push notifications
  const unregister = useCallback(async () => {
    if (expoPushToken) {
      await removePushToken(expoPushToken);
      setExpoPushToken(null);
      setIsRegistered(false);
    }
  }, [expoPushToken]);

  // Set up notification listeners
  useEffect(() => {
    // Register for push notifications on mount
    register();

    // Listen for incoming notifications while app is foregrounded
    notificationListener.current = addNotificationReceivedListener((notification) => {
      setNotification(notification);
    });

    // Listen for user tapping notification
    responseListener.current = addNotificationResponseListener(handleNotificationResponse);

    // Check if app was opened via notification
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
