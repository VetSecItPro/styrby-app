/**
 * useWidgetSync — keeps the iOS home-screen widget showing the user's
 * most-recent session.
 *
 * Mounted once at the app root. On mount and whenever the app returns to the
 * foreground, it fetches the single most-recently-updated session and publishes
 * its status to the widget's App Group. Off iOS (or with no user) it does
 * nothing.
 *
 * WHY a lightweight standalone query (not the useSessions hook): useSessions
 * carries pagination, search, and filter state we don't need here. A single
 * limit(1) read keeps this cheap and avoids double-fetching the session list.
 *
 * @module hooks/useWidgetSync
 */

import { useEffect } from 'react';
import { AppState, Platform } from 'react-native';
import { supabase } from '../lib/supabase';
import { publishWidgetSession } from '../lib/widget-bridge';

/**
 * Sync the most-recent session to the iOS widget for the given user.
 *
 * @param userId - Authenticated user id, or null when signed out.
 */
export function useWidgetSync(userId: string | null): void {
  useEffect(() => {
    // The widget is iOS-only; skip all work (including the query) elsewhere.
    if (Platform.OS !== 'ios' || !userId) return;

    let cancelled = false;

    const syncNow = async () => {
      try {
        const { data, error } = await supabase
          .from('sessions')
          .select('agent_type, status, title, total_cost_usd, updated_at')
          .order('updated_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (cancelled || error) return;

        publishWidgetSession(
          data
            ? {
                agentType: data.agent_type as string,
                status: data.status as string,
                title: (data.title as string | null) ?? null,
                totalCostUsd: Number(data.total_cost_usd) || 0,
                updatedAt: data.updated_at as string,
              }
            : null,
        );
      } catch {
        // Non-fatal: the widget is a progressive enhancement.
      }
    };

    void syncNow();

    // Refresh when the app returns to the foreground so the widget reflects any
    // status changes that happened while it was backgrounded.
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void syncNow();
    });

    return () => {
      cancelled = true;
      sub.remove();
    };
  }, [userId]);
}
