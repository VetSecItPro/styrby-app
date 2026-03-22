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
 * - Dashboard pages: Stale-while-revalidate with 5-minute expiry, so users see
 *   instant loads but always get fresh data on next navigation.
 * - API routes: Network-first with 30-second timeout, falling back to cached
 *   responses when the network is slow or unavailable.
 * - Public pages (marketing/docs/blog): Cache-first with 1-hour expiry, since
 *   these change infrequently and benefit from instant loads.
 */

import { defaultCache } from '@serwist/next/worker';
import type { PrecacheEntry, SerwistGlobalConfig } from 'serwist';
import {
  Serwist,
  CacheFirst,
  StaleWhileRevalidate,
  NetworkFirst,
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

/* eslint-disable @typescript-eslint/no-empty-object-type */

/**
 * Minimal ServiceWorkerGlobalScope for type checking.
 * The actual runtime provides the full interface.
 */
interface ServiceWorkerGlobalScope extends WorkerGlobalScope {
  __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  clients: Clients;
  registration: ServiceWorkerRegistration;
  addEventListener(type: 'sync', listener: (event: SyncEvent) => void): void;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
}

/**
 * Clients interface for communicating with controlled pages.
 */
interface Clients {
  matchAll(options?: { type?: string }): Promise<Client[]>;
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

/* eslint-enable @typescript-eslint/no-empty-object-type */

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

/** 5 minutes in seconds. Used for dashboard page shells. */
const FIVE_MINUTES_SEC = 5 * 60;

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
  // --- Dashboard pages: fast loads with background revalidation ---
  {
    /**
     * WHY stale-while-revalidate for dashboard: Users navigating between
     * dashboard tabs should see instant page loads. SWR serves the cached
     * version immediately and fetches a fresh copy in the background. The
     * 5-minute max age ensures stale data does not persist too long.
     */
    matcher: ({ url }: { url: URL }) =>
      url.pathname.startsWith('/dashboard'),
    handler: new StaleWhileRevalidate({
      cacheName: 'styrby-dashboard-pages',
      plugins: [
        new ExpirationPlugin({
          maxEntries: 32,
          maxAgeSeconds: FIVE_MINUTES_SEC,
          maxAgeFrom: 'last-used',
        }),
      ],
    }),
  },

  // --- API routes: prefer network, fall back to cache when slow/offline ---
  {
    /**
     * WHY network-first for API: API responses contain real-time data
     * (sessions, costs, alerts). We always prefer the freshest response,
     * but if the network is slow (>30s) or offline, serving a cached
     * response is better than showing an error.
     */
    matcher: ({ url }: { url: URL }) =>
      url.pathname.startsWith('/api/'),
    handler: new NetworkFirst({
      cacheName: 'styrby-api-responses',
      networkTimeoutSeconds: API_NETWORK_TIMEOUT_SEC,
      plugins: [
        new ExpirationPlugin({
          maxEntries: 64,
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
          maxEntries: 64,
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
          maxEntries: 128,
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
// Activate Serwist Event Listeners
// ============================================================================

serwist.addEventListeners();
