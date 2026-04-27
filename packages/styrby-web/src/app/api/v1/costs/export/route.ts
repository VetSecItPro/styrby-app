/**
 * GET /api/v1/costs/export
 *
 * Exports raw cost records for the authenticated user in CSV or JSON format.
 * This endpoint is restricted to Power tier subscribers.
 *
 * WHY CSV export: Power users are often agencies or teams tracking AI spend
 * across projects. They need raw data for Excel/Sheets analysis, accounting
 * tools, and custom dashboards. CSV is the universal interchange format for
 * financial data.
 *
 * @auth Required - API key via Authorization: Bearer sk_live_xxx
 * @tierRequired power only - returns 403 for Free and Pro subscribers
 * @rateLimit 1 request per hour (export is expensive)
 *
 * Query Parameters:
 * - days: Lookback window in days (default: 30, max: 365)
 *
 * CSV columns: date, session_id, agent_type, model, input_tokens, output_tokens, cache_tokens, cost_usd
 *
 * @returns 200 text/csv with Content-Disposition: attachment; filename="styrby-costs-YYYY-MM-DD.csv"
 *
 * @error 400 { error: string } - Invalid query parameters
 * @error 401 { error: 'Unauthorized' } - Missing or invalid API key
 * @error 403 { error: string } - User is not on Power plan
 * @error 429 { error: 'RATE_LIMITED' } - Rate limit exceeded
 * @error 500 { error: string } - Server error
 */

import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { withApiAuth, addRateLimitHeaders, type ApiAuthContext } from '@/middleware/api-auth';
import { z } from 'zod';
import { rateLimit, RATE_LIMITS } from '@/lib/rateLimit';
import { normalizeEffectiveTier } from '@/lib/tier-enforcement';

// ---------------------------------------------------------------------------
// Query Schema
// ---------------------------------------------------------------------------

const QuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
});

// ---------------------------------------------------------------------------
// Supabase Admin Client
// ---------------------------------------------------------------------------

/**
 * Creates a Supabase client using the service role key for API v1 routes.
 *
 * WHY service role: API v1 routes authenticate via API key (not session cookies).
 * The service role bypasses RLS; we apply user_id filtering in every query.
 *
 * @returns Supabase admin client
 */
function createApiAdminClient() {
  return createServerClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      cookies: {
        getAll() {
          return [];
        },
        setAll() {},
      },
    }
  );
}

// ---------------------------------------------------------------------------
// CSV Helpers
// ---------------------------------------------------------------------------

/**
 * Serialises an array of row objects to a RFC 4180-compliant CSV string.
 *
 * WHY: Generate CSV server-side rather than streaming so we can set an
 * accurate Content-Length header. The per-row limit (50k) bounds memory
 * to a few MB on Vercel's serverless runtime.
 *
 * @param headers - Column header names in display order
 * @param rows - Row objects; values are accessed by header key
 * @returns Complete CSV string with CRLF line endings (RFC 4180)
 */
function toCsv(
  headers: string[],
  rows: Record<string, string | number | null | undefined>[]
): string {
  const headerLine = headers.join(',');

  const dataLines = rows.map((row) =>
    headers
      .map((h) => {
        const val = row[h];
        const str = val == null ? '' : String(val);
        // WHY: Quote fields that contain commas, double-quotes, or newlines to
        // avoid breaking parsers (e.g. Excel, Google Sheets).
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
          return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
      })
      .join(',')
  );

  // WHY CRLF: RFC 4180 specifies CRLF as the record terminator.
  return [headerLine, ...dataLines].join('\r\n');
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Core export handler - called after API key authentication.
 *
 * @param request - The incoming Next.js request
 * @param context - Authenticated API context containing userId and keyId
 * @returns CSV response with cost records, or error JSON
 */
async function handler(
  request: NextRequest,
  context: ApiAuthContext
): Promise<NextResponse> {
  const { userId, keyId } = context;

  // Apply strict rate limiting - 1 export per hour per IP.
  // WHY: A full 365-day export scans up to 50,000 rows. This is orders of
  // magnitude more expensive than summary queries. 1/hour balances usability
  // with compute cost protection.
  const { allowed, retryAfter } = await rateLimit(request, RATE_LIMITS.export, 'costs-export');
  if (!allowed) {
    return NextResponse.json(
      {
        error: 'RATE_LIMITED',
        message: 'Cost export is limited to once per hour.',
        retryAfter: retryAfter ?? 3600,
      },
      {
        status: 429,
        headers: { 'Retry-After': String(retryAfter ?? 3600) },
      }
    );
  }

  const supabase = createApiAdminClient();

  // Tier check - Power only.
  // WHY: Check the subscriptions table live rather than reading from the API key
  // record to catch downgrades that happened after the key was created.
  const { data: subscription } = await supabase
    .from('subscriptions')
    .select('tier')
    .eq('user_id', userId)
    .eq('status', 'active')
    .single();

  // WHY (Phase 5): legacy DB enum values alias to canonical tiers.
  const userTier = normalizeEffectiveTier((subscription?.tier as string) ?? 'free');

  if (userTier !== 'growth' && userTier !== 'pro') {
    return NextResponse.json(
      {
        error: 'Paid plan required',
        message: 'CSV cost export is available on the Pro and Growth plans. Upgrade at /pricing.',
        currentTier: userTier,
      },
      { status: 403 }
    );
  }

  // Parse query parameters
  const url = new URL(request.url);
  const rawQuery = {
    days: url.searchParams.get('days') ?? undefined,
  };

  const parseResult = QuerySchema.safeParse(rawQuery);
  if (!parseResult.success) {
    return NextResponse.json(
      { error: parseResult.error.errors.map((e) => e.message).join(', ') },
      { status: 400 }
    );
  }

  const { days } = parseResult.data;
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  // Fetch cost records ordered by date ascending (natural export order).
  // WHY .limit(50000): 50k rows × ~200 bytes ≈ 10 MB peak - within serverless
  // memory limits. Power users with very high volume can narrow the `days` param.
  const { data: costRecords, error: costError } = await supabase
    .from('cost_records')
    .select(
      'recorded_at, session_id, agent_type, model, input_tokens, output_tokens, cache_read_tokens, cost_usd'
    )
    .eq('user_id', userId)
    .gte('recorded_at', startDate.toISOString())
    .order('recorded_at', { ascending: true })
    .limit(50_000);

  if (costError) {
    console.error('Failed to fetch cost records for export:', costError.message);
    return NextResponse.json(
      { error: 'Failed to export cost data' },
      { status: 500 }
    );
  }

  // Build CSV rows - map database column names to export column names
  const CSV_HEADERS = [
    'date',
    'session_id',
    'agent_type',
    'model',
    'input_tokens',
    'output_tokens',
    'cache_tokens',
    'cost_usd',
  ];

  const rows = (costRecords ?? []).map((record) => ({
    date: record.recorded_at
      ? new Date(record.recorded_at as string).toISOString().split('T')[0]
      : '',
    session_id: (record.session_id as string | null) ?? '',
    agent_type: (record.agent_type as string) ?? '',
    model: (record.model as string) ?? '',
    input_tokens: Number(record.input_tokens) || 0,
    output_tokens: Number(record.output_tokens) || 0,
    cache_tokens: Number(record.cache_read_tokens) || 0,
    // WHY toFixed(8): Preserve sub-cent precision for cost aggregation accuracy.
    // Spreadsheet imports truncate floating-point numbers, so we serialize as
    // a fixed-precision string to prevent rounding loss.
    cost_usd: Number(record.cost_usd) != null
      ? Number(record.cost_usd).toFixed(8)
      : '0',
  }));

  const csvContent = toCsv(CSV_HEADERS, rows);

  // Build a date-stamped filename so the downloaded file is self-describing.
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const filename = `styrby-costs-${today}.csv`;

  const response = new NextResponse(csvContent, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      // WHY no-store: CSV contains private financial data and must never be
      // cached by a CDN, proxy, or browser shared cache.
      'Cache-Control': 'no-store',
    },
  });

  return addRateLimitHeaders(response, keyId);
}

export const GET = withApiAuth(handler);
