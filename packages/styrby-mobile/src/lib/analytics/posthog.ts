/**
 * Mobile PostHog thin client (Cluster B1 PR2).
 *
 * A dependency-free analytics client that POSTs directly to PostHog's public
 * capture endpoint. Every export is a no-op when no key is configured.
 *
 * WHY a thin fetch client instead of `posthog-react-native`:
 *  - Zero native dependencies. The full SDK pulls expo-application,
 *    expo-localization, and @react-native-async-storage/async-storage - new
 *    native modules into a package whose Metro/pnpm build is already delicate
 *    (see styrby-backlog "KNOWN BLOCKER #2"). A fetch client adds nothing
 *    native and can't destabilise the build.
 *  - Shared contract, not a seam. It consumes the SAME @styrby/shared/analytics
 *    catalog as web, so event names and the product tag can never drift
 *    between platforms. Only the transport (fetch vs SDK) differs.
 *  - `/i/v0/e/` is PostHog's official ingestion endpoint - the SDKs wrap it.
 *  - Consistent with web, which also captures manually (no autocapture).
 *
 * Deliberately out of scope for this first cut (NOT debt - documented choice):
 * autocapture, feature flags, session replay, and an offline/batched queue.
 * Capture is fire-and-forget; a dropped event when offline is acceptable for
 * product analytics and never affects the user. Revisit if/when mobile needs
 * feature flags (that would justify adopting the full SDK).
 *
 * Privacy posture (mirrors web): anonymous identity is in-memory only (a fresh
 * id per app launch, never persisted), so we build no durable anonymous
 * profile; logged-in users are identified by their first-party Supabase id.
 *
 * @module lib/analytics/posthog
 */

import {
  withProduct,
  type AnalyticsEventName,
  type AnalyticsProperties,
} from 'styrby-shared';

/**
 * Public (client-side) PostHog ingestion key (the `phc_...` value). Absent
 * when analytics is intentionally off (the client then no-ops). EXPO_PUBLIC_*
 * vars are inlined into the bundle at build time.
 */
const POSTHOG_KEY = process.env.EXPO_PUBLIC_POSTHOG_KEY;

/** Ingestion host. US cloud is `us.i.posthog.com`; default when unset. */
const POSTHOG_HOST =
  process.env.EXPO_PUBLIC_POSTHOG_HOST ?? 'https://us.i.posthog.com';

/**
 * Current distinct id. Starts as an ephemeral in-memory anonymous id (no
 * persistence across launches, mirroring web's memory persistence) and is
 * swapped to the Supabase user id once {@link identifyUser} is called.
 */
let distinctId = freshAnonymousId();

/**
 * Generate a per-launch anonymous id. In-memory only - intentionally not
 * persisted, so a returning anonymous user is a new id (no durable profile).
 */
function freshAnonymousId(): string {
  // Date.now()+random is sufficient for an ephemeral, non-persisted id; this
  // is app-runtime code (the Workflow-sandbox Date/Math restriction does not
  // apply here).
  return `anon-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Whether analytics is active (a key is configured).
 * @returns true when capture/identify will actually POST to PostHog.
 */
export function isAnalyticsEnabled(): boolean {
  return Boolean(POSTHOG_KEY);
}

/**
 * Low-level POST to PostHog's capture endpoint. Fire-and-forget: never throws,
 * never blocks the UI, and swallows network errors (analytics must never crash
 * or stall the app).
 *
 * @param event - PostHog event name (catalog event or a `$`-prefixed builtin).
 * @param properties - Fully-formed event properties (already product-tagged).
 * @param distinct - The distinct_id to attribute the event to.
 * @returns A promise that always resolves (exposed for tests; callers fire-and-forget).
 */
export async function post(
  event: string,
  properties: Record<string, unknown>,
  distinct: string
): Promise<void> {
  if (!isAnalyticsEnabled()) return;
  try {
    await fetch(`${POSTHOG_HOST}/i/v0/e/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: POSTHOG_KEY,
        event,
        distinct_id: distinct,
        properties,
      }),
    });
  } catch {
    // Swallow: a failed analytics POST must never surface to the user.
  }
}

/**
 * Capture a product-analytics event.
 *
 * @param event - A name from the shared {@link AnalyticsEventName} catalog.
 * @param properties - Optional event properties; the product tag is merged in.
 */
export function capture(
  event: AnalyticsEventName,
  properties?: AnalyticsProperties
): void {
  void post(event, withProduct(properties), distinctId);
}

/**
 * Capture a screen view (the mobile analog of a web pageview).
 * @param screenName - The route/screen name (e.g. a pathname or segment).
 */
export function captureScreen(screenName: string): void {
  void post('$screen', withProduct({ $screen_name: screenName }), distinctId);
}

/**
 * Associate subsequent events with an authenticated user, keyed by their
 * stable Supabase id. Sends a `$identify` that sets the product tag as a
 * person property.
 *
 * @param userId - The Supabase `auth.users` id (used as distinct_id).
 * @param properties - Optional person properties to set.
 */
export function identifyUser(
  userId: string,
  properties?: AnalyticsProperties
): void {
  if (!userId) return;
  distinctId = userId;
  void post('$identify', { $set: withProduct(properties) }, userId);
}

/**
 * Clear the identified user (call on sign-out): reset to a fresh anonymous id
 * so the next session starts unattributed.
 */
export function resetUser(): void {
  distinctId = freshAnonymousId();
}

/** Test-only: read the current distinct id. */
export function _getDistinctId(): string {
  return distinctId;
}
