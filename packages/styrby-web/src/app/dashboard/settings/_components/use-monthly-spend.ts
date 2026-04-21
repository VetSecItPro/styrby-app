'use client';

import { useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Fetches the current calendar-month spend total (USD) from cost_records.
 *
 * WHY: The subscription card shows a real usage bar for paid tiers. Pulling
 * this into a hook lets us test the sum + month-boundary logic without
 * mounting the whole SettingsClient.
 *
 * Returns `null` until the fetch completes (or `null` forever for free tier
 * callers who pass `enabled=false`).
 *
 * @param supabase - Supabase client (reads from cost_records, RLS-scoped to user)
 * @param enabled - Only fetch when true (typically: user is on a paid tier)
 * @returns The month-to-date spend in USD, or null while loading / when disabled.
 */
export function useMonthlySpend(
  supabase: SupabaseClient,
  enabled: boolean
): number | null {
  const [spend, setSpend] = useState<number | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const fetchSpend = async () => {
      const now = new Date();
      // WHY: UTC month boundary — matches the server-side cost aggregator so
      // the dashboard and billing summaries never disagree by a timezone.
      const monthStart = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
      ).toISOString();
      const { data } = await supabase
        .from('cost_records')
        .select('cost_usd')
        .gte('recorded_at', monthStart);
      if (cancelled) return;
      const total = (data || []).reduce(
        (sum: number, r: { cost_usd: number | string | null }) =>
          sum + (Number(r.cost_usd) || 0),
        0
      );
      setSpend(total);
    };
    fetchSpend();
    return () => {
      cancelled = true;
    };
  }, [supabase, enabled]);

  return spend;
}
