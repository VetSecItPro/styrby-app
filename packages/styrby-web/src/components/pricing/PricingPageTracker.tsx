'use client';

import { useEffect, useRef } from 'react';
import * as Sentry from '@sentry/nextjs';

/**
 * A/B flag name for the new pricing page redesign (Phase 2.8).
 *
 * WHY a named constant: the flag name is referenced in multiple places
 * (page render, CTA click handlers, analytics dashboards). A single
 * constant prevents typos from splitting event cohorts.
 *
 * PostHog integration: when PostHog is installed (post-launch), replace
 * the Sentry-only tracking below with PostHog feature flags:
 *   const variant = posthog.getFeatureFlag('pricing_page_variant');
 *
 * Until then, we use Sentry performance spans as a lightweight conversion
 * proxy. The feature flag logic is pre-wired so the switchover is a 1-line
 * change when PostHog is added to the project.
 */
export const PRICING_AB_FLAG = 'pricing_page_variant' as const;

/**
 * A/B variant values.
 * - 'control': original pricing page (Free / Pro / Power cards)
 * - 'v2': new redesign with Solo / Team / Business / Enterprise + seat slider + ROI calc
 */
export type PricingVariant = 'control' | 'v2';

/**
 * Emits a Sentry performance measurement for pricing page view.
 *
 * WHY Sentry (not PostHog): PostHog is not yet installed in styrby-web.
 * Sentry is already wired (Phase 1.6.6) and supports custom measurements
 * via Sentry.metrics.increment(). This gives us conversion tracking today
 * without blocking the feature on a PostHog install.
 *
 * PostHog migration path (when PostHog is added):
 * 1. npm install posthog-js
 * 2. Add PostHogProvider to layout.tsx
 * 3. Replace Sentry.metrics.increment calls here with posthog.capture()
 * 4. Add posthog.getFeatureFlag(PRICING_AB_FLAG) to decide which variant to render
 *
 * @param event - The event name to track.
 * @param properties - Optional key/value tags for segmentation.
 */
export function trackPricingEvent(
  event: string,
  properties?: Record<string, string | number | boolean>,
): void {
  try {
    // WHY try/catch: Sentry SDK may not be initialized (dev, test, no DSN).
    // Analytics must never crash the pricing page.
    Sentry.addBreadcrumb({
      category: 'pricing',
      message: event,
      data: properties,
      level: 'info',
    });

    // WHY Sentry.captureMessage for conversion events: Sentry.metrics.increment
    // is not available in the sentry/nextjs@10 SDK bundled with this project.
    // Breadcrumbs record the event trail; captureMessage sends it to Sentry
    // for visibility in the Issues dashboard filtered by tag pricing=event.
    // When PostHog is added, replace this with posthog.capture(event, properties).
    if (process.env.NODE_ENV === 'production') {
      Sentry.captureMessage(`pricing.${event}`, {
        level: 'info',
        tags: { pricing_event: event, ...properties } as Record<string, string>,
      });
    }
  } catch {
    // Silent failure intentional — analytics must not affect UX.
  }
}

/**
 * PricingPageTracker - invisible component that fires page-view and variant events.
 *
 * Mounts on the /pricing page, fires exactly once per mount to record:
 * 1. That the pricing page was viewed
 * 2. Which A/B variant was shown
 *
 * This gives us the numerator (views) for conversion rate calculations.
 * CTA clicks fire the denominator events via trackPricingEvent() inline.
 *
 * @param variant - Which variant was rendered ('control' | 'v2').
 */
export function PricingPageTracker({ variant }: { variant: PricingVariant }) {
  // WHY useRef: prevents double-fire in React 18 StrictMode (double-effect invocation).
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current) return;
    fired.current = true;

    trackPricingEvent('page_view', {
      [PRICING_AB_FLAG]: variant,
      path: '/pricing',
    });
  }, [variant]);

  // No DOM output - tracking only.
  return null;
}
