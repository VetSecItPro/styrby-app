/**
 * Founder Error-Class Histogram API
 *
 * GET /api/admin/founder-error-histogram
 *
 * Returns a 30-day daily breakdown of audit_log error events grouped by
 * the error_class taxonomy added in migration 029.
 *
 * This endpoint feeds the ErrorClassHistogram component on the founder
 * dashboard. Data is pre-pivoted server-side so the chart component
 * receives ready-to-render rows.
 *
 * WHY service-role: audit_log is RLS-restricted to the owning user_id.
 * The founder dashboard aggregates across ALL users. createAdminClient()
 * (service-role) bypasses RLS. The is_admin gate below is the access control.
 *
 * WHY 30 days hardcoded: The founder dashboard currently has a single
 * fixed time window. If variable windows are needed in the future, add a
 * `?days=` query param and validate against an allowlist.
 *
 * WHY no pagination: At 30 days × 5 error classes = 150 rows max.
 * The full result set is tiny and safe to return in one response.
 *
 * @auth   Required - Supabase Auth JWT via cookie (is_admin = true)
 * @rateLimit 10 requests per minute
 *
 * @returns 200 {
 *   histogram: Array<{
 *     date: string,         // 'YYYY-MM-DD'
 *     network: number,
 *     auth: number,
 *     supabase: number,
 *     agent_crash: number,
 *     unknown: number
 *   }>,
 *   computedAt: string      // ISO 8601 timestamp
 * }
 *
 * @error 401 { error: 'Unauthorized' }
 * @error 403 { error: 'Forbidden' }
 * @error 429 { error: 'RATE_LIMITED', retryAfter: number }
 * @error 500 { error: 'INTERNAL_ERROR', message: string }
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient, createAdminClient } from '@/lib/supabase/server';
import { isAdmin } from '@/lib/admin';
import { rateLimit, RATE_LIMITS, rateLimitResponse } from '@/lib/rateLimit';
import { ERROR_CLASSES, type ErrorClass } from '@styrby/shared/errors';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single day's error count, keyed by error class.
 * This is the output row shape consumed by ErrorClassHistogram.
 */
type HistogramDay = {
  date: string;
} & Record<ErrorClass, number>;

/**
 * Raw row from the Supabase audit_log aggregation query.
 */
interface AuditLogRow {
  /** ISO date string (YYYY-MM-DD) from DATE_TRUNC('day', created_at) */
  record_date: string;
  /** error_class value (one of ERROR_CLASSES) */
  error_class: string;
  /** Count of rows for this (date, error_class) combination */
  count: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generates an array of ISO date strings covering the last N days.
 *
 * WHY: The audit_log query returns only days where errors occurred. The
 * chart needs a contiguous date series so it can show "zero errors" bars
 * on quiet days. Without this, the X axis would skip dates and distort
 * the visual trend.
 *
 * @param days - Number of days to generate (inclusive of today)
 * @returns Array of 'YYYY-MM-DD' strings in ascending order
 */
function generateDateSeries(days: number): string[] {
  const dates: string[] = [];
  const today = new Date();

  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().split('T')[0] as string);
  }

  return dates;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

/**
 * Handles GET /api/admin/founder-error-histogram.
 *
 * Auth-gates to is_admin users. Aggregates audit_log.error_class by day
 * over the last 30 days and pivots into the histogram shape.
 *
 * @param request - Incoming Next.js request
 * @returns JSON histogram payload
 */
export async function GET(request: NextRequest) {
  // Rate limit (shared bucket with other founder-metrics routes)
  const { allowed, retryAfter } = await rateLimit(request, RATE_LIMITS.standard, 'founder-error-histogram');
  if (!allowed) {
    return rateLimitResponse(retryAfter!);
  }

  // Auth gate
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Admin gate — must have is_admin = true in profiles
  const adminOk = await isAdmin(user.id);
  if (!adminOk) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    const DAYS = 30;
    const adminDb = await createAdminClient();

    // Compute the lookback window start date.
    // WHY DATE_TRUNC in the query (not a timestamp): We group by date, so
    // filtering by the day boundary (midnight UTC) gives correct 30-day windows.
    const windowStart = new Date();
    windowStart.setDate(windowStart.getDate() - DAYS);
    const windowStartDate = windowStart.toISOString().split('T')[0];

    // Query audit_log for error-class grouped by day.
    // WHY NOT raw SQL / rpc: The Supabase JS client supports `select()` with
    // aggregate-like patterns via `.select('col1, col2')`. For GROUP BY we use
    // a raw query via `.rpc()` or a manual aggregation approach.
    //
    // WHY we use `.select()` + JS aggregation (not .rpc):
    //   We don't have a pre-existing RPC for this query. Calling
    //   createAdminClient().rpc('...') would require a new DB function. Instead
    //   we fetch the raw error-class rows (bounded to 30 days × 5 classes =
    //   very small dataset) and aggregate in JS. This avoids a new migration
    //   dependency and is performant at this data scale.
    //
    //   The idx_audit_log_error_class partial index (migration 029) makes this
    //   scan fast even at millions of audit rows.
    const { data: rawRows, error: queryError } = await adminDb
      .from('audit_log')
      .select('created_at, error_class')
      .not('error_class', 'is', null)
      .gte('created_at', `${windowStartDate}T00:00:00.000Z`)
      .order('created_at', { ascending: true })
      // WHY limit: 30 days × ~1000 errors/day = 30k rows max. This is our
      // safety guard. If genuine error rates exceed this, a DB-level GROUP BY
      // (via RPC) becomes the right optimisation — but that's not today's problem.
      .limit(30000);

    if (queryError) {
      console.error('[founder-error-histogram] query error:', queryError.message);
      return NextResponse.json(
        { error: 'INTERNAL_ERROR', message: 'Failed to query error histogram' },
        { status: 500 }
      );
    }

    // Aggregate raw rows into (date, error_class) → count map
    const buckets: Map<string, Map<ErrorClass, number>> = new Map();

    for (const row of rawRows ?? []) {
      const date = (row.created_at as string).split('T')[0];
      const cls = row.error_class as ErrorClass;

      if (!buckets.has(date)) buckets.set(date, new Map());
      const dayMap = buckets.get(date)!;
      dayMap.set(cls, (dayMap.get(cls) ?? 0) + 1);
    }

    // Build a contiguous date series with zeros for days with no errors.
    // WHY zeros (not omit): Recharts renders gaps in data as missing bars,
    // which distorts the visual trend. Explicit zeros give a correct flat line.
    const dateSeries = generateDateSeries(DAYS);

    const histogram: HistogramDay[] = dateSeries.map((date) => {
      const dayMap = buckets.get(date);

      // Build one record per day with a count for each error class.
      const counts = Object.fromEntries(
        ERROR_CLASSES.map((cls) => [cls, dayMap?.get(cls) ?? 0])
      ) as Record<ErrorClass, number>;

      return { date, ...counts };
    });

    return NextResponse.json({
      histogram,
      computedAt: new Date().toISOString(),
    });
  } catch (err) {
    const isDev = process.env.NODE_ENV === 'development';
    console.error(
      '[founder-error-histogram] unhandled error:',
      isDev ? err : err instanceof Error ? err.message : 'Unknown error'
    );
    return NextResponse.json(
      { error: 'INTERNAL_ERROR', message: 'Failed to compute error histogram' },
      { status: 500 }
    );
  }
}
