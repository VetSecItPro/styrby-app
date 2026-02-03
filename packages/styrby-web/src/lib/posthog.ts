/**
 * PostHog Analytics
 *
 * Product analytics for understanding user behavior.
 * https://posthog.com/docs/libraries/next-js
 */

import posthog from 'posthog-js';

// Initialize PostHog only on client and in production
export function initPostHog() {
  if (typeof window === 'undefined') return;
  if (!process.env.NEXT_PUBLIC_POSTHOG_KEY) return;

  posthog.init(process.env.NEXT_PUBLIC_POSTHOG_KEY, {
    api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com',
    person_profiles: 'identified_only',
    capture_pageview: false, // We handle this manually for SPA navigation
    capture_pageleave: true,
    autocapture: {
      css_selector_allowlist: ['[data-ph-capture]'],
    },
    // Disable in non-production or if not configured
    loaded: (posthog) => {
      if (process.env.NODE_ENV !== 'production') {
        posthog.opt_out_capturing();
      }
    },
  });

  return posthog;
}

// Track page views for App Router
export function trackPageView(url: string) {
  if (typeof window === 'undefined') return;
  posthog.capture('$pageview', { $current_url: url });
}

// Track custom events
export function trackEvent(event: string, properties?: Record<string, unknown>) {
  if (typeof window === 'undefined') return;
  posthog.capture(event, properties);
}

// Identify user
export function identifyUser(userId: string, properties?: Record<string, unknown>) {
  if (typeof window === 'undefined') return;
  posthog.identify(userId, properties);
}

// Reset user (on logout)
export function resetUser() {
  if (typeof window === 'undefined') return;
  posthog.reset();
}

// Feature flags
export function isFeatureEnabled(flag: string): boolean {
  if (typeof window === 'undefined') return false;
  return posthog.isFeatureEnabled(flag) ?? false;
}

// Get feature flag value
export function getFeatureFlag<T>(flag: string, defaultValue: T): T {
  if (typeof window === 'undefined') return defaultValue;
  const value = posthog.getFeatureFlag(flag);
  return (value as T) ?? defaultValue;
}

export default posthog;
