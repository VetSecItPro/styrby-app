/**
 * Founder Feedback Dashboard API
 *
 * GET /api/admin/founder-feedback
 *
 * Returns aggregated and raw feedback data for the founder feedback tab:
 *
 *   - NPS: weekly trend, promoter/passive/detractor breakdown, latest comments
 *   - General: latest 50 general feedback submissions (filterable by kind)
 *   - Session post-mortems: latest 50 with rating + agent filter
 *
 * WHY service-role: Feedback data spans all users. RLS is user-scoped
 * (each user can only read their own feedback). The service role bypasses
 * RLS for cross-user aggregation. The admin gate (is_admin check) enforces
 * access control at the API layer.
 *
 * WHY one endpoint for all tabs: The tabs share the same auth check and admin
 * gate. A single endpoint with query params reduces the auth surface area
 * and keeps the founder page's data fetching logic in one place.
 *
 * @auth Required - Supabase Auth JWT (cookie), must be in site_admins table (verified via is_site_admin() RPC; migration 042 T3.5 cutover)
 * @rateLimit 10 requests per minute
 *
 * @query tab - 'nps' | 'general' | 'postmortems' (default: 'nps')
 * @query nps_window - '7d' | '30d' | 'all' for NPS filtering (default: 'all')
 * @query agent - agent_type filter for postmortems (optional)
 * @query rating - 'useful' | 'not_useful' filter for postmortems (optional)
 * @query weeks - number of weeks for NPS trend (default: 12)
 *
 * @returns 200 { tab, data: FounderFeedbackData }
 *
 * @error 401 { error: 'Unauthorized' }
 * @error 403 { error: 'Forbidden' }
 * @error 429 { error: 'RATE_LIMITED', retryAfter: number }
 * @error 500 { error: 'INTERNAL_ERROR' }
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient, createAdminClient } from '@/lib/supabase/server';
import { isAdmin } from '@/lib/admin';
import { rateLimit, RATE_LIMITS, rateLimitResponse } from '@/lib/rateLimit';
import { calcNPS, groupNpsByWeek } from '@styrby/shared';

// ============================================================================
// Types
// ============================================================================

interface NpsTabData {
  /** Current NPS across all time or selected nps_window */
  currentNps: {
    score: number;
    promoters: number;
    passives: number;
    detractors: number;
    total: number;
    promoterPct: number;
    passivePct: number;
    detractorPct: number;
  };
  /** Weekly trend (last N weeks) */
  trend: Array<{
    week: string;
    score: number;
    responseCount: number;
    promoters: number;
    passives: number;
    detractors: number;
  }>;
  /** Latest 10 follow-up comments (non-null followup text) */
  latestComments: Array<{
    id: string;
    score: number;
    followup: string;
    nps_window: string | null;
    created_at: string;
  }>;
}

interface GeneralTabData {
  items: Array<{
    id: string;
    user_id: string | null;
    message: string | null;
    platform: string | null;
    context_json: Record<string, unknown> | null;
    created_at: string;
  }>;
  total: number;
}

interface PostmortmTabData {
  items: Array<{
    id: string;
    session_id: string | null;
    rating: string | null;
    reason: string | null;
    context_json: Record<string, unknown> | null;
    created_at: string;
    session?: {
      agent_type: string | null;
      started_at: string | null;
      ended_at: string | null;
    } | null;
  }>;
  total: number;
}

// ============================================================================
// GET handler
// ============================================================================

export async function GET(request: NextRequest) {
  // ── Auth ──────────────────────────────────────────────────────────────────
  const supabase = await createClient();
  const { data: { user }, error: authErr } = await supabase.auth.getUser();

  if (authErr || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // ── Admin gate ────────────────────────────────────────────────────────────
  const adminOk = await isAdmin(user.id);
  if (!adminOk) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // ── Rate limit ────────────────────────────────────────────────────────────
  const { allowed, retryAfter } = await rateLimit(request, RATE_LIMITS.sensitive, 'founder-feedback');
  if (!allowed) {
    return rateLimitResponse(retryAfter!);
  }

  // ── Query params ──────────────────────────────────────────────────────────
  const { searchParams } = new URL(request.url);
  const tab = (searchParams.get('tab') ?? 'nps') as 'nps' | 'general' | 'postmortems';
  const nps_window = (searchParams.get('nps_window') ?? 'all') as '7d' | '30d' | 'all';
  const agentFilter = searchParams.get('agent');
  const ratingFilter = searchParams.get('rating') as 'useful' | 'not_useful' | null;
  const weeksBack = Math.min(52, parseInt(searchParams.get('weeks') ?? '12', 10));

  const adminSupabase = createAdminClient();

  try {
    if (tab === 'nps') {
      const data = await fetchNpsData(adminSupabase, nps_window, weeksBack);
      return NextResponse.json({ tab, data });
    }

    if (tab === 'general') {
      const data = await fetchGeneralData(adminSupabase);
      return NextResponse.json({ tab, data });
    }

    // postmortems
    const data = await fetchPostmortemData(adminSupabase, agentFilter, ratingFilter);
    return NextResponse.json({ tab, data });
  } catch (err) {
    console.error('[founder-feedback] error:', err);
    return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
  }
}

// ============================================================================
// Data fetchers
// ============================================================================

/**
 * Fetch NPS tab data: current score, weekly trend, latest comments.
 *
 * @param supabase - Admin client
 * @param nps_window - Filter to specific NPS nps_window ('7d', '30d', or 'all')
 * @param weeksBack - Number of weeks of trend data to include
 */
async function fetchNpsData(
  supabase: ReturnType<typeof createAdminClient>,
  nps_window: '7d' | '30d' | 'all',
  weeksBack: number
): Promise<NpsTabData> {
  // WHY: Fetch all NPS rows in the trend period to compute both the overall
  // score and the weekly breakdown from the same data set. One DB round-trip.
  const since = new Date();
  since.setDate(since.getDate() - weeksBack * 7);

  let query = supabase
    .from('user_feedback')
    .select('id, score, followup, nps_window, created_at')
    .eq('kind', 'nps')
    .not('score', 'is', null)
    .gte('created_at', since.toISOString())
    .order('created_at', { ascending: false })
    .limit(5000); // Safety cap

  if (nps_window !== 'all') {
    query = query.eq('nps_window', nps_window);
  }

  const { data: rows, error } = await query;

  if (error) {
    throw new Error(`NPS fetch failed: ${error.message}`);
  }

  const scores = (rows ?? []).map((r) => r.score as number | null);
  const currentNps = calcNPS(scores);

  const trend = groupNpsByWeek(
    (rows ?? []).map((r) => ({
      score: r.score as number,
      created_at: r.created_at as string,
    }))
  );

  const latestComments = (rows ?? [])
    .filter((r) => r.followup && (r.followup as string).trim().length > 0)
    .slice(0, 10)
    .map((r) => ({
      id: r.id as string,
      score: r.score as number,
      followup: r.followup as string,
      nps_window: r.nps_window as string | null,
      created_at: r.created_at as string,
    }));

  return { currentNps, trend, latestComments };
}

/**
 * Fetch general feedback tab data: latest 50 submissions.
 *
 * @param supabase - Admin client
 */
async function fetchGeneralData(
  supabase: ReturnType<typeof createAdminClient>
): Promise<GeneralTabData> {
  const { data: rows, error, count } = await supabase
    .from('user_feedback')
    .select('id, user_id, message, platform, context_json, created_at', { count: 'exact' })
    .eq('kind', 'general')
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) {
    throw new Error(`General feedback fetch failed: ${error.message}`);
  }

  return {
    items: rows ?? [],
    total: count ?? 0,
  };
}

/**
 * Fetch post-mortem tab data: latest 50 with optional agent and rating filters.
 *
 * Joins to sessions to include agent_type and duration.
 *
 * @param supabase - Admin client
 * @param agentFilter - Optional agent_type filter
 * @param ratingFilter - Optional rating filter ('useful' | 'not_useful')
 */
async function fetchPostmortemData(
  supabase: ReturnType<typeof createAdminClient>,
  agentFilter: string | null,
  ratingFilter: 'useful' | 'not_useful' | null
): Promise<PostmortmTabData> {
  // WHY join sessions: The post-mortem needs agent + duration for the
  // founder to understand the context of negative feedback. A single
  // joined query is more efficient than N+1 fetches.
  let query = supabase
    .from('user_feedback')
    .select(
      `id, session_id, rating, reason, context_json, created_at,
       session:sessions!user_feedback_session_id_fkey(agent_type, started_at, ended_at)`,
      { count: 'exact' }
    )
    .eq('kind', 'session_postmortem')
    .order('created_at', { ascending: false })
    .limit(50);

  if (ratingFilter) {
    query = query.eq('rating', ratingFilter);
  }

  const { data: rows, error, count } = await query;

  if (error) {
    throw new Error(`Postmortem fetch failed: ${error.message}`);
  }

  // Apply client-side agent filter if provided (session join makes SQL filter complex)
  const filtered = agentFilter
    ? (rows ?? []).filter(
        (r) =>
          r.session &&
          !Array.isArray(r.session) &&
          (r.session as { agent_type: string | null }).agent_type === agentFilter
      )
    : (rows ?? []);

  return {
    items: filtered as unknown as PostmortmTabData['items'],
    total: count ?? 0,
  };
}
