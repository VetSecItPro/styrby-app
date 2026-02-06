/**
 * GET /api/v1/costs/breakdown
 *
 * Returns cost breakdown by agent type for the authenticated user.
 *
 * @auth Required - API key via Authorization: Bearer sk_live_xxx
 * @rateLimit 100 requests per minute per key
 *
 * Query Parameters:
 * - days: Number of days to look back (default: 30, max: 365)
 *
 * @returns 200 {
 *   breakdown: Array<{
 *     agentType: string,
 *     costUsd: number,
 *     inputTokens: number,
 *     outputTokens: number,
 *     cacheTokens: number,
 *     sessionCount: number,
 *     percentage: number
 *   }>,
 *   total: {
 *     costUsd: number,
 *     inputTokens: number,
 *     outputTokens: number,
 *     cacheTokens: number,
 *     sessionCount: number
 *   }
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
  days: z.coerce.number().int().min(1).max(365).default(30),
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

  const supabase = createApiAdminClient();

  // Get cost records grouped by agent type
  const { data: costRecords, error: costError } = await supabase
    .from('cost_records')
    .select('agent_type, cost_usd, input_tokens, output_tokens, cache_read_tokens, session_id')
    .eq('user_id', userId)
    .gte('record_date', startDate.toISOString().split('T')[0]);

  if (costError) {
    console.error('Failed to fetch cost records:', costError.message);
    return NextResponse.json(
      { error: 'Failed to fetch cost data' },
      { status: 500 }
    );
  }

  // Aggregate by agent type
  const agentData: Record<
    string,
    {
      costUsd: number;
      inputTokens: number;
      outputTokens: number;
      cacheTokens: number;
      sessionIds: Set<string>;
    }
  > = {};

  let totalCostUsd = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheTokens = 0;
  const allSessionIds = new Set<string>();

  for (const record of costRecords || []) {
    const agentType = record.agent_type || 'unknown';

    if (!agentData[agentType]) {
      agentData[agentType] = {
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheTokens: 0,
        sessionIds: new Set(),
      };
    }

    const costUsd = Number(record.cost_usd) || 0;
    const inputTokens = Number(record.input_tokens) || 0;
    const outputTokens = Number(record.output_tokens) || 0;
    const cacheTokens = Number(record.cache_read_tokens) || 0;

    agentData[agentType].costUsd += costUsd;
    agentData[agentType].inputTokens += inputTokens;
    agentData[agentType].outputTokens += outputTokens;
    agentData[agentType].cacheTokens += cacheTokens;

    if (record.session_id) {
      agentData[agentType].sessionIds.add(record.session_id);
      allSessionIds.add(record.session_id);
    }

    totalCostUsd += costUsd;
    totalInputTokens += inputTokens;
    totalOutputTokens += outputTokens;
    totalCacheTokens += cacheTokens;
  }

  // Convert to array with percentages
  const breakdown = Object.entries(agentData)
    .map(([agentType, data]) => ({
      agentType,
      costUsd: Math.round(data.costUsd * 1000000) / 1000000,
      inputTokens: data.inputTokens,
      outputTokens: data.outputTokens,
      cacheTokens: data.cacheTokens,
      sessionCount: data.sessionIds.size,
      percentage: totalCostUsd > 0 ? Math.round((data.costUsd / totalCostUsd) * 10000) / 100 : 0,
    }))
    .sort((a, b) => b.costUsd - a.costUsd);

  const response = NextResponse.json({
    breakdown,
    total: {
      costUsd: Math.round(totalCostUsd * 1000000) / 1000000,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      cacheTokens: totalCacheTokens,
      sessionCount: allSessionIds.size,
    },
    period: {
      days,
      startDate: startDate.toISOString().split('T')[0],
      endDate: new Date().toISOString().split('T')[0],
    },
  });

  return addRateLimitHeaders(response, keyId);
}

export const GET = withApiAuth(handler);
