/**
 * send-monthly-statement — Supabase Edge Function
 *
 * Sends a personalized monthly cost summary email to every user who had
 * at least one session in the prior calendar month.
 *
 * Triggered by pg_cron on the 1st of each month (see migration 025).
 * Can also be called manually by admins via POST for a specific month.
 *
 * Flow:
 *   1. Compute prior month boundaries (first day → last day).
 *   2. Query all users with sessions in that period.
 *   3. For each user, aggregate: total_cost_usd, session_count, top_agent,
 *      input_tokens, output_tokens, billing_model breakdown.
 *   4. Build the email payload via buildEmailPayload (in helpers.ts).
 *   5. Deliver via Resend API.
 *
 * @auth Internal only — called by pg_cron via service role key.
 *       Manual POST requires Authorization: Bearer <service_role_key>.
 *
 * @env SUPABASE_URL               - Supabase project URL
 * @env SUPABASE_SERVICE_ROLE_KEY  - Service role key for bypassing RLS
 * @env RESEND_API_KEY             - Resend API key for email delivery
 * @env APP_URL                    - Base URL for dashboard links (default: https://app.styrbyapp.com)
 *
 * @returns 200 { sent: number, skipped: number, month: string }
 * @returns 400 { error: 'INVALID_MONTH', message: string }
 * @returns 500 { error: 'INTERNAL_ERROR', message: string }
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.47.10';
import {
  getPriorMonthBounds,
  parseMonthOverride,
  aggregateUserStats,
  buildEmailPayload,
  type UserMonthlyStats,
  type CostAggRow,
} from './helpers.ts';

// Re-export pure helpers so the test suite can import from this module
// OR from helpers.ts directly without behavioural difference.
export { getPriorMonthBounds, parseMonthOverride, aggregateUserStats, buildEmailPayload };
export type { UserMonthlyStats, CostAggRow };

// ============================================================================
// Types — handler-only
// ============================================================================

/**
 * Optional request body — allows overriding the target month for manual runs.
 */
interface StatementRequest {
  /**
   * Override month in YYYY-MM format (e.g. "2026-03").
   * Defaults to prior calendar month when omitted.
   */
  month?: string;
}

// ============================================================================
// Handler
// ============================================================================

Deno.serve(async (req: Request) => {
  // CORS pre-flight
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'authorization, content-type',
      },
    });
  }

  // Only POST allowed
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'METHOD_NOT_ALLOWED' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Environment variable validation
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const resendApiKey = Deno.env.get('RESEND_API_KEY');
  const appUrl = Deno.env.get('APP_URL') ?? 'https://app.styrbyapp.com';

  if (!supabaseUrl || !serviceRoleKey) {
    return new Response(
      JSON.stringify({ error: 'INTERNAL_ERROR', message: 'Supabase credentials not configured' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (!resendApiKey) {
    return new Response(
      JSON.stringify({ error: 'INTERNAL_ERROR', message: 'RESEND_API_KEY not configured' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Parse optional body
  let body: StatementRequest = {};
  try {
    const text = await req.text();
    if (text) body = JSON.parse(text) as StatementRequest;
  } catch {
    // Empty body is OK
  }

  // Determine month bounds
  let bounds: { start: string; end: string; label: string };
  try {
    bounds = body.month
      ? parseMonthOverride(body.month)
      : getPriorMonthBounds();
  } catch (err) {
    return new Response(
      JSON.stringify({ error: 'INVALID_MONTH', message: (err as Error).message }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Build Supabase client with service role (bypasses RLS for cross-user queries)
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  // WHY: We query cost_records directly (not v_my_daily_costs) because we need
  // all users, not just the authenticated user. Service role bypasses RLS.
  // We aggregate client-side because Supabase JS does not support GROUP BY.
  const { data: aggRows, error: aggError } = await supabase
    .from('cost_records')
    .select('user_id, agent_type, billing_model, cost_usd, input_tokens, output_tokens, id')
    .gte('record_date', bounds.start)
    .lte('record_date', bounds.end)
    .limit(100_000); // Guard against unbounded scans

  if (aggError) {
    return new Response(
      JSON.stringify({ error: 'INTERNAL_ERROR', message: aggError.message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Aggregate client-side into CostAggRow shape expected by aggregateUserStats
  const rawAgg = new Map<string, CostAggRow>();
  for (const row of aggRows ?? []) {
    const key = `${row.user_id}:${row.agent_type}:${row.billing_model}`;
    const existing = rawAgg.get(key);
    if (existing) {
      existing.total_cost_usd += Number(row.cost_usd) || 0;
      existing.total_input_tokens += Number(row.input_tokens) || 0;
      existing.total_output_tokens += Number(row.output_tokens) || 0;
      existing.record_count += 1;
    } else {
      rawAgg.set(key, {
        user_id: row.user_id as string,
        agent_type: row.agent_type as string,
        billing_model: row.billing_model as string,
        total_cost_usd: Number(row.cost_usd) || 0,
        total_input_tokens: Number(row.input_tokens) || 0,
        total_output_tokens: Number(row.output_tokens) || 0,
        record_count: 1,
      });
    }
  }

  const costRows = [...rawAgg.values()];
  const userIds = [...new Set(costRows.map((r) => r.user_id))];

  if (userIds.length === 0) {
    return new Response(
      JSON.stringify({ sent: 0, skipped: 0, month: bounds.label }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Fetch user emails and display names via auth admin API.
  // WHY batched: avoids URL-length issues; listUsers paginates internally.
  const userMap = new Map<string, { email: string; displayName?: string }>();
  for (let i = 0; i < userIds.length; i += 50) {
    const batch = userIds.slice(i, i + 50);
    const { data: usersData } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
    for (const u of usersData?.users ?? []) {
      if (batch.includes(u.id) && u.email) {
        userMap.set(u.id, {
          email: u.email,
          displayName: (u.user_metadata?.display_name as string | undefined) ??
                       (u.user_metadata?.full_name as string | undefined),
        });
      }
    }
  }

  // Fetch session counts per user for the period
  const { data: sessionRows } = await supabase
    .from('sessions')
    .select('user_id')
    .gte('started_at', `${bounds.start}T00:00:00.000Z`)
    .lte('started_at', `${bounds.end}T23:59:59.999Z`)
    .in('user_id', userIds);

  const sessionCountByUser: Record<string, number> = {};
  for (const s of sessionRows ?? []) {
    const uid = s.user_id as string;
    sessionCountByUser[uid] = (sessionCountByUser[uid] ?? 0) + 1;
  }

  // Build per-user stats and patch session counts
  const allStats = aggregateUserStats(costRows, userMap);
  for (const stat of allStats) {
    stat.sessionCount = sessionCountByUser[stat.userId] ?? 0;
  }

  // Send emails via Resend
  let sent = 0;
  let skipped = 0;

  for (const stat of allStats) {
    if (!stat.email) { skipped++; continue; }
    if (stat.sessionCount === 0 && stat.totalCostUsd === 0) { skipped++; continue; }

    const payload = buildEmailPayload(stat, bounds.label, appUrl);

    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${resendApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: 'Styrby <noreply@styrbyapp.com>',
          to: stat.email,
          subject: payload.subject,
          html: payload.html,
          text: payload.text,
        }),
      });

      if (res.ok) {
        sent++;
      } else {
        // Log but continue — don't fail the entire batch for one bad address
        console.error(`[send-monthly-statement] Failed to send to ${stat.userId}: HTTP ${res.status}`);
        skipped++;
      }
    } catch (err) {
      console.error(`[send-monthly-statement] Network error for ${stat.userId}:`, err);
      skipped++;
    }
  }

  return new Response(
    JSON.stringify({ sent, skipped, month: bounds.label }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
});
