/**
 * GET /api/costs/forecast?days=30
 *
 * Returns a cost forecast for the authenticated user based on their daily
 * spend history for the last 30 days. Uses the shared cost-forecast module
 * (packages/styrby-shared/src/cost-forecast/forecast.ts) so the same EMA-blend
 * math drives this API, the mobile screen, and the nightly predictive alert cron.
 *
 * @auth Required - Supabase Auth JWT via cookie
 *
 * @queryParam days - Number of history days to fetch (default: 30, max: 30).
 *   Clamped server-side — clients cannot request more than 30 days.
 *
 * @returns 200 {
 *   dailyAverageCents: number,
 *   trailingWeekAverageCents: number,
 *   weightedForecastCents: { '7d': number, '14d': number, '30d': number },
 *   predictedExhaustionDate: string | null,
 *   isBurnAccelerating: boolean,
 *   tier: string,
 *   quotaCents: number | null,
 *   elapsedCents: number
 * }
 *
 * @error 401 { error: 'Unauthorized' }
 * @error 500 { error: 'Forecast failed' }
 *
 * Audit: SOC2 CC7.2 — System monitoring / cost accounting accuracy
 *
 * @module api/costs/forecast
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { computeForecast, type DailyCostPoint } from '@styrby/shared';
import { rateLimit, RATE_LIMITS, rateLimitResponse } from '@/lib/rateLimit';

// ---------------------------------------------------------------------------
// Tier quota table (integer cents)
// ---------------------------------------------------------------------------

/**
 * Monthly cost quotas per tier in integer cents.
 *
 * WHY integer cents: Avoids floating-point comparison drift in alert
 * idempotency checks that compare elapsedCents against quotaCents.
 *
 * WHY colocated here not in shared: quota values are billing-domain concerns
 * that differ by surface. The CLI has no quota enforcement; web/mobile do.
 * Keeping this table here avoids a dependency loop through shared/.
 *
 * WHY null for Power/Team/Business/Enterprise: These tiers are BYOK — users
 * supply their own API keys and set their own spend limits via budget alerts.
 * Styrby has no platform-level cap to enforce on their behalf.
 */
const TIER_QUOTA_CENTS: Record<string, number | null> = {
  free: 500,        // $5 soft cap (free tier)
  pro: 5000,        // $50 cap
  power: null,      // BYOK — uncapped
  team: null,       // BYOK — uncapped
  business: null,   // BYOK — uncapped
  enterprise: null, // BYOK — uncapped
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Fetches the authenticated user's subscription tier.
 *
 * @param supabase - Authenticated Supabase client
 * @param userId - Authenticated user ID
 * @returns Tier string, defaulting to 'free' when no active subscription found
 */
async function getUserTier(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string
): Promise<string> {
  const { data } = await supabase
    .from('subscriptions')
    .select('tier')
    .eq('user_id', userId)
    .eq('status', 'active')
    .single();

  return data?.tier ?? 'free';
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

/**
 * GET /api/costs/forecast
 *
 * Fetches 30 days of daily cost_records, runs the EMA-blend forecast, and
 * returns a complete forecast payload. No server-side caching is applied —
 * cost_records is BRIN-indexed for fast time-series reads (see migration 022).
 * Response includes Cache-Control: no-store so user-specific financial data
 * is never served from a shared CDN cache.
 *
 * @param request - Incoming Next.js request
 * @returns NextResponse with forecast payload
 */
export async function GET(request: NextRequest) {
  // Rate limit: standard (100 req/min) — read-only endpoint, not expensive
  const { allowed, retryAfter } = await rateLimit(request, RATE_LIMITS.standard, 'costs-forecast');
  if (!allowed) {
    return rateLimitResponse(retryAfter!);
  }

  try {
    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // WHY 30 days max: The EMA blend uses a 30-day series for the long-run
    // baseline. Requesting more would not improve forecast accuracy and would
    // slow the query against a large cost_records table.
    const daysParam = parseInt(request.nextUrl.searchParams.get('days') ?? '30', 10);
    const historyDays = Math.min(Math.max(isNaN(daysParam) ? 30 : daysParam, 1), 30);

    const historyStart = new Date();
    historyStart.setUTCDate(historyStart.getUTCDate() - historyDays);
    const historyStartIso = historyStart.toISOString();

    // Billing period start (1st of current month, UTC midnight)
    const now = new Date();
    const billingStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();

    // Fetch daily cost aggregate and MTD total in parallel
    const [dailyResult, mtdResult, tier] = await Promise.all([
      // Daily aggregation for the forecast series.
      // WHY only api-key billing_model: subscription and credit rows have
      // cost_usd = 0 by construction (migration 022). Including them would
      // dilute the per-day average with zero-cost rows and make the EMA
      // underestimate burn for api-key users.
      supabase
        .from('cost_records')
        .select('recorded_at, cost_usd')
        .eq('user_id', user.id)
        .eq('billing_model', 'api-key')
        .gte('recorded_at', historyStartIso)
        .order('recorded_at', { ascending: true })
        .limit(10_000),

      // MTD total for elapsedCents in the exhaustion date calculation.
      supabase
        .from('cost_records')
        .select('cost_usd')
        .eq('user_id', user.id)
        .eq('billing_model', 'api-key')
        .gte('recorded_at', billingStart)
        .limit(10_000),

      getUserTier(supabase, user.id),
    ]);

    if (dailyResult.error) {
      console.error('[forecast] cost_records daily query failed:', dailyResult.error.message);
      return NextResponse.json({ error: 'Forecast failed' }, { status: 500 });
    }
    if (mtdResult.error) {
      console.error('[forecast] cost_records MTD query failed:', mtdResult.error.message);
      return NextResponse.json({ error: 'Forecast failed' }, { status: 500 });
    }

    // Aggregate raw rows into daily buckets (YYYY-MM-DD → cents)
    // WHY in-memory aggregation: Postgres GROUP BY with date_trunc would
    // require a raw SQL call that bypasses RLS. The fetch is already filtered
    // by user_id via RLS, so in-memory grouping is both safe and fast for
    // the expected volume (<10K rows / 30-day window for any real user).
    const buckets = new Map<string, number>();

    for (const row of dailyResult.data ?? []) {
      const day = new Date(row.recorded_at).toISOString().slice(0, 10);
      const cents = Math.round((Number(row.cost_usd) || 0) * 100);
      buckets.set(day, (buckets.get(day) ?? 0) + cents);
    }

    const series: DailyCostPoint[] = Array.from(buckets.entries()).map(([date, costCents]) => ({
      date,
      costCents,
    }));

    // MTD elapsed spend in cents
    const elapsedCents = (mtdResult.data ?? []).reduce(
      (sum, row) => sum + Math.round((Number(row.cost_usd) || 0) * 100),
      0
    );

    const quotaCents = TIER_QUOTA_CENTS[tier] ?? null;

    const forecast = computeForecast({
      series,
      quotaCents,
      elapsedCents,
      nowUtc: now,
    });

    return NextResponse.json(
      {
        ...forecast,
        tier,
        quotaCents,
        elapsedCents,
      },
      {
        // WHY no-store: forecast contains user-specific financial data.
        // Serving a cached response from a shared CDN layer would expose
        // one user's spend data to another (SOC2 CC6.1 violation).
        headers: { 'Cache-Control': 'no-store' },
      }
    );
  } catch (error) {
    const isDev = process.env.NODE_ENV === 'development';
    console.error(
      '[forecast] Unexpected error:',
      isDev ? error : error instanceof Error ? error.message : 'Unknown error'
    );
    return NextResponse.json({ error: 'Forecast failed' }, { status: 500 });
  }
}
