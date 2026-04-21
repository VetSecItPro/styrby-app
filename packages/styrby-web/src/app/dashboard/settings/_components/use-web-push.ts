'use client';

import { useCallback, useEffect, useState } from 'react';
import { urlBase64ToUint8Array } from './utils';

/**
 * Return shape for the useWebPush hook.
 *
 * WHY: Typed explicitly so consumers (SettingsNotifications) can destructure
 * without TS widening. Keeps the SettingsNotifications render logic dumb.
 */
export interface UseWebPushResult {
  /** Whether the current browser supports the Push + Service Worker APIs at all. */
  supported: boolean;
  /** Current browser permission state for notifications. */
  permission: NotificationPermission;
  /** Whether this browser is already subscribed to push on the server. */
  subscribed: boolean;
  /** True while a subscribe/unsubscribe round-trip is in flight. */
  loading: boolean;
  /** Last error message from a subscribe/unsubscribe attempt, if any. */
  error: string | null;
  /** Subscribe this browser to push notifications (requests permission if needed). */
  subscribe: () => Promise<void>;
  /** Unsubscribe this browser and remove the subscription server-side first. */
  unsubscribe: () => Promise<void>;
}

/**
 * Manages the browser's Web Push subscription lifecycle for the Settings UI.
 *
 * On mount: detects Push API availability and whether the browser already has
 * an active subscription so the UI can show the correct state without a
 * server roundtrip. `subscribe` requests permission, creates a PushSubscription
 * via the service worker, and POSTs it to `/api/push/subscribe`. `unsubscribe`
 * notifies the server FIRST (so the server stops sending) and only then
 * unsubscribes locally — if the server call fails, we keep the local
 * subscription to avoid ghost subscriptions that the user can never manage.
 *
 * Optional deps are injected for unit-testability.
 *
 * @param deps - Optional overrides for the fetch client and VAPID key source (test seams).
 * @returns Current web-push state plus subscribe/unsubscribe callbacks.
 */
export function useWebPush(deps?: {
  /** Override fetch (defaults to global fetch). Unit tests inject a stub. */
  fetchImpl?: typeof fetch;
  /** Override VAPID public key lookup (defaults to NEXT_PUBLIC_VAPID_PUBLIC_KEY). */
  getVapidKey?: () => string | undefined;
}): UseWebPushResult {
  const fetchImpl = deps?.fetchImpl ?? (typeof fetch !== 'undefined' ? fetch : undefined);
  const getVapidKey =
    deps?.getVapidKey ?? (() => process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY);

  const [supported, setSupported] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission>('default');
  const [subscribed, setSubscribed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * WHY: On mount we detect support + existing subscription state so the UI
   * can render "Subscribe" vs "Unsubscribe" immediately, not after a flicker.
   */
  useEffect(() => {
    const check = async () => {
      if (typeof navigator === 'undefined' || typeof window === 'undefined') {
        setSupported(false);
        return;
      }
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        setSupported(false);
        return;
      }
      setSupported(true);
      setPermission(Notification.permission);
      try {
        const registration = await navigator.serviceWorker.ready;
        const sub = await registration.pushManager.getSubscription();
        setSubscribed(!!sub);
      } catch {
        // Service worker not ready yet; leave subscribed = false.
        setSubscribed(false);
      }
    };
    check();
  }, []);

  const subscribe = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const p = await Notification.requestPermission();
      setPermission(p);
      if (p !== 'granted') {
        setError(
          'Notification permission was denied. Please allow notifications in your browser settings.'
        );
        setLoading(false);
        return;
      }
      const registration = await navigator.serviceWorker.ready;
      const vapidPublicKey = getVapidKey();
      if (!vapidPublicKey) {
        setError('Push notification configuration is missing. Please contact support.');
        setLoading(false);
        return;
      }
      // WHY: applicationServerKey must be an ArrayBuffer; Uint8Array.buffer
      // is ArrayBufferLike in strict TS (could be SharedArrayBuffer), so we
      // cast explicitly.
      const applicationServerKey = urlBase64ToUint8Array(vapidPublicKey)
        .buffer as ArrayBuffer;
      const sub = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey,
      });
      if (!fetchImpl) throw new Error('fetch is unavailable in this environment');
      const res = await fetchImpl('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sub.toJSON()),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to save subscription');
      }
      setSubscribed(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to enable push notifications');
    } finally {
      setLoading(false);
    }
  }, [fetchImpl, getVapidKey]);

  const unsubscribe = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const registration = await navigator.serviceWorker.ready;
      const sub = await registration.pushManager.getSubscription();
      if (sub) {
        if (!fetchImpl) throw new Error('fetch is unavailable in this environment');
        // WHY: Server FIRST, then local — otherwise server keeps sending to an
        // endpoint the browser has already forgotten and the user sees ghost
        // notifications they can't dismiss via the UI.
        const res = await fetchImpl('/api/push/unsubscribe', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || 'Failed to remove subscription from server');
        }
        await sub.unsubscribe();
      }
      setSubscribed(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to disable push notifications');
    } finally {
      setLoading(false);
    }
  }, [fetchImpl]);

  return { supported, permission, subscribed, loading, error, subscribe, unsubscribe };
}
