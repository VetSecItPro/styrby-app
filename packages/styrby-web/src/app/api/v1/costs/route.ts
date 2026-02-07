/**
 * GET /api/v1/costs
 *
 * Returns cost summary for the authenticated user.
 * Supports daily, weekly, and monthly aggregation periods.
 *
 * @auth Required - API key via Authorization: Bearer sk_live_xxx
 * @rateLimit 100 requests per minute per key
 *
 * Query Parameters:
 * - period: Aggregation period (default: 'monthly')
 *   - 'daily': Last 30 days by day
 *   - 'weekly': Last 12 weeks by week
 *   - 'monthly': Last 12 months by month
 *
 * @returns 200 {
 *   summary: {
 *     period: string,
 *     totalCostUsd: number,
 *     totalInputTokens: number,
 *     totalOutputTokens: number,
 *     totalCacheTokens: number,
 *     sessionCount: number
 *   },
 *   breakdown: Array<{
 *     date: string,
 *     costUsd: number,
 *     inputTokens: number,
 *     outputTokens: number,
 *     cacheTokens: number
 *   }>
 * }
 */

import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { withApiAuth, addRateLimitHeaders, type ApiAuthContext } from '@/middleware/api-auth';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Query Schema
// ---------------------------------------------------------------------------

const QuerySchema = z.object({
  period: z.enum(['daily', 'weekly', 'monthly']).default('monthly'),
});

// ---------------------------------------------------------------------------
// Supabase Admin Client
// ---------------------------------------------------------------------------

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
// Date Helpers
// ---------------------------------------------------------------------------

function getDateRange(period: 'daily' | 'weekly' | 'monthly'): { startDate: Date; endDate: Date } {
  const endDate = new Date();
  const startDate = new Date();

  switch (period) {
    case 'daily':
      startDate.setDate(startDate.getDate() - 30);
      break;
    case 'weekly':
      startDate.setDate(startDate.getDate() - 84); // 12 weeks
      break;
    case 'monthly':
      startDate.setMonth(startDate.getMonth() - 12);
      break;
  }

  return { startDate, endDate };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function handler(
  request: NextRequest,
  context: ApiAuthContext
): Promise<NextResponse> {
  const { userId, keyId } = context;

  // Parse query parameters
  const url = new URL(request.url);
  const rawQuery = {
    period: url.searchParams.get('period') ?? undefined,
  };

  const parseResult = QuerySchema.safeParse(rawQuery);
  if (!parseResult.success) {
    return NextResponse.json(
      { error: parseResult.error.errors.map((e) => e.message).join(', ') },
      { status: 400 }
    );
  }

  const { period } = parseResult.data;
  const { startDate, endDate } = getDateRange(period);

  const supabase = createApiAdminClient();

  // Get cost records for the period
  // WHY: .limit(10000) prevents unbounded memory on serverless functions.
  // 12-month 'monthly' period could return tens of thousands of rows.
  const { data: costRecords, error: costError } = await supabase
    .from('cost_records')
    .select('record_date, cost_usd, input_tokens, output_tokens, cache_read_tokens')
    .eq('user_id', userId)
    .gte('record_date', startDate.toISOString().split('T')[0])
    .lte('record_date', endDate.toISOString().split('T')[0])
    .order('record_date', { ascending: true })
    .limit(10000);

  if (costError) {
    console.error('Failed to fetch cost records:', costError.message);
    return NextResponse.json(
      { error: 'Failed to fetch cost data' },
      { status: 500 }
    );
  }

  // Get session count for the period
  const { count: sessionCount } = await supabase
    .from('sessions')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('created_at', startDate.toISOString())
    .lte('created_at', endDate.toISOString())
    .is('deleted_at', null);

  // Aggregate by period
  const aggregatedData: Record<
    string,
    {
      costUsd: number;
      inputTokens: number;
      outputTokens: number;
      cacheTokens: number;
    }
  > = {};

  let totalCostUsd = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheTokens = 0;

  for (const record of costRecords || []) {
    let dateKey: string;
    const recordDate = new Date(record.record_date);

    switch (period) {
      case 'daily':
        dateKey = record.record_date;
        break;
      case 'weekly': {
        // Get the Monday of the week
        const day = recordDate.getDay();
        const diff = day === 0 ? 6 : day - 1;
        const monday = new Date(recordDate);
        monday.setDate(recordDate.getDate() - diff);
        dateKey = monday.toISOString().split('T')[0];
        break;
      }
      case 'monthly':
        dateKey = `${recordDate.getFullYear()}-${String(recordDate.getMonth() + 1).padStart(2, '0')}`;
        break;
    }

    if (!aggregatedData[dateKey]) {
      aggregatedData[dateKey] = {
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheTokens: 0,
      };
    }

    const costUsd = Number(record.cost_usd) || 0;
    const inputTokens = Number(record.input_tokens) || 0;
    const outputTokens = Number(record.output_tokens) || 0;
    const cacheTokens = Number(record.cache_read_tokens) || 0;

    aggregatedData[dateKey].costUsd += costUsd;
    aggregatedData[dateKey].inputTokens += inputTokens;
    aggregatedData[dateKey].outputTokens += outputTokens;
    aggregatedData[dateKey].cacheTokens += cacheTokens;

    totalCostUsd += costUsd;
    totalInputTokens += inputTokens;
    totalOutputTokens += outputTokens;
    totalCacheTokens += cacheTokens;
  }

  // Convert to array and sort
  const breakdown = Object.entries(aggregatedData)
    .map(([date, data]) => ({
      date,
      costUsd: Math.round(data.costUsd * 1000000) / 1000000,
      inputTokens: data.inputTokens,
      outputTokens: data.outputTokens,
      cacheTokens: data.cacheTokens,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const response = NextResponse.json({
    summary: {
      period,
      totalCostUsd: Math.round(totalCostUsd * 1000000) / 1000000,
      totalInputTokens,
      totalOutputTokens,
      totalCacheTokens,
      sessionCount: sessionCount ?? 0,
    },
    breakdown,
  });

  return addRateLimitHeaders(response, keyId);
}

export const GET = withApiAuth(handler);
