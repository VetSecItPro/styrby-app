/**
 * useForecast — mobile hook for EMA-blend cost forecast (Phase 3.4).
 *
 * Fetches the forecast payload from GET /api/costs/forecast and returns it
 * in the shape expected by the mobile {@link ForecastCard} component.
 *
 * WHY a separate hook (not merged into useRunRate):
 *   useRunRate queries Supabase directly for MTD aggregations. useForecast
 *   hits the web API route which handles the 30-day series aggregation and
 *   the computeForecast() math server-side. Keeping them separate means:
 *     1. The web API is the single source of forecast math (DRY across web + mobile)
 *     2. useRunRate stays fast (two targeted DB queries) — adding a 30-day
 *        series scan to it would slow the initial paint
 *
 * WHY hit the web API from mobile rather than querying Supabase directly:
 *   The forecast API does in-memory daily bucketing (group-by in JS) which
 *   is simpler to test and maintain than a Supabase RPC. The mobile app
 *   already calls web API routes for other features (onboarding, exports).
 *   The API adds no round-trip latency penalty over a direct DB call from
 *   this region.
 *
 * @module hooks/useForecast
 */

import { useState, useEffect, useCallback } from 'react';
import { getApiBaseUrl } from '../lib/config';
import type { CostForecast } from 'styrby-shared';

// ============================================================================
// Types
// ============================================================================

/**
 * Forecast payload as returned by GET /api/costs/forecast.
 * Extends {@link CostForecast} with server-side tier context.
 */
export type ForecastPayload = CostForecast & {
  /** User's current billing tier (e.g. 'free', 'pro', 'power'). */
  tier: string;
  /** Monthly quota ceiling in integer cents, or null for uncapped tiers. */
  quotaCents: number | null;
  /** Amount already consumed in the current billing period (integer cents). */
  elapsedCents: number;
};

/**
 * Return value of {@link useForecast}.
 */
export interface UseForecastReturn {
  /**
   * The forecast payload, or null while loading or on error.
   */
  forecast: ForecastPayload | null;

  /**
   * True while the initial fetch is in progress.
   * Callers show a loading skeleton when true.
   */
  isLoading: boolean;

  /**
   * True when the fetch failed (network error or non-2xx HTTP status).
   * The ForecastCard shows an error state when true.
   */
  error: boolean;

  /**
   * Trigger a manual refresh (e.g. on pull-to-refresh).
   */
  refresh: () => void;
}

// ============================================================================
// Hook
// ============================================================================

/**
 * useForecast fetches the EMA-blend cost forecast from the web API.
 *
 * @returns {@link UseForecastReturn}
 *
 * @example
 * const { forecast, isLoading, error } = useForecast();
 * return <ForecastCard forecast={forecast} loading={isLoading} error={error} />;
 */
export function useForecast(): UseForecastReturn {
  const [forecast, setForecast] = useState<ForecastPayload | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(false);

  const fetchForecast = useCallback(async () => {
    setIsLoading(true);
    setError(false);

    try {
      const response = await fetch(`${getApiBaseUrl()}/api/costs/forecast`, {
        // WHY no-cache: forecast data changes as the user accumulates spend.
        // We want the latest projection on each mount and manual refresh.
        cache: 'no-cache',
        headers: {
          'Content-Type': 'application/json',
        },
        // WHY credentials: 'include': The forecast API uses Supabase Auth
        // cookie-based auth (same as all other Styrby API routes). The mobile
        // app stores session cookies in the WebView cookie jar when the user
        // authenticates. 'include' forwards them to the API.
        credentials: 'include',
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json() as ForecastPayload;
      setForecast(data);
    } catch {
      setError(true);
      setForecast(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchForecast();
  }, [fetchForecast]);

  return { forecast, isLoading, error, refresh: fetchForecast };
}
