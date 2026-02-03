/**
 * Push Notification Service
 *
 * Handles Expo push notification registration and handling.
 */

import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import { Platform } from 'react-native';
import { supabase } from '@/lib/supabase';

/**
 * Notification types we send from Styrby
 */
export type NotificationType =
  | 'permission_request'
  | 'session_started'
  | 'session_ended'
  | 'error'
  | 'budget_alert'
  | 'agent_message';

/**
 * Notification payload structure
 */
export interface StyrbyNotification {
  type: NotificationType;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

// Configure notification handler
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

/**
 * Register for push notifications and return the token.
 */
export async function registerForPushNotifications(): Promise<string | null> {
  // Check if we're on a physical device
  if (!Device.isDevice) {
    console.log('Push notifications require a physical device');
    return null;
  }

  // Check existing permissions
  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;

  // Request permissions if not granted
  if (existingStatus !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }

  if (finalStatus !== 'granted') {
    console.log('Failed to get push notification permissions');
    return null;
  }

  // Configure Android notification channel
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'Default',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#f97316', // Orange - Styrby brand color
    });

    // High priority channel for permission requests
    await Notifications.setNotificationChannelAsync('permissions', {
      name: 'Permission Requests',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 500, 250, 500],
      lightColor: '#ef4444', // Red for attention
    });
  }

  // Get the Expo push token
  try {
    const tokenData = await Notifications.getExpoPushTokenAsync({
      projectId: process.env.EXPO_PROJECT_ID,
    });
    return tokenData.data;
  } catch (error) {
    console.error('Error getting push token:', error);
    return null;
  }
}

/**
 * Save the push token to Supabase for this device.
 */
export async function savePushToken(token: string): Promise<boolean> {
  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      console.error('No authenticated user');
      return false;
    }

    const { error } = await supabase.from('device_tokens').upsert(
      {
        user_id: user.id,
        token,
        platform: Platform.OS,
        last_used_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,token' }
    );

    if (error) {
      console.error('Error saving push token:', error);
      return false;
    }

    return true;
  } catch (error) {
    console.error('Error saving push token:', error);
    return false;
  }
}

/**
 * Remove the push token from Supabase (on logout).
 */
export async function removePushToken(token: string): Promise<boolean> {
  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) return false;

    const { error } = await supabase
      .from('device_tokens')
      .delete()
      .eq('user_id', user.id)
      .eq('token', token);

    if (error) {
      console.error('Error removing push token:', error);
      return false;
    }

    return true;
  } catch (error) {
    console.error('Error removing push token:', error);
    return false;
  }
}

/**
 * Schedule a local notification (for testing or offline alerts).
 */
export async function scheduleLocalNotification(
  notification: StyrbyNotification,
  delaySeconds: number = 0
): Promise<string> {
  const identifier = await Notifications.scheduleNotificationAsync({
    content: {
      title: notification.title,
      body: notification.body,
      data: { ...notification.data, type: notification.type },
      sound: true,
      priority: Notifications.AndroidNotificationPriority.HIGH,
    },
    trigger: delaySeconds > 0 ? { type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL, seconds: delaySeconds } : null,
  });

  return identifier;
}

/**
 * Cancel a scheduled notification.
 */
export async function cancelNotification(identifier: string): Promise<void> {
  await Notifications.cancelScheduledNotificationAsync(identifier);
}

/**
 * Cancel all scheduled notifications.
 */
export async function cancelAllNotifications(): Promise<void> {
  await Notifications.cancelAllScheduledNotificationsAsync();
}

/**
 * Get the badge count.
 */
export async function getBadgeCount(): Promise<number> {
  return await Notifications.getBadgeCountAsync();
}

/**
 * Set the badge count.
 */
export async function setBadgeCount(count: number): Promise<boolean> {
  return await Notifications.setBadgeCountAsync(count);
}

/**
 * Clear the badge count.
 */
export async function clearBadge(): Promise<boolean> {
  return await setBadgeCount(0);
}

/**
 * Add notification received listener.
 */
export function addNotificationReceivedListener(
  callback: (notification: Notifications.Notification) => void
): Notifications.Subscription {
  return Notifications.addNotificationReceivedListener(callback);
}

/**
 * Add notification response listener (when user taps notification).
 */
export function addNotificationResponseListener(
  callback: (response: Notifications.NotificationResponse) => void
): Notifications.Subscription {
  return Notifications.addNotificationResponseReceivedListener(callback);
}

/**
 * Remove notification listener.
 */
export function removeNotificationListener(
  subscription: Notifications.Subscription
): void {
  Notifications.removeNotificationSubscription(subscription);
}

/**
 * Get last notification response (for handling app opened via notification).
 */
export async function getLastNotificationResponse(): Promise<Notifications.NotificationResponse | null> {
  return await Notifications.getLastNotificationResponseAsync();
}
