'use client';

import { useEffect, useState, useCallback } from 'react';
import { offlineQueue } from '@/lib/offlineQueue';

/**
 * Service Worker Registration Component
 *
 * WHY: Service workers must be registered from client-side JavaScript after
 * the page loads. This component handles the full SW lifecycle: initial
 * registration, waiting for activation, detecting updates, showing an update
 * notification banner, and listening for sync messages from the SW (for
 * offline queue processing).
 *
 * Placed in the root layout so the SW is registered on every page load,
 * regardless of the route the user enters on.
 *
 * @returns An update notification banner when an update is available, or null
 *
 * @example
 * // In layout.tsx:
 * <SWRegister />
 */
export function SWRegister() {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [waitingWorker, setWaitingWorker] =
    useState<ServiceWorker | null>(null);
  const [updating, setUpdating] = useState(false);

  /**
   * Handles the user clicking the update banner. Sends SKIP_WAITING to the
   * waiting service worker and reloads the page once it activates.
   */
  const handleUpdate = useCallback((): void => {
    if (!waitingWorker || updating) return;

    setUpdating(true);
    waitingWorker.postMessage({ type: 'SKIP_WAITING' });

    // WHY: Listen for the waiting worker to become active, then reload.
    // The controllerchange event fires when the new SW takes over.
    // { once: true } prevents listener accumulation on repeated clicks.
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      window.location.reload();
    }, { once: true });
  }, [waitingWorker, updating]);

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

        // WHY: Check if there is already a waiting worker from a previous
        // page load. This handles the case where the user navigates away
        // and comes back while an update is pending.
        if (registration.waiting) {
          setWaitingWorker(registration.waiting);
          setUpdateAvailable(true);
        }

        // WHY: The 'updatefound' event fires when the browser detects a new
        // SW script. We track the installing worker's state to know when the
        // update is ready. This allows us to notify the user via the banner.
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
              // WHY: A new worker is installed and there is already an active
              // controller. This means an update is ready. Show the banner
              // so the user can choose to activate it.
              setWaitingWorker(newWorker);
              setUpdateAvailable(true);

              if (process.env.NODE_ENV === 'development') {
                console.log('[SW] Update available. Showing notification banner.');
              }
            }
          });
        });

        // Register periodic background sync for cost updates
        await registerPeriodicSync(registration);
      } catch (error) {
        console.error('[SW] Registration failed:', error);
      }
    }

    /**
     * Registers periodic background sync for cost data refresh.
     * Guarded by feature detection since the API is only available in
     * Chromium-based browsers.
     *
     * @param reg - The active service worker registration
     */
    async function registerPeriodicSync(
      reg: ServiceWorkerRegistration
    ): Promise<void> {
      // WHY: The periodicSync property is not available in all browsers.
      // We must check for it at runtime to avoid errors in Firefox/Safari.
      const periodicSyncReg = reg as ServiceWorkerRegistration & {
        periodicSync?: {
          register(
            tag: string,
            options: { minInterval: number }
          ): Promise<void>;
        };
      };

      if (!periodicSyncReg.periodicSync) return;

      try {
        // WHY: 1 hour minimum interval. The browser may sync less frequently
        // based on site engagement. This ensures cost data stays reasonably
        // fresh without excessive network usage.
        await periodicSyncReg.periodicSync.register('cost-refresh', {
          minInterval: 60 * 60 * 1000,
        });

        if (process.env.NODE_ENV === 'development') {
          console.log('[SW] Periodic sync registered: cost-refresh (1h interval)');
        }
      } catch {
        // WHY: Periodic sync registration can fail if the browser denies
        // the permission (e.g., low site engagement score). This is expected
        // and non-critical; the dashboard still fetches fresh data on load.
        if (process.env.NODE_ENV === 'development') {
          console.log('[SW] Periodic sync registration denied by browser.');
        }
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

  if (!updateAvailable) {
    return null;
  }

  return (
    <div
      role="alert"
      aria-live="polite"
      className="fixed top-0 left-0 right-0 z-[60] border-b border-zinc-800 bg-zinc-950/95 backdrop-blur-sm px-4 py-3"
    >
      <div className="mx-auto flex max-w-4xl items-center justify-between gap-4">
        <p className="text-sm text-zinc-300">
          A new version of Styrby is available.
        </p>
        <button
          type="button"
          onClick={handleUpdate}
          disabled={updating}
          className="rounded-md bg-amber-500 px-3 py-1.5 text-xs font-semibold text-zinc-950 transition-colors hover:bg-amber-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {updating ? 'Updating…' : 'Update now'}
        </button>
      </div>
    </div>
  );
}
