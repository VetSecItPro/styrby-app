/**
 * POST /api/v1/sessions/groups
 *
 * INSERT into `agent_session_groups`. Used by the CLI's `styrby multi` flow
 * to create a parent record tying N concurrent agent sessions together.
 * Each individual session keeps its own session_id; they're linked via
 * sessions.session_group_id (set when the session is spawned).
 *
 * @auth Required - Bearer `styrby_*` API key via withApiAuthAndRateLimit
 * @rateLimit 100 requests per minute per key (default)
 * @idempotency Opt-in via Idempotency-Key header (24h replay window). Strongly
 *   recommended — group creation is otherwise non-idempotent and a CLI retry
 *   after a 5xx that succeeded server-side would create a duplicate group.
 *
 * @body {
 *   name?: string   // Optional - human label, max 255 chars; defaults to ''
 * }
 *
 * @returns 201 { group_id, name, created_at }
 *
 * @error 400 { error }  - Zod validation failure (incl. unknown fields)
 * @error 401 { error }  - Missing or invalid API key
 * @error 409 { error }  - Idempotency-Key body mismatch
 * @error 429 { error }  - Rate limit exceeded
 * @error 500 { error }  - Unexpected database error (sanitized)
 *
 * @security OWASP A01:2021 - user_id sourced from auth context only.
 * @security OWASP A03:2021 - Zod .strict() guards mass-assignment.
 * @security OWASP A07:2021 - auth enforced by withApiAuthAndRateLimit.
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
import {
  checkIdempotency,
  storeIdempotencyResult,
} from '@/lib/middleware/idempotency';

const ROUTE_ID = '/api/v1/sessions/groups';
const MAX_NAME_LENGTH = 255;

const GroupBodySchema = z
  .object({
    name: z.string().max(MAX_NAME_LENGTH).optional(),
  })
  .strict();

type GroupBody = z.infer<typeof GroupBodySchema>;

interface GroupRow {
  id: string;
  name: string;
  created_at: string;
}

async function handlePost(request: NextRequest, authContext: ApiAuthContext): Promise<NextResponse> {
  const { userId } = authContext;

  // -- Idempotency check ------------------------------------------------------
  const idempotency = await checkIdempotency(request, userId, ROUTE_ID);
  if ('conflict' in idempotency) {
    return NextResponse.json({ error: idempotency.message }, { status: 409 });
  }
  if (idempotency.replayed) {
    const replay = NextResponse.json(idempotency.body, { status: idempotency.status });
    replay.headers.set('X-Idempotency-Replay', 'true');
    return replay;
  }

  // -- Parse body -------------------------------------------------------------
  let parsed: GroupBody;
  try {
    const raw = await request.json().catch(() => ({}));
    const result = GroupBodySchema.safeParse(raw);
    if (!result.success) {
      const msg = result.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ');
      return NextResponse.json({ error: msg }, { status: 400 });
    }
    parsed = result.data;
  } catch {
    return NextResponse.json({ error: 'Request body must be valid JSON' }, { status: 400 });
  }

  // -- INSERT -----------------------------------------------------------------
  const supabase = createAdminClient();
  const { data: row, error: insertErr } = await supabase
    .from('agent_session_groups')
    .insert({
      user_id: userId,
      // WHY ?? '': matches the migration 035 default of empty string. Storing
      // null would distinguish "explicitly unnamed" from "default" but the
      // table uses NOT NULL DEFAULT '' so empty string is the canonical empty.
      name: parsed.name ?? '',
    })
    .select('id, name, created_at')
    .single<GroupRow>();

  if (insertErr) {
    Sentry.captureException(new Error(`agent_session_groups insert error: ${insertErr.message}`), {
      extra: { route: ROUTE_ID },
    });
    return NextResponse.json({ error: 'Failed to create session group' }, { status: 500 });
  }
  if (!row) {
    Sentry.captureMessage('Group insert returned no row', { level: 'error', tags: { endpoint: ROUTE_ID } });
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }

  const responseBody = { group_id: row.id, name: row.name, created_at: row.created_at };
  await storeIdempotencyResult(request, userId, ROUTE_ID, 201, responseBody);

  return NextResponse.json(responseBody, { status: 201 });
}

export const POST = withApiAuthAndRateLimit(handlePost, ['write']);

// ===========================================================================
// GET /api/v1/sessions/groups  —  list user's session groups
// ===========================================================================

/**
 * Shape of a session group row in the list response.
 *
 * Includes active_agent_session_id so the CLI / mobile UI can determine which
 * member session is currently focused without a follow-up query.
 */
interface SessionGroupSummary {
  id: string;
  name: string;
  active_agent_session_id: string | null;
  created_at: string;
  updated_at: string;
}

async function handleGet(_request: NextRequest, authContext: ApiAuthContext): Promise<NextResponse> {
  const { userId } = authContext;
  const supabase = createAdminClient();

  // WHY ORDER BY created_at DESC: matches the multi-agent session picker UX —
  // most recent group surfaces first. Most users have < 20 groups, no pagination.
  const { data: rows, error } = await supabase
    .from('agent_session_groups')
    .select('id, name, active_agent_session_id, created_at, updated_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) {
    Sentry.captureException(new Error(`agent_session_groups list error: ${error.message}`), {
      extra: { route: ROUTE_ID },
    });
    return NextResponse.json({ error: 'Failed to list session groups' }, { status: 500 });
  }

  const groups = (rows ?? []) as SessionGroupSummary[];
  return NextResponse.json(
    { groups, count: groups.length },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

export const GET = withApiAuthAndRateLimit(handleGet, ['read']);
