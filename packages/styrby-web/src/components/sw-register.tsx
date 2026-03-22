'use client';

import { useEffect } from 'react';
import { offlineQueue } from '@/lib/offlineQueue';

/**
 * Service Worker Registration Component
 *
 * WHY: Service workers must be registered from client-side JavaScript after
 * the page loads. This component handles the full SW lifecycle: initial
 * registration, waiting for activation, detecting updates, and listening
 * for sync messages from the SW (for offline queue processing).
 *
 * Placed in the root layout so the SW is registered on every page load,
 * regardless of the route the user enters on.
 *
 * @returns null (this component renders no visible UI)
 *
 * @example
 * // In layout.tsx:
 * <SWRegister />
 */
export function SWRegister() {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!('serviceWorker' in navigator)) return;

    let registration: ServiceWorkerRegistration | undefined;

    /**
     * Registers the service worker and sets up lifecycle event handlers.
     * Runs once on component mount.
     */
    async function registerSW(): Promise<void> {
      try {
        registration = await navigator.serviceWorker.register('/sw.js', {
          scope: '/',
          type: 'classic',
        });

        if (process.env.NODE_ENV === 'development') {
          console.log('[SW] Registered successfully. Scope:', registration.scope);
        }

        // WHY: The 'updatefound' event fires when the browser detects a new
        // SW script. We track the installing worker's state to know when the
        // update is ready. This allows us to notify the user or auto-refresh.
        registration.addEventListener('updatefound', () => {
          const newWorker = registration?.installing;
          if (!newWorker) return;

          newWorker.addEventListener('statechange', () => {
            if (process.env.NODE_ENV === 'development') {
              console.log('[SW] State changed:', newWorker.state);
            }

            if (
              newWorker.state === 'installed' &&
              navigator.serviceWorker.controller
            ) {
              // WHY: If there is already an active controller and the new
              // worker is installed, it means an update is available. The
              // new SW is waiting to activate. Since we use skipWaiting in
              // sw.ts, this state is brief, but we log it for debugging.
              if (process.env.NODE_ENV === 'development') {
                console.log('[SW] Update available and will activate shortly.');
              }
            }
          });
        });
      } catch (error) {
        console.error('[SW] Registration failed:', error);
      }
    }

    /**
     * Handles messages from the service worker.
     * Currently handles SYNC_OFFLINE_QUEUE messages triggered by the
     * Background Sync API in sw.ts.
     *
     * @param event - The MessageEvent from the service worker
     */
    function handleSWMessage(event: MessageEvent): void {
      if (event.data?.type === 'SYNC_OFFLINE_QUEUE') {
        if (process.env.NODE_ENV === 'development') {
          console.log('[SW] Received sync request, processing offline queue.');
        }
        // WHY: The SW cannot directly access the IndexedDB offline queue
        // because it runs in a different global scope. Instead, it posts
        // a message to the client, which calls processQueue() on the
        // singleton offlineQueue instance that has IndexedDB access.
        offlineQueue.processQueue().catch((error: unknown) => {
          console.error('[SW] Queue flush failed:', error);
        });
      }
    }

    registerSW();
    navigator.serviceWorker.addEventListener('message', handleSWMessage);

    return () => {
      navigator.serviceWorker.removeEventListener('message', handleSWMessage);
    };
  }, []);

  return null;
}
