/**
 * GET /api/sessions/[id]/costs
 *
 * Returns per-message cost breakdown for a single session.
 * Used by the SessionCostDrillIn modal to show tool categories,
 * per-message costs, token breakdown (input/output/cache), and
 * estimated-vs-reported source comparison.
 *
 * @auth Required - Bearer token (Supabase Auth JWT). RLS enforces
 *       that the session belongs to the authenticated user.
 *
 * @param id - Session UUID from route params
 *
 * @returns 200 {
 *   sessionId: string,
 *   totalCostUsd: number,
 *   totalInputTokens: number,
 *   totalOutputTokens: number,
 *   totalCacheReadTokens: number,
 *   totalCacheWriteTokens: number,
 *   billingModel: BillingModel,
 *   sourceMix: { agentReported: number; styrbyEstimate: number },
 *   messages: Array<{
 *     id: string;
 *     recordedAt: string;
 *     costUsd: number;
 *     inputTokens: number;
 *     outputTokens: number;
 *     cacheReadTokens: number;
 *     cacheWriteTokens: number;
 *     model: string;
 *     agentType: string;
 *     billingModel: string;
 *     source: string;
 *     creditsConsumed: number | null;
 *     subscriptionFractionUsed: number | null;
 *   }>
 * }
 *
 * @error 400 { error: 'MISSING_SESSION_ID' }
 * @error 401 { error: 'UNAUTHORIZED' }
 * @error 403 { error: 'FORBIDDEN' } when session does not belong to user
 * @error 404 { error: 'SESSION_NOT_FOUND' }
 * @error 500 { error: 'INTERNAL_ERROR', message: string }
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

/**
 * Handles GET /api/sessions/[id]/costs
 *
 * @param _req - Incoming request (auth header handled by Supabase createClient)
 * @param context - Route context with params
 * @returns Session cost breakdown JSON
 */
export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { id: sessionId } = await context.params;

  if (!sessionId) {
    return NextResponse.json({ error: 'MISSING_SESSION_ID' }, { status: 400 });
  }

  const supabase = await createClient();

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }

  // Verify session ownership — RLS already enforces user_id = auth.uid() but
  // we check explicitly so we can return 404 vs 403 correctly.
  const { data: session, error: sessionError } = await supabase
    .from('sessions')
    .select('id, user_id, total_cost_usd')
    .eq('id', sessionId)
    .single();

  if (sessionError || !session) {
    return NextResponse.json({ error: 'SESSION_NOT_FOUND' }, { status: 404 });
  }

  if (session.user_id !== user.id) {
    return NextResponse.json({ error: 'FORBIDDEN' }, { status: 403 });
  }

  // Fetch all cost records for this session, ordered by recorded_at ascending.
  // WHY .limit(500): guards serverless memory for pathologically large sessions.
  // 500 messages * avg 200 bytes per row = 100 kB which is well within Lambda limits.
  const { data: records, error: recordsError } = await supabase
    .from('cost_records')
    .select(
      'id, recorded_at, cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, model, agent_type, billing_model, source, credits_consumed, subscription_fraction_used'
    )
    .eq('session_id', sessionId)
    .order('recorded_at', { ascending: true })
    .limit(500);

  if (recordsError) {
    return NextResponse.json(
      { error: 'INTERNAL_ERROR', message: recordsError.message },
      { status: 500 }
    );
  }

  const rows = records ?? [];

  // Aggregate totals from raw records for the response header.
  let totalCostUsd = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheWriteTokens = 0;
  let agentReportedCount = 0;
  let styrbyEstimateCount = 0;

  // Track which billing model is most common in the session.
  const billingModelCounts: Record<string, number> = {};

  for (const r of rows) {
    totalCostUsd += Number(r.cost_usd) || 0;
    totalInputTokens += Number(r.input_tokens) || 0;
    totalOutputTokens += Number(r.output_tokens) || 0;
    totalCacheReadTokens += Number(r.cache_read_tokens) || 0;
    totalCacheWriteTokens += Number(r.cache_write_tokens) || 0;

    if (r.source === 'agent-reported') agentReportedCount += 1;
    else styrbyEstimateCount += 1;

    const bm = r.billing_model ?? 'api-key';
    billingModelCounts[bm] = (billingModelCounts[bm] ?? 0) + 1;
  }

  // Dominant billing model = most frequent billing_model value in the session.
  const dominantBillingModel =
    Object.entries(billingModelCounts).sort(([, a], [, b]) => b - a)[0]?.[0] ?? 'api-key';

  return NextResponse.json({
    sessionId,
    totalCostUsd,
    totalInputTokens,
    totalOutputTokens,
    totalCacheReadTokens,
    totalCacheWriteTokens,
    billingModel: dominantBillingModel,
    sourceMix: {
      agentReported: agentReportedCount,
      styrbyEstimate: styrbyEstimateCount,
    },
    messages: rows.map((r) => ({
      id: r.id as string,
      recordedAt: r.recorded_at as string,
      costUsd: Number(r.cost_usd) || 0,
      inputTokens: Number(r.input_tokens) || 0,
      outputTokens: Number(r.output_tokens) || 0,
      cacheReadTokens: Number(r.cache_read_tokens) || 0,
      cacheWriteTokens: Number(r.cache_write_tokens) || 0,
      model: (r.model as string) ?? 'unknown',
      agentType: (r.agent_type as string) ?? 'unknown',
      billingModel: (r.billing_model as string) ?? 'api-key',
      source: (r.source as string) ?? 'styrby-estimate',
      creditsConsumed: r.credits_consumed != null ? Number(r.credits_consumed) : null,
      subscriptionFractionUsed:
        r.subscription_fraction_used != null ? Number(r.subscription_fraction_used) : null,
    })),
  });
}
