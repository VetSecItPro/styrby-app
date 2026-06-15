/**
 * Product-analytics event catalog (Cluster B1).
 *
 * Single source of truth for every PostHog product-analytics event name that
 * styrby-web and styrby-mobile emit. Centralising the catalog here (rather
 * than scattering string literals across components) means:
 *
 *  1. Web and mobile can never drift on an event name - both import the same
 *     constant, so `dashboard_viewed` is spelled identically everywhere.
 *  2. A single grep enumerates the entire analytics surface.
 *  3. The `AnalyticsEventName` union gives compile-time safety at every
 *     `capture()` call site - a typo is a type error, not a silently-dropped
 *     event that only shows up as a gap in a funnel weeks later.
 *
 * WHY this is separate from `events/registry.ts`: that registry models
 * *outbound domain events* (session.created -> webhooks/realtime) for SOC2
 * audit. This file models *product-analytics events* (what the user did) for
 * PostHog. Different consumers, different lifecycle - deliberately decoupled
 * so the compliance log is never tangled with growth metrics.
 *
 * @module analytics/events
 */

/**
 * Super-property stamped on every Styrby analytics event.
 *
 * WHY: the PostHog project ("Styrby-App") is shared with a sibling product on
 * the free tier, which caps projects per organization. Tagging every event
 * with `product: 'styrby'` keeps the two products' data cleanly filterable in
 * every insight, funnel, and cohort. It also future-proofs a migration: if we
 * later split to a dedicated project, swapping the ingestion key is the only
 * change - the events already carry their product origin.
 */
export const PRODUCT_TAG = 'styrby' as const;

/** The key under which {@link PRODUCT_TAG} is registered as a super-property. */
export const PRODUCT_PROPERTY_KEY = 'product' as const;

/**
 * Curated catalog of product-analytics events.
 *
 * Keys are SCREAMING_SNAKE semantic identifiers used in code; values are the
 * snake_case event names PostHog stores. Keep this list intentional - every
 * entry should answer a real product question. Add events as flows are
 * instrumented; do not pre-register events that nothing emits yet.
 */
export const ANALYTICS_EVENTS = {
  // --- Navigation / page views (custom, in addition to PostHog $pageview) ---
  /** Dashboard home opened. */
  DASHBOARD_VIEWED: 'dashboard_viewed',
  /** Sessions list opened. */
  SESSIONS_VIEWED: 'sessions_viewed',
  /** A single session detail opened. */
  SESSION_VIEWED: 'session_viewed',
  /** Costs / analytics page opened. */
  COSTS_VIEWED: 'costs_viewed',
  /** Team management page opened. */
  TEAM_VIEWED: 'team_viewed',
  /** Tools / MCP registry page opened. */
  TOOLS_VIEWED: 'tools_viewed',
  /** Settings page opened. */
  SETTINGS_VIEWED: 'settings_viewed',
  /** Public pricing page opened. */
  PRICING_VIEWED: 'pricing_viewed',

  // --- Conversion / monetization ---
  /** User clicked an upgrade CTA (carries `from_tier` / `to_tier`). */
  PLAN_UPGRADE_CLICKED: 'plan_upgrade_clicked',
  /** Checkout flow entered. */
  CHECKOUT_STARTED: 'checkout_started',

  // --- Team collaboration ---
  /** A team member invite was sent. */
  MEMBER_INVITED: 'member_invited',

  // --- Tools / MCP ---
  /** An MCP server config snippet was copied. */
  MCP_CONFIG_COPIED: 'mcp_config_copied',

  // --- Auth lifecycle ---
  /** Signup flow started. */
  SIGNUP_STARTED: 'signup_started',
  /** Login flow started. */
  LOGIN_STARTED: 'login_started',
} as const;

/** Union of every valid analytics event name. */
export type AnalyticsEventName =
  (typeof ANALYTICS_EVENTS)[keyof typeof ANALYTICS_EVENTS];

/**
 * Arbitrary event properties. PostHog accepts any JSON-serialisable map;
 * we constrain to primitives + arrays to keep payloads small and queryable.
 */
export type AnalyticsProperties = Record<
  string,
  string | number | boolean | null | undefined | string[] | number[]
>;

/**
 * Merge caller-supplied properties with the mandatory product tag.
 *
 * Centralising this guarantees the `product` super-property is never
 * forgotten on a one-off `capture()` call, even before the SDK-level
 * super-property registration has run (e.g. the very first event in a
 * memory-persistence session).
 *
 * @param props - Event-specific properties (optional).
 * @returns A new object with `product: 'styrby'` merged in. Caller props win
 *   only for non-`product` keys; `product` is always forced to the tag.
 *
 * @example
 * capture(ANALYTICS_EVENTS.PLAN_UPGRADE_CLICKED, withProduct({ to_tier: 'growth' }));
 */
export function withProduct(
  props?: AnalyticsProperties
): AnalyticsProperties & { product: typeof PRODUCT_TAG } {
  return { ...props, [PRODUCT_PROPERTY_KEY]: PRODUCT_TAG };
}
