/**
 * GET /api/v1/contexts/[group_id]
 *
 * Fetches the current `agent_context_memory` row for a session group. Used
 * by the CLI's `styrby context show` flow + the optimistic-locking pre-check
 * inside `commands/context.ts` (which currently selects directly from
 * Supabase; Phase 4 swaps it to this endpoint).
 *
 * @auth Required - Bearer `styrby_*` API key via withApiAuthAndRateLimit
 * @rateLimit 100 requests per minute per key (default)
 *
 * @returns 200 { context: ContextRow }  - row exists for this group + user
 * @returns 404 { error: 'Not found' }    - no row OR group belongs to another user
 *
 * @error 401 { error }  - Missing or invalid API key
 * @error 429 { error }  - Rate limit exceeded
 * @error 500 { error }  - Unexpected database error (sanitized)
 *
 * @security OWASP A01:2021 - ownership enforced via JOIN through
 *   agent_session_groups; consistent 404 on cross-user / missing.
 * @security OWASP A07:2021 - auth enforced by withApiAuthAndRateLimit.
 * @security SOC 2 CC6.1 - 'read' scope required.
 */

import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';

import {
  withApiAuthAndRateLimit,
  type ApiAuthContext,
} from '@/middleware/api-auth';
import { createAdminClient } from '@/lib/supabase/server';

const ROUTE_ID = '/api/v1/contexts/[group_id]';

interface ContextRow {
  id: string;
  session_group_id: string;
  summary_markdown: string;
  file_refs: unknown;
  recent_messages: unknown;
  token_budget: number;
  version: number;
  created_at: string;
  updated_at: string;
}

/**
 * Extract `group_id` from URL pathname. See templates/[id]/route.ts for the
 * rationale on manual parsing + UUID validation.
 */
function extractGroupId(request: NextRequest): { ok: true; id: string } | { ok: false; error: string } {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  const id = segments[segments.length - 1];
  if (!id) return { ok: false, error: 'Missing group id' };
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(id)) return { ok: false, error: 'Invalid group id format' };
  return { ok: true, id };
}

async function handleGet(request: NextRequest, authContext: ApiAuthContext): Promise<NextResponse> {
  const { userId } = authContext;
  const idResult = extractGroupId(request);
  if (!idResult.ok) return NextResponse.json({ error: idResult.error }, { status: 400 });

  const supabase = createAdminClient();

  // -- Step 1: ownership check on agent_session_groups -----------------------
  // WHY this check (not RLS): auth.uid() is null for API-key-authenticated
  // requests. Service role client bypasses RLS — we must enforce ownership
  // explicitly. Same pattern as POST /api/v1/contexts (route.ts).
  const { data: groupRow, error: groupErr } = await supabase
    .from('agent_session_groups')
    .select('user_id')
    .eq('id', idResult.id)
    .maybeSingle<{ user_id: string }>();

  if (groupErr) {
    Sentry.captureException(new Error(`agent_session_groups fetch error: ${groupErr.message}`), {
      extra: { route: ROUTE_ID },
    });
    return NextResponse.json({ error: 'Failed to fetch context' }, { status: 500 });
  }
  if (!groupRow || groupRow.user_id !== userId) {
    // 404 on both "no group" and "wrong owner" (IDOR defense, OWASP A01:2021).
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // -- Step 2: fetch the context row -----------------------------------------
  // WHY separate query (not a join): the schema has agent_context_memory with
  // a UNIQUE constraint on session_group_id, so 0 or 1 row guaranteed. The
  // separate fetch is simpler than a left-join + null-handling, and the perf
  // cost is negligible (one extra round-trip on a UUID-keyed lookup).
  const { data: contextRow, error: ctxErr } = await supabase
    .from('agent_context_memory')
    .select('id, session_group_id, summary_markdown, file_refs, recent_messages, token_budget, version, created_at, updated_at')
    .eq('session_group_id', idResult.id)
    .maybeSingle<ContextRow>();

  if (ctxErr) {
    Sentry.captureException(new Error(`agent_context_memory fetch error: ${ctxErr.message}`), {
      extra: { route: ROUTE_ID },
    });
    return NextResponse.json({ error: 'Failed to fetch context' }, { status: 500 });
  }
  if (!contextRow) {
    // Group exists + owned, but no context_memory row yet (CLI hasn't synced).
    // 404 is correct — the resource being requested (the context) doesn't exist.
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  return NextResponse.json({ context: contextRow }, { headers: { 'Cache-Control': 'no-store' } });
}

export const GET = withApiAuthAndRateLimit(handleGet, ['read']);
