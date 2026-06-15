'use client';

/**
 * Authenticated-user analytics identifier (Cluster B1).
 *
 * Bridges the server-verified Supabase user id into client-side PostHog. The
 * dashboard layout already does the authoritative `getUser()` on the server;
 * this client component receives that id as a prop and calls `identifyUser`,
 * which is what makes authenticated product analytics work fully under
 * cookieless persistence (identity comes from the DB, not a cookie).
 *
 * Renders nothing. Mounted inside the dashboard layout where a user is
 * guaranteed to exist.
 *
 * @module components/providers/analytics-identify
 */

import { useEffect } from 'react';
import { identifyUser } from '@/lib/analytics/posthog';

/**
 * @param userId - The authenticated Supabase user id (PostHog distinct_id).
 */
export function AnalyticsIdentify({ userId }: { userId: string }) {
  useEffect(() => {
    identifyUser(userId);
  }, [userId]);

  return null;
}
