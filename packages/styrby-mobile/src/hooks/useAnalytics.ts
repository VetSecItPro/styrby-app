/**
 * useAnalytics — mounts mobile product analytics at the app root.
 *
 * Mounted once in the root layout. Two responsibilities:
 *  1. Identify: when a user id is present, associate analytics with their
 *     first-party Supabase id; on sign-out, reset to a fresh anonymous id.
 *  2. Screen views: capture a `$screen` event on every route change (the
 *     mobile analog of web pageviews).
 *
 * Both no-op when no PostHog key is configured (the thin client handles that),
 * so dev builds without a key are unaffected.
 *
 * @module hooks/useAnalytics
 */

import { useEffect } from 'react';
import { usePathname } from 'expo-router';
import { identifyUser, resetUser, captureScreen } from '../lib/analytics/posthog';

/**
 * Wire analytics identity + screen tracking to auth state and navigation.
 *
 * @param userId - Authenticated Supabase user id, or null when signed out.
 */
export function useAnalytics(userId: string | null): void {
  // Identity follows auth state.
  useEffect(() => {
    if (userId) {
      identifyUser(userId);
    } else {
      resetUser();
    }
  }, [userId]);

  // One screen view per route change.
  const pathname = usePathname();
  useEffect(() => {
    if (pathname) captureScreen(pathname);
  }, [pathname]);
}
