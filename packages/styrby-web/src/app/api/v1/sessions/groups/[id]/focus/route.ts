/**
 * POST /api/v1/sessions/groups/[id]/focus
 *
 * Sets `active_agent_session_id` on an agent_session_group, directing the
 * mobile UI to focus on a specific member session. The CLI orchestrator
 * (multiAgentOrchestrator.ts) calls this when the focused session ends and
 * focus needs to transition to another running session.
 *
 * Mirrors the legacy `/api/sessions/groups/[groupId]/focus` endpoint but
 * authenticates via per-user `styrby_*` API key (Strategy C / H41) rather
 * than the Supabase Auth cookie. The legacy endpoint additionally builds a
 * Phase 3.5 ContextInjectionPayload for mobile clients; this v1 mirror
 * deliberately omits that payload because the CLI doesn't need it (the CLI
 * simply commits the focus transition; mobile drives the injection flow via
 * the legacy endpoint's response).
 *
 * @auth Required - Bearer `styrby_*` API key via withApiAuthAndRateLimit
 * @rateLimit 100 requests per minute per key (default — focus transitions
 *   fire on session-end events, not per-user-action)
 *
 * @body {
 *   session_id: string  // UUID of the member session to focus
 * }
 *
 * @returns 200 { group_id, active_agent_session_id }
 *
 * @error 400 { error }  - Zod validation failure
 * @error 401 { error }  - Missing or invalid API key
 * @error 404 { error }  - Group not found OR belongs to another user OR
 *                        session_id doesn't belong to this group (consistent
 *                        404 for IDOR defense)
 * @error 429 { error }  - Rate limit exceeded
 * @error 500 { error }  - Unexpected database error (sanitized)
 *
 * @security OWASP A01:2021 - explicit (group.user_id == auth.userId) check;
 *   404 on cross-user lookups (no existence leak).
 * @security OWASP A03:2021 - Zod .strict() on body (mass-assignment guard).
 * @security OWASP A07:2021 - auth via withApiAuthAndRateLimit.
 * @security SOC 2 CC6.1 - 'write' scope required.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import * as Sentry from '@sentry/nextjs';

import {
  withApiAuthAndRateLimit,
  type ApiAuthContext,
} from '@/middleware/api-auth';
import { createAdminClient } from '@/lib/supabase/server';

const ROUTE_ID = '/api/v1/sessions/groups/[id]/focus';

const FocusBodySchema = z
  .object({
    session_id: z.string().uuid('session_id must be a valid UUID'),
  })
  .strict();

type FocusBody = z.infer<typeof FocusBodySchema>;

/**
 * Extract `id` (group UUID) from the URL pathname.
 *
 * WHY manual extraction: withApiAuthAndRateLimit doesn't pass route params
 * through. Same pattern as templates/[id]/route.ts and contexts/[group_id]/route.ts.
 */
function extractGroupId(request: NextRequest): { ok: true; id: string } | { ok: false; error: string } {
  // Path: /api/v1/sessions/groups/[id]/focus  →  segments end in [..., 'sessions', 'groups', id, 'focus']
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  // The id is the second-to-last segment (the last is 'focus').
  const id = segments[segments.length - 2];
  if (!id) return { ok: false, error: 'Missing group id' };
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(id)) return { ok: false, error: 'Invalid group id format' };
  return { ok: true, id };
}

async function handlePost(request: NextRequest, authContext: ApiAuthContext): Promise<NextResponse> {
  const { userId } = authContext;

  const idResult = extractGroupId(request);
  if (!idResult.ok) return NextResponse.json({ error: idResult.error }, { status: 400 });
  const groupId = idResult.id;

  let parsed: FocusBody;
  try {
    const raw = await request.json();
    const result = FocusBodySchema.safeParse(raw);
    if (!result.success) {
      const msg = result.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ');
      return NextResponse.json({ error: msg }, { status: 400 });
    }
    parsed = result.data;
  } catch {
    return NextResponse.json({ error: 'Request body must be valid JSON' }, { status: 400 });
  }

  const supabase = createAdminClient();

  // ── 1. Ownership check on the group (IDOR defense) ────────────────────────
  // WHY explicit: API-key auth has no auth.uid() context, so RLS cannot enforce.
  // Same pattern as POST /api/v1/contexts (route.ts) and the templates/[id] handlers.
  const { data: groupRow, error: groupErr } = await supabase
    .from('agent_session_groups')
    .select('user_id')
    .eq('id', groupId)
    .maybeSingle<{ user_id: string }>();

  if (groupErr) {
    Sentry.captureException(new Error(`agent_session_groups fetch error: ${groupErr.message}`), {
      extra: { route: ROUTE_ID },
    });
    return NextResponse.json({ error: 'Failed to update focus' }, { status: 500 });
  }
  if (!groupRow || groupRow.user_id !== userId) {
    // 404 on missing AND on cross-user — consistent IDOR-defense response.
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // ── 2. Membership check: session_id must belong to this group ─────────────
  // WHY: prevents an authenticated user from focusing a session that's NOT
  // a member of the group. Without this check, a malicious caller could pass
  // their OWN session's id as session_id with a different user's group_id —
  // the ownership check above blocks that path, but membership is still a
  // defensive belt-and-suspenders guard for the single-user case where they
  // mix up sessions across their own groups.
  const { data: sessionRow, error: sessionErr } = await supabase
    .from('sessions')
    .select('session_group_id')
    .eq('id', parsed.session_id)
    .eq('user_id', userId)
    .maybeSingle<{ session_group_id: string | null }>();

  if (sessionErr) {
    Sentry.captureException(new Error(`sessions fetch error: ${sessionErr.message}`), {
      extra: { route: ROUTE_ID },
    });
    return NextResponse.json({ error: 'Failed to update focus' }, { status: 500 });
  }
  if (!sessionRow || sessionRow.session_group_id !== groupId) {
    // 404 keeps the IDOR-defense story consistent: don't leak whether the
    // session exists vs whether it's in the wrong group.
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // ── 3. Update the focus pointer ───────────────────────────────────────────
  const { error: updateErr } = await supabase
    .from('agent_session_groups')
    .update({
      active_agent_session_id: parsed.session_id,
      updated_at: new Date().toISOString(),
    })
    .eq('id', groupId)
    .eq('user_id', userId);

  if (updateErr) {
    Sentry.captureException(new Error(`agent_session_groups update error: ${updateErr.message}`), {
      extra: { route: ROUTE_ID },
    });
    return NextResponse.json({ error: 'Failed to update focus' }, { status: 500 });
  }

  return NextResponse.json(
    { group_id: groupId, active_agent_session_id: parsed.session_id },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

export const POST = withApiAuthAndRateLimit(handlePost, ['write']);
