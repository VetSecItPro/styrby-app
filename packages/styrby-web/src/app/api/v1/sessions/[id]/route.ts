/**
 * GET /api/v1/sessions/[id]
 *
 * Gets a single session by ID.
 *
 * @auth Required - API key via Authorization: Bearer sk_live_xxx
 * @rateLimit 100 requests per minute per key
 *
 * @returns 200 { session: Session }
 * @error 404 { error: 'Session not found' }
 *
 * PATCH /api/v1/sessions/[id]
 *
 * Updates a session's mutable fields. Currently restricted to `session_group_id`
 * (the multi-agent orchestrator uses this to (re)assign sessions to a group, or
 * detach from a group by sending null). Future fields can be added to the Zod
 * schema below.
 *
 * @auth Required - 'write' scope
 * @rateLimit 100 requests per minute per key
 *
 * @body { session_group_id: string | null }  // UUID v4 or null to clear
 *
 * @returns 200 { id, session_group_id, updated_at }
 *
 * @error 400 { error }  - Invalid session ID format or Zod validation failure
 * @error 401 { error }  - Missing or invalid API key
 * @error 404 { error }  - Session not found, owned by another user, OR target group
 *                         not found / owned by another user (consistent IDOR-defense 404)
 * @error 429 { error }  - Rate limit exceeded
 * @error 500 { error }  - Unexpected database error (sanitized)
 *
 * @security OWASP A01:2021 - explicit ownership checks on session AND target group;
 *   404 on cross-user lookups, no existence leak.
 * @security OWASP A03:2021 - Zod .strict() body schema (mass-assignment guard).
 * @security OWASP A07:2021 - auth via withApiAuthAndRateLimit.
 * @security SOC 2 CC6.1 - 'write' scope required; service-role with explicit owner check.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { z } from 'zod';
import * as Sentry from '@sentry/nextjs';
import { withApiAuthAndRateLimit, addRateLimitHeaders, type ApiAuthContext } from '@/middleware/api-auth';
// WHY this import (used only by PATCH): canonical service-role helper used by
// /api/v1/contexts and /api/v1/sessions/groups/[id]/focus. Keeps PATCH on the
// same client surface as those routes; tests mock `@/lib/supabase/server`.
// GET still uses the legacy local createApiAdminClient() helper for backwards
// compatibility — it's identical functionally but already wired into existing
// GET tests via the @supabase/ssr mock.
import { createAdminClient } from '@/lib/supabase/server';

// ---------------------------------------------------------------------------
// Supabase Admin Client
// ---------------------------------------------------------------------------

function createApiAdminClient() {
  return createServerClient(
    (process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL)!,
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
  const { userId, keyId, keyExpiresAt } = context;

  // Extract session ID from URL
  const url = new URL(request.url);
  const segments = url.pathname.split('/');
  const sessionId = segments[segments.length - 1];

  // A-014: Proper UUID format validation (not just length check)
  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!sessionId || !UUID_REGEX.test(sessionId)) {
    return NextResponse.json(
      { error: 'Invalid session ID' },
      { status: 400 }
    );
  }

  const supabase = createApiAdminClient();

  const { data: session, error } = await supabase
    .from('sessions')
    .select(
      `
      id,
      machine_id,
      session_group_id,
      agent_type,
      model,
      title,
      summary,
      project_path,
      git_branch,
      git_remote_url,
      tags,
      is_archived,
      status,
      error_code,
      error_message,
      started_at,
      ended_at,
      last_activity_at,
      total_cost_usd,
      total_input_tokens,
      total_output_tokens,
      total_cache_tokens,
      message_count,
      context_window_used,
      context_window_limit,
      created_at,
      updated_at
    `
    )
    .eq('id', sessionId)
    .eq('user_id', userId)
    .is('deleted_at', null)
    .single();

  if (error) {
    if (error.code === 'PGRST116') {
      return NextResponse.json(
        { error: 'Session not found' },
        { status: 404 }
      );
    }
    console.error('Failed to fetch session:', error.message);
    return NextResponse.json(
      { error: 'Failed to fetch session' },
      { status: 500 }
    );
  }

  const response = NextResponse.json({ session });
  return addRateLimitHeaders(response, keyId, keyExpiresAt);
}

export const GET = withApiAuthAndRateLimit(handler);

// ---------------------------------------------------------------------------
// PATCH — update session_group_id
// ---------------------------------------------------------------------------

/**
 * Route ID used for Sentry breadcrumbs / extras. WHY a constant string
 * (not request.url): URL includes host + query strings which vary across
 * environments and may include PII. Stable string keeps logs clean.
 */
const PATCH_ROUTE_ID = '/api/v1/sessions/[id] PATCH';

/**
 * Reusable UUID-v4 regex. WHY duplicated locally (not imported): the GET
 * handler uses an inline regex; a shared helper would be a one-line module
 * for negligible benefit. Keep both eyes on the same file.
 */
const UUID_REGEX_PATCH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Body schema for PATCH /api/v1/sessions/[id].
 *
 * WHY .strict(): rejects unknown fields. Without this guard a caller could
 * inject `user_id`, `total_cost_usd`, etc. into the update payload — even if
 * the column wasn't intentionally exposed, mass-assignment to NOT-NULL columns
 * would surface a 500. .strict() returns 400 deterministically. OWASP A03:2021.
 *
 * WHY only session_group_id today: the orchestrator's PR-step3 needs exactly
 * this one field. Adding more fields here without a clear product need would
 * widen the attack surface. Future fields go through a separate review.
 */
const SessionPatchBodySchema = z
  .object({
    /**
     * UUID of the agent_session_groups row to assign this session to, or null
     * to detach from any group. The server verifies ownership of the target
     * group before applying the update. OWASP A01:2021 (IDOR defense).
     */
    session_group_id: z
      .union([z.string().uuid('session_group_id must be a valid UUID'), z.null()]),
  })
  .strict();

type SessionPatchBody = z.infer<typeof SessionPatchBodySchema>;

/**
 * Core PATCH handler — updates mutable fields on a session.
 *
 * Wrapped by withApiAuthAndRateLimit (write scope). Ownership is enforced at
 * the app layer because API-key auth has no auth.uid() context (RLS cannot run).
 *
 * Flow:
 *  1. Validate session ID from URL path (UUID v4)
 *  2. Parse + validate body via Zod .strict()
 *  3. Verify the session exists AND belongs to the authenticated user (404 IDOR)
 *  4. If session_group_id is non-null, verify the target group belongs to user (404 IDOR)
 *  5. Apply the UPDATE, return { id, session_group_id, updated_at }
 *
 * @param request - Authenticated NextRequest (PATCH /api/v1/sessions/[id])
 * @param authContext - Auth context (userId, keyId, scopes) from the wrapper
 * @returns 200 with the updated row, or an appropriate error response
 *
 * @security OWASP A01:2021 (Broken Access Control / IDOR): two ownership
 *   checks — session and target group — both 404 on mismatch.
 * @security OWASP A03:2021: Zod .strict() blocks mass-assignment.
 * @security SOC 2 CC6.1: write scope required.
 */
async function patchHandler(
  request: NextRequest,
  context: ApiAuthContext
): Promise<NextResponse> {
  const { userId, keyId, keyExpiresAt } = context;

  // 1. Extract session ID from path
  const url = new URL(request.url);
  const segments = url.pathname.split('/');
  const sessionId = segments[segments.length - 1];

  if (!sessionId || !UUID_REGEX_PATCH.test(sessionId)) {
    return NextResponse.json({ error: 'Invalid session ID' }, { status: 400 });
  }

  // 2. Parse + validate body
  let parsed: SessionPatchBody;
  try {
    const raw = await request.json();
    const result = SessionPatchBodySchema.safeParse(raw);
    if (!result.success) {
      const msg = result.error.errors
        .map((e) => `${e.path.join('.')}: ${e.message}`)
        .join('; ');
      return NextResponse.json({ error: msg }, { status: 400 });
    }
    parsed = result.data;
  } catch {
    return NextResponse.json({ error: 'Request body must be valid JSON' }, { status: 400 });
  }

  const supabase = createAdminClient();

  // 3. Verify session ownership (IDOR defense — 404 on mismatch)
  // WHY explicit (not RLS): API-key auth has no auth.uid(); RLS policies
  // referencing auth.uid() would block the SELECT from the service role.
  // WHY no `.is('deleted_at', null)`: ownership-only check is sufficient — the
  // UPDATE itself uses .eq('user_id', userId) and won't touch a soft-deleted
  // row's identity. Avoiding the extra filter keeps the query simple and the
  // mock surface tight.
  const { data: sessionRow, error: sessionErr } = await supabase
    .from('sessions')
    .select('id, user_id, deleted_at')
    .eq('id', sessionId)
    .maybeSingle<{ id: string; user_id: string; deleted_at: string | null }>();

  if (sessionErr) {
    Sentry.captureException(new Error(`sessions fetch error: ${sessionErr.message}`), {
      extra: { route: PATCH_ROUTE_ID, sessionId },
    });
    return NextResponse.json({ error: 'Failed to update session' }, { status: 500 });
  }

  if (!sessionRow || sessionRow.user_id !== userId || sessionRow.deleted_at !== null) {
    // 404 (not 403) keeps the IDOR-defense story consistent — caller cannot
    // distinguish "doesn't exist" from "belongs to someone else" from "soft-deleted".
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  // 4. If a non-null group was supplied, verify the target group belongs to user
  if (parsed.session_group_id !== null) {
    const { data: groupRow, error: groupErr } = await supabase
      .from('agent_session_groups')
      .select('id')
      .eq('id', parsed.session_group_id)
      .eq('user_id', userId)
      .maybeSingle<{ id: string }>();

    if (groupErr) {
      Sentry.captureException(new Error(`agent_session_groups fetch error: ${groupErr.message}`), {
        extra: { route: PATCH_ROUTE_ID, group_id: parsed.session_group_id },
      });
      return NextResponse.json({ error: 'Failed to update session' }, { status: 500 });
    }

    if (!groupRow) {
      // Group doesn't exist OR belongs to another user — same 404.
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }
  }

  // 5. Apply the update. WHY also constrain by user_id in the WHERE clause:
  // belt-and-suspenders — even if the ownership check above had a bug, the
  // UPDATE still cannot affect another user's row.
  const { data: updatedRow, error: updateErr } = await supabase
    .from('sessions')
    .update({
      session_group_id: parsed.session_group_id,
      updated_at: new Date().toISOString(),
    })
    .eq('id', sessionId)
    .eq('user_id', userId)
    .select('id, session_group_id, updated_at')
    .single<{ id: string; session_group_id: string | null; updated_at: string }>();

  if (updateErr) {
    Sentry.captureException(new Error(`sessions update error: ${updateErr.message}`), {
      extra: { route: PATCH_ROUTE_ID, sessionId },
    });
    return NextResponse.json({ error: 'Failed to update session' }, { status: 500 });
  }

  if (!updatedRow) {
    // Should not happen given the prior ownership check, but TS narrowing
    // keeps us honest. Sentry-capture so any race-condition regression is visible.
    Sentry.captureMessage('sessions UPDATE returned no row', {
      level: 'error',
      tags: { endpoint: PATCH_ROUTE_ID },
      extra: { sessionId },
    });
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }

  const response = NextResponse.json({
    id: updatedRow.id,
    session_group_id: updatedRow.session_group_id,
    updated_at: updatedRow.updated_at,
  });
  return addRateLimitHeaders(response, keyId, keyExpiresAt);
}

/**
 * PATCH /api/v1/sessions/[id]
 *
 * Required scopes: ['write'] — this mutates the session row.
 * Rate limit: default 100 req/min/key.
 */
export const PATCH = withApiAuthAndRateLimit(patchHandler, ['write']);
