/**
 * Styrby PWA Service Worker Entry Point
 *
 * WHY: This service worker provides offline support, intelligent caching, and
 * background sync for the Styrby web dashboard. It ensures the app remains
 * functional when users lose connectivity (e.g., on mobile, in tunnels) and
 * improves perceived performance by serving cached assets instantly.
 *
 * Cache strategies are tuned per resource type:
 * - Static assets (JS/CSS/images): Cache-first with 30-day expiry, since these
 *   are content-hashed and immutable between deploys.
 * - Dashboard pages: Network-only, never cached. Authenticated content must
 *   always be fetched fresh to prevent data leakage on shared devices.
 * - API routes: Network-first with 30-second timeout, falling back to cache
 *   only for unauthenticated/public API responses.
 * - Public pages (marketing/docs/blog): Cache-first with 1-hour expiry, since
 *   these change infrequently and benefit from instant loads.
 */

import { defaultCache } from '@serwist/next/worker';
import type { PrecacheEntry, SerwistGlobalConfig } from 'serwist';
import {
  Serwist,
  CacheFirst,
  NetworkFirst,
  NetworkOnly,
  ExpirationPlugin,
} from 'serwist';

// ============================================================================
// Global Type Declarations
// ============================================================================

/**
 * WHY: The main tsconfig uses the 'dom' lib, which does not include service
 * worker types (ServiceWorkerGlobalScope, ExtendableEvent, SyncEvent, etc.).
 * Adding 'webworker' to the main tsconfig would cause type conflicts with
 * 'dom'. Instead, we declare the minimal types needed here. Serwist's Webpack
 * plugin compiles this file separately, so these declarations only apply to
 * the SW build context.
 */

/**
 * Minimal ServiceWorkerGlobalScope for type checking.
 * The actual runtime provides the full interface.
 */
interface ServiceWorkerGlobalScope extends WorkerGlobalScope {
  __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  clients: Clients;
  registration: ServiceWorkerRegistration;
  location: { origin: string; href: string };
  addEventListener(type: 'install', listener: (event: ExtendableEvent) => void): void;
  addEventListener(type: 'activate', listener: (event: ExtendableEvent) => void): void;
  addEventListener(type: 'sync', listener: (event: SyncEvent) => void): void;
  addEventListener(type: 'periodicsync', listener: (event: PeriodicSyncEvent) => void): void;
  addEventListener(type: 'push', listener: (event: PushEvent) => void): void;
  addEventListener(type: 'message', listener: (event: ExtendableMessageEvent) => void): void;
  addEventListener(
    type: 'notificationclick',
    listener: (event: NotificationEvent) => void
  ): void;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
  skipWaiting(): Promise<void>;
  caches: CacheStorage;
}

/**
 * Clients interface for communicating with controlled pages.
 */
interface Clients {
  matchAll(options?: { type?: string; includeUncontrolled?: boolean }): Promise<Client[]>;
}

/**
 * Represents a controlled client (browser tab/window).
 */
interface Client {
  postMessage(message: unknown): void;
}

/**
 * ExtendableEvent allows the service worker to extend its lifetime
 * with waitUntil() to complete async operations.
 */
interface ExtendableEvent extends Event {
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * SyncEvent fires when the browser regains connectivity after being offline.
 * Part of the Background Sync API.
 */
interface SyncEvent extends ExtendableEvent {
  readonly tag: string;
}

/**
 * PeriodicSyncEvent fires at browser-determined intervals for registered
 * periodic sync tags. Part of the Periodic Background Sync API.
 */
interface PeriodicSyncEvent extends ExtendableEvent {
  readonly tag: string;
}

/**
 * ExtendableMessageEvent fires when the service worker receives a message
 * from a client via postMessage.
 */
interface ExtendableMessageEvent extends ExtendableEvent {
  readonly data: unknown;
  readonly source: Client | null;
}

/**
 * PushEvent fires when the service worker receives a push message
 * from a push service. Contains the encrypted payload sent by the server.
 */
interface PushEvent extends ExtendableEvent {
  readonly data: PushMessageData | null;
}

/**
 * Provides methods to extract data from the push message payload.
 */
interface PushMessageData {
  json(): unknown;
  text(): string;
}

/**
 * NotificationEvent fires when the user clicks on a displayed notification.
 * Provides access to the notification object and its associated data.
 */
interface NotificationEvent extends ExtendableEvent {
  readonly notification: NotificationObject;
  readonly action: string;
}

/**
 * Represents a displayed notification with its properties and methods.
 */
interface NotificationObject {
  readonly title: string;
  readonly body: string;
  readonly data: Record<string, unknown>;
  readonly tag: string;
  close(): void;
}

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {}
}

declare const self: ServiceWorkerGlobalScope;

// ============================================================================
// Cache Duration Constants
// ============================================================================

/** 30 days in seconds. Used for immutable static assets. */
const THIRTY_DAYS_SEC = 30 * 24 * 60 * 60;

/** 1 hour in seconds. Used for public marketing pages. */
const ONE_HOUR_SEC = 60 * 60;

/** 30 seconds. Network timeout before falling back to cache for API calls. */
const API_NETWORK_TIMEOUT_SEC = 30;

/** 1 hour in seconds. Used for cached API responses as stale fallback. */
const API_CACHE_MAX_AGE_SEC = 60 * 60;

// ============================================================================
// Custom Cache Strategies
// ============================================================================

/**
 * Styrby-specific runtime caching rules, applied in order of specificity.
 * These supplement the Serwist defaultCache rules (which handle Next.js
 * static assets, fonts, and images).
 */
const styrbyCache = [
  // --- Dashboard pages: never cache, always fetch from network ---
  {
    /**
     * WHY network-only for dashboard: Dashboard pages contain sensitive,
     * authenticated user data. Caching them (even with short expiry) risks
     * serving stale personal data on shared devices. The offline fallback
     * page handles the no-network case gracefully.
     */
    matcher: ({ url }: { url: URL }) =>
      url.pathname.startsWith('/dashboard'),
    handler: new NetworkOnly(),
  },

  // --- API routes: prefer network, fall back to cache when slow/offline ---
  {
    /**
     * WHY network-first for API: API responses contain real-time data
     * (sessions, costs, alerts). We always prefer the freshest response,
     * but if the network is slow (>30s) or offline, serving a cached
     * response is better than showing an error.
     *
     * WHY exclude Authorization header: Authenticated API responses contain
     * user-specific data that must not be served from cache on shared devices.
     * Only public/unauthenticated API responses are safe to cache.
     */
    matcher: ({ url, request }: { url: URL; request: Request }) =>
      url.pathname.startsWith('/api/') && !request.headers.get('authorization'),
    handler: new NetworkFirst({
      cacheName: 'styrby-api-responses',
      networkTimeoutSeconds: API_NETWORK_TIMEOUT_SEC,
      plugins: [
        new ExpirationPlugin({
          maxEntries: 50,
          maxAgeSeconds: API_CACHE_MAX_AGE_SEC,
          maxAgeFrom: 'last-used',
        }),
      ],
    }),
  },

  // --- Public pages (marketing, docs, blog): instant loads, infrequent changes ---
  {
    /**
     * WHY cache-first for public pages: Marketing pages, docs, and blog
     * articles are static content that changes only on deploy. Cache-first
     * serves them instantly from the SW cache. The 1-hour expiry ensures
     * users eventually see updated content without waiting for a new deploy.
     */
    matcher: ({ url }: { url: URL }) => {
      const publicPaths = [
        '/',
        '/features',
        '/pricing',
        '/security',
        '/privacy',
        '/terms',
        '/dpa',
      ];
      return (
        publicPaths.includes(url.pathname) ||
        url.pathname.startsWith('/blog') ||
        url.pathname.startsWith('/docs')
      );
    },
    handler: new CacheFirst({
      cacheName: 'styrby-public-pages',
      plugins: [
        new ExpirationPlugin({
          maxEntries: 30,
          maxAgeSeconds: ONE_HOUR_SEC,
          maxAgeFrom: 'last-used',
        }),
      ],
    }),
  },

  // --- Static assets (JS/CSS/images): immutable between deploys ---
  {
    /**
     * WHY cache-first with 30-day expiry: Next.js static assets under
     * /_next/static/ are content-hashed, so their URLs change on every
     * deploy. Caching them aggressively is safe and eliminates network
     * requests for repeat visits. The 30-day expiry is a safety net.
     */
    matcher: ({ url }: { url: URL }) =>
      url.pathname.match(/\.(?:js|css|woff2?|png|jpg|jpeg|svg|gif|ico|webp)$/i) !== null,
    handler: new CacheFirst({
      cacheName: 'styrby-static-assets',
      plugins: [
        new ExpirationPlugin({
          maxEntries: 100,
          maxAgeSeconds: THIRTY_DAYS_SEC,
          maxAgeFrom: 'last-used',
        }),
      ],
    }),
  },
];

// ============================================================================
// Service Worker Initialization
// ============================================================================

/**
 * WHY: The Serwist instance ties together precaching (build-time manifest),
 * runtime caching (strategies above), and offline fallback behavior. The
 * styrbyCache rules are prepended to defaultCache so Styrby-specific matchers
 * take priority over Serwist's generic Next.js rules.
 *
 * - skipWaiting: Activate the new SW immediately instead of waiting for all
 *   tabs to close. This ensures users get updates on next navigation.
 * - clientsClaim: Take control of all open tabs immediately after activation
 *   so the SW handles fetches from the first navigation onward.
 * - navigationPreload: Uses the Navigation Preload API to fetch pages from
 *   the network in parallel with SW startup, reducing time-to-first-byte.
 */
const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: [...styrbyCache, ...defaultCache],
  fallbacks: {
    entries: [
      {
        url: '/offline',
        /**
         * WHY: Only document requests should fall back to the offline page.
         * Sub-resource requests (images, scripts) should fail normally so
         * the page can handle missing resources gracefully.
         *
         * @param options - The request/URL context provided by Serwist
         * @returns True if this is a navigation (document) request
         */
        matcher({ request }: { request: Request }) {
          return request.destination === 'document';
        },
      },
    ],
  },
});

// ============================================================================
// Background Sync for Offline Queue
// ============================================================================

/**
 * WHY: The 'sync' event fires when the browser regains connectivity after
 * being offline. By listening for a 'styrby-offline-sync' tag, the service
 * worker can trigger a flush of the IndexedDB offline queue (managed by
 * offlineQueue.ts in the main thread). This is more reliable than window
 * 'online' events because the SW runs in the background even when no tabs
 * are open.
 *
 * The actual queue processing happens in the client via a postMessage call.
 * The SW does not directly import offlineQueue.ts because service workers
 * run in a separate global scope without DOM or window access.
 */
self.addEventListener('sync', (event: SyncEvent) => {
  if (event.tag === 'styrby-offline-sync') {
    event.waitUntil(notifyClientsToSync());
  }
});

/**
 * Notifies all controlled clients (open tabs) to flush their offline queues.
 * Each client receives a message with type 'SYNC_OFFLINE_QUEUE', which the
 * sw-register component listens for and routes to offlineQueue.processQueue().
 *
 * @returns A promise that resolves when all clients have been notified
 */
async function notifyClientsToSync(): Promise<void> {
  const clients = await self.clients.matchAll({ type: 'window' });
  for (const client of clients) {
    client.postMessage({ type: 'SYNC_OFFLINE_QUEUE' });
  }
}

// ============================================================================
// Web Push Notification Handlers
// ============================================================================

/**
 * Expected shape of the push notification payload sent by the server.
 * The server sends this JSON via the web-push library.
 */
interface PushPayload {
  /** Notification title displayed to the user */
  title: string;
  /** Notification body text */
  body: string;
  /** Optional icon URL (defaults to app icon) */
  icon?: string;
  /** Optional URL to open when the notification is clicked */
  url?: string;
  /** Optional tag for notification grouping/replacement */
  tag?: string;
}

/**
 * WHY: The 'push' event fires when the push service delivers a message to
 * this service worker. The server encrypts the payload using the VAPID keys
 * and the subscription's p256dh/auth keys. The browser decrypts it before
 * delivering it here.
 *
 * We display a notification using the Notification API. If the payload is
 * missing or malformed, we show a generic fallback notification so the user
 * still knows something happened.
 */
self.addEventListener('push', (event: PushEvent) => {
  const defaultPayload: PushPayload = {
    title: 'Styrby',
    body: 'You have a new notification.',
  };

  let payload: PushPayload = defaultPayload;

  if (event.data) {
    try {
      const parsed = event.data.json() as Partial<PushPayload>;
      payload = {
        title: parsed.title || defaultPayload.title,
        body: parsed.body || defaultPayload.body,
        icon: parsed.icon,
        url: parsed.url,
        tag: parsed.tag,
      };
    } catch {
      // WHY: If the payload is not valid JSON, fall back to the text content
      // as the notification body. This handles edge cases where the server
      // sends a plain text message instead of structured JSON.
      payload = {
        ...defaultPayload,
        body: event.data.text() || defaultPayload.body,
      };
    }
  }

  const notificationOptions: NotificationOptions = {
    body: payload.body,
    icon: payload.icon || '/icons/icon-192x192.png',
    badge: '/icons/icon-72x72.png',
    tag: payload.tag || 'styrby-notification',
    data: { url: payload.url || '/dashboard' },
  };

  event.waitUntil(
    self.registration.showNotification(payload.title, notificationOptions)
  );
});

/**
 * WHY: The 'notificationclick' event fires when the user clicks on a
 * notification displayed by this service worker. We use the data.url
 * property (set in the push handler above) to navigate the user to the
 * relevant page in the app.
 *
 * We first try to find an existing open tab for the app and focus it.
 * If no tab is open, we open a new one. This prevents spawning duplicate
 * tabs every time a notification is clicked.
 */
self.addEventListener('notificationclick', (event: NotificationEvent) => {
  event.notification.close();

  // WHY: Validate that the notification URL is same-origin before navigating.
  // A malicious push payload could inject an arbitrary URL to redirect users
  // to a phishing site. By restricting to same-origin paths, we prevent open
  // redirect attacks via crafted notification data.
  const rawUrl = (event.notification.data?.url as string) || '/dashboard';
  let targetUrl: string;
  try {
    const parsed = new URL(rawUrl, self.location.origin);
    targetUrl = parsed.origin === self.location.origin
      ? parsed.pathname + parsed.search + parsed.hash
      : '/dashboard';
  } catch {
    targetUrl = '/dashboard';
  }

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window' })
      .then((clientList: Client[]) => {
        // WHY: Look for an existing open tab to reuse. Opening a new tab for
        // every notification click creates tab clutter. We check if any
        // controlled client is already showing the app and focus it instead.
        for (const client of clientList) {
          const windowClient = client as unknown as {
            url: string;
            focus(): Promise<unknown>;
            navigate(url: string): Promise<unknown>;
          };
          if (windowClient.url && windowClient.focus) {
            return windowClient.navigate(targetUrl).then(() => windowClient.focus());
          }
        }
        // No existing tab found, open a new one
        return (self as unknown as { clients: { openWindow(url: string): Promise<unknown> } })
          .clients.openWindow(targetUrl);
      })
  );
});

// ============================================================================
// Cache Cleanup on Activation
// ============================================================================

/**
 * Known cache names managed by Styrby's runtime caching strategies.
 * WHY: When the service worker activates, we delete any caches that are not
 * in this list and not managed by Serwist's precache. This prevents unbounded
 * cache growth from old SW versions that used different cache names.
 */
const KNOWN_CACHES = new Set([
  'styrby-api-responses',
  'styrby-public-pages',
  'styrby-static-assets',
]);

self.addEventListener('activate', (event: ExtendableEvent) => {
  event.waitUntil(
    self.caches.keys().then((cacheNames: string[]) => {
      return Promise.all(
        cacheNames
          .filter((name: string) => {
            // WHY: Only delete caches that start with 'styrby-' but are not
            // in our known set. This avoids deleting Serwist's precache or
            // other framework-managed caches.
            return name.startsWith('styrby-') && !KNOWN_CACHES.has(name);
          })
          .map((name: string) => self.caches.delete(name))
      );
    })
  );
});

// ============================================================================
// SKIP_WAITING Message Handler
// ============================================================================

/**
 * WHY: When a new service worker version is detected and the user clicks
 * "Update available", the client sends a SKIP_WAITING message. This tells
 * the waiting SW to call skipWaiting() and become active immediately,
 * allowing the page to reload with the new version.
 */
self.addEventListener('message', (event: ExtendableMessageEvent) => {
  const data = event.data as { type?: string } | null;
  if (data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ============================================================================
// Periodic Background Sync for Cost Updates
// ============================================================================

/**
 * WHY: The Periodic Background Sync API allows the SW to periodically refresh
 * cached data even when no tabs are open. We use it to keep the daily cost
 * summary fresh so the dashboard loads instantly with recent data. The browser
 * controls the actual sync interval based on site engagement; our minInterval
 * of 1 hour is a hint, not a guarantee.
 *
 * Guard: The periodicsync event only fires on browsers that support the API
 * (currently Chromium-based). Other browsers simply never fire the event.
 */
self.addEventListener('periodicsync', (event: PeriodicSyncEvent) => {
  if (event.tag === 'cost-refresh') {
    event.waitUntil(refreshCostCache());
  }
});

/**
 * Notifies open clients to refresh their cost data via the main thread.
 * Called by the periodic background sync handler.
 *
 * WHY: We cannot safely cache authenticated API responses from the SW
 * because credentials are tied to the main thread's cookie/session context.
 * Instead, notify open clients to trigger their own fresh fetch.
 *
 * @returns A promise that resolves when all clients have been notified
 */
async function refreshCostCache(): Promise<void> {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: false });
  for (const client of clients) {
    client.postMessage({ type: 'REFRESH_COSTS' });
  }
}

// ============================================================================
// Activate Serwist Event Listeners
// ============================================================================

serwist.addEventListeners();
