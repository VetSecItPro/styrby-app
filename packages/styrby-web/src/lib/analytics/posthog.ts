/**
 * Web PostHog client wrapper (Cluster B1).
 *
 * A thin, SSR-safe, lazy-loaded layer over `posthog-js`. Every export is a
 * no-op when PostHog is not configured (no key, or running on the server),
 * so call sites never null-check - they just call `capture(...)`.
 *
 * WHY lazy (dynamic import): the full `posthog-js` SDK is ~100KB gzipped.
 * Statically importing it would push it into the route's first-load JS and
 * blow the bundle-size budget (and hurt first paint). Analytics is
 * non-critical, so we `import('posthog-js')` only after mount - webpack
 * splits it into a separate async chunk that loads after hydration. First-load
 * JS stays at baseline; analytics initialises a beat later.
 *
 * WHY a shared load-promise: because the SDK arrives asynchronously, a
 * `capture()` fired before the chunk lands would otherwise be dropped. Every
 * call routes through {@link ensureLoaded}, so early events queue behind the
 * single in-flight load and flush once PostHog is ready - no race, no loss.
 *
 * Privacy posture (operator decision, cookieless + identified-only):
 *  - `persistence: 'memory'` - PostHog sets NO cookies and writes NO
 *    localStorage. Keeps the "no tracking or analytics cookies" promise true.
 *  - `person_profiles: 'identified_only'` - profiles exist only for users we
 *    explicitly {@link identifyUser} by their first-party Supabase id.
 *
 * @module lib/analytics/posthog
 */

'use client';

import type { PostHog } from 'posthog-js';
import {
  PRODUCT_PROPERTY_KEY,
  PRODUCT_TAG,
  withProduct,
  type AnalyticsEventName,
  type AnalyticsProperties,
} from '@styrby/shared';

/**
 * Public (client-side) PostHog ingestion key (the `phc_...` value).
 * Absent in environments where analytics is intentionally off (wrapper
 * then no-ops). Public by design - safe to expose to the browser.
 */
const POSTHOG_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY;

/** PostHog ingestion host. US cloud is `us.i.posthog.com`; default when unset. */
const POSTHOG_HOST =
  process.env.NEXT_PUBLIC_POSTHOG_HOST ?? 'https://us.i.posthog.com';

/** Resolved SDK instance once the async chunk has loaded + initialised. */
let phInstance: PostHog | null = null;

/** Single in-flight load+init promise; also the queue behind which early calls wait. */
let loadPromise: Promise<PostHog | null> | null = null;

/**
 * Whether analytics is active: a key is configured and we're in the browser.
 * @returns true when `capture`/`identify` will actually reach PostHog.
 */
export function isAnalyticsEnabled(): boolean {
  return Boolean(POSTHOG_KEY) && typeof window !== 'undefined';
}

/**
 * Lazily load `posthog-js`, initialise it cookielessly, and cache the
 * instance. Idempotent - repeated calls return the same in-flight/settled
 * promise, so the SDK is fetched and initialised exactly once.
 *
 * @returns The initialised PostHog instance, or null if analytics is disabled.
 */
function ensureLoaded(): Promise<PostHog | null> {
  if (!isAnalyticsEnabled()) return Promise.resolve(null);
  if (loadPromise) return loadPromise;

  loadPromise = import('posthog-js').then(({ default: posthog }) => {
    posthog.init(POSTHOG_KEY as string, {
      api_host: POSTHOG_HOST,
      // Cookieless: no cookies, no localStorage. See module docblock.
      persistence: 'memory',
      // No anonymous person profiles - only users we explicitly identify.
      person_profiles: 'identified_only',
      // App Router fires its own route-change pageviews; disable the SDK's
      // history autocapture so we don't double-count navigations.
      capture_pageview: false,
      // Respect Do Not Track at the SDK level as a second guard.
      respect_dnt: true,
      // WHY disable every optional auto-loaded module: by default posthog-js
      // lazy-fetches recorder/surveys/dead-clicks/web-vitals/autocapture
      // scripts from us-assets.i.posthog.com. We deliberately want ONLY manual
      // events + pageviews (minimal, cookieless posture), so these are unwanted
      // - and our CSP script-src intentionally does not allow remote scripts,
      // so the browser would block them with console errors. Turning them off
      // here means zero blocked requests, zero console noise, smaller runtime.
      // Feature posture: every optional module OFF (manual events + pageviews
      // only; cookieless). These flags stop the modules from *running* /
      // capturing. NOTE (verified in a live browser): they do NOT stop the SDK
      // *fetching* a couple of its own bootstrap scripts (remote config.js, the
      // dead-clicks loader) from us-assets.i.posthog.com — those are allowed in
      // the CSP script-src (see next.config.ts) and stay inert because of these
      // flags. disable_external_dependency_loading is kept as belt-and-suspenders
      // (it does suppress the heavier recorder/surveys/web-vitals loads).
      disable_external_dependency_loading: true,
      autocapture: false,
      capture_dead_clicks: false,
      capture_performance: false, // disables the web-vitals module
      disable_session_recording: true,
      disable_surveys: true,
      loaded: (ph) => {
        // Stamp the product tag on every event for the shared "Styrby-App"
        // project so Styrby data stays filterable from the sibling product.
        ph.register({ [PRODUCT_PROPERTY_KEY]: PRODUCT_TAG });
      },
    });
    phInstance = posthog;
    return posthog;
  });

  return loadPromise;
}

/**
 * Begin loading + initialising analytics (fire-and-forget). Call once high in
 * the tree. No-ops when analytics is disabled.
 */
export function initAnalytics(): void {
  void ensureLoaded();
}

/**
 * Capture a product-analytics event. Queues behind the SDK load if it hasn't
 * finished yet, so events fired early are not lost.
 *
 * @param event - A name from the shared {@link AnalyticsEventName} catalog.
 * @param properties - Optional event properties; the product tag is merged in.
 */
export function capture(
  event: AnalyticsEventName,
  properties?: AnalyticsProperties
): void {
  void ensureLoaded().then((ph) => ph?.capture(event, withProduct(properties)));
}

/**
 * Capture a manual pageview (App Router route change).
 * @param url - The full URL (pathname + search) of the viewed page.
 */
export function capturePageview(url: string): void {
  void ensureLoaded().then((ph) =>
    ph?.capture('$pageview', withProduct({ $current_url: url }))
  );
}

/**
 * Associate subsequent events with an authenticated user, keyed by their
 * stable Supabase id. This is what makes authenticated product analytics work
 * fully under cookieless persistence (identity comes from the DB, not a cookie).
 *
 * @param userId - The Supabase `auth.users` id (used as PostHog distinct_id).
 * @param properties - Optional person properties to set.
 */
export function identifyUser(
  userId: string,
  properties?: AnalyticsProperties
): void {
  if (!userId) return;
  void ensureLoaded().then((ph) => ph?.identify(userId, withProduct(properties)));
}

/**
 * Clear the identified user (call on sign-out) so the next session starts
 * anonymous - prevents a just-signed-out user's events landing on their profile.
 */
export function resetUser(): void {
  void ensureLoaded().then((ph) => ph?.reset());
}
