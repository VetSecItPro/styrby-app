/**
 * POST /api/sessions/groups/[groupId]/focus
 *
 * Sets the active_agent_session_id on an agent_session_group record,
 * directing the mobile UI to focus on a specific session within the group.
 *
 * This is the "tap a card" API: when the user taps an agent card in the
 * SessionGroupStrip on mobile, the app calls this endpoint to persist which
 * session is the current focus.
 *
 * Phase 3.5 extension:
 *   On successful focus change, this endpoint additionally reads the group's
 *   agent_context_memory record (if one exists) and builds a ContextInjectionPayload.
 *   The payload is included in the response as `contextInjection`. The CLI
 *   daemon receives this payload via the Realtime channel and injects it as a
 *   system-role message to the newly-focused agent before its first user prompt.
 *
 *   WHY inject via focus endpoint response rather than a separate fetch:
 *     The focus change and context fetch are a single atomic operation from
 *     the user's perspective ("I tapped a card — now that agent knows what I
 *     was doing"). Bundling them in one response eliminates a round trip and
 *     avoids a race where the CLI fetches context before the focus update is
 *     committed.
 *
 *   WHY nullable contextInjection:
 *     A group may have no memory record yet (user hasn't run `styrby context sync`
 *     or the group was just created). Returning null lets the CLI detect this
 *     and proceed without injection (cold start — same behavior as pre-Phase-3.5).
 *
 * Security model:
 *   - User must own the group (RLS enforces via user_id = auth.uid())
 *   - sessionId must belong to the group (explicit membership check)
 *   - No cross-user group focus (cannot focus another user's sessions)
 *   - contextInjection contains only SCRUBBED content (Phase 3.3 scrub engine
 *     was applied when the memory record was written by `styrby context sync`)
 *   - token_budget is server-side enforced (capped at 8000); client cannot
 *     request a larger injection payload
 *
 * @auth Required - Supabase Auth JWT via cookie
 * @rateLimit 60 requests per minute per user (mobile swipe UX)
 *
 * @param groupId - UUID of the agent_session_group (path param)
 *
 * @body {
 *   sessionId: string (UUID) - The session within the group to focus
 * }
 *
 * @returns 200 {
 *   groupId: string,
 *   activeSessionId: string,
 *   updatedAt: string  (ISO 8601),
 *   contextInjection: ContextInjectionPayload | null  (Phase 3.5)
 * }
 *
 * @error 400 { error: 'VALIDATION_FAILED', message: string }
 * @error 401 { error: 'UNAUTHORIZED', message: string }
 * @error 403 { error: 'FORBIDDEN', message: string } - Group not found or not owned by user
 * @error 404 { error: 'NOT_FOUND', message: string } - sessionId not in this group
 * @error 429 { error: 'RATE_LIMITED', retryAfter: number }
 * @error 500 { error: 'INTERNAL_ERROR', message: string }
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { rateLimit, RATE_LIMITS, rateLimitResponse } from '@/lib/rateLimit';
import { z } from 'zod';
import { apiError } from '@styrby/shared';
import { buildInjectionPrompt } from '@styrby/shared/context-sync';
import type { AgentContextMemory, ContextInjectionPayload } from '@styrby/shared/context-sync';

// ---------------------------------------------------------------------------
// Request Schema
// ---------------------------------------------------------------------------

/**
 * Schema for the focus request body.
 * Only the sessionId is required — no other group fields are touched.
 */
const FocusSessionSchema = z.object({
  sessionId: z.string().uuid('sessionId must be a valid UUID'),
});

// ---------------------------------------------------------------------------
// Route params type
// ---------------------------------------------------------------------------

interface RouteContext {
  params: Promise<{ groupId: string }>;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * POST /api/sessions/groups/[groupId]/focus
 *
 * Updates active_agent_session_id for the given group.
 * Verifies group ownership and session membership before writing.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  // Rate-limit before auth or DB work.
  // WHY higher maxRequests than session creation (30/min): focus changes happen
  // on every swipe/tap, so we allow up to 60/min to handle fast mobile UX.
  const { allowed: rateLimitAllowed, retryAfter } = await rateLimit(
    request,
    { ...RATE_LIMITS.budgetAlerts, maxRequests: 60 },
    'session-group-focus'
  );
  if (!rateLimitAllowed) {
    return rateLimitResponse(retryAfter!);
  }

  try {
    const supabase = await createClient();

    // Authenticate user.
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json(
        apiError('UNAUTHORIZED', 'Authentication required'),
        { status: 401 }
      );
    }

    // Validate path param.
    const { groupId } = await context.params;
    const groupIdParsed = z.string().uuid().safeParse(groupId);
    if (!groupIdParsed.success) {
      return NextResponse.json(
        apiError('VALIDATION_FAILED', 'groupId must be a valid UUID'),
        { status: 400 }
      );
    }

    // Parse + validate request body.
    const rawBody = await request.json().catch(() => null);
    if (!rawBody) {
      return NextResponse.json(
        apiError('VALIDATION_FAILED', 'Request body is required'),
        { status: 400 }
      );
    }

    const parseResult = FocusSessionSchema.safeParse(rawBody);
    if (!parseResult.success) {
      return NextResponse.json(
        apiError(
          'VALIDATION_FAILED',
          parseResult.error.errors.map((e) => e.message).join(', '),
          { issues: parseResult.error.errors.map((e) => ({ path: e.path, message: e.message })) }
        ),
        { status: 400 }
      );
    }

    const { sessionId } = parseResult.data;

    // ── 1. Verify the group exists and belongs to this user ────────────────
    // WHY explicit ownership check (same FIX-025 pattern as sessions/route.ts):
    // RLS provides a baseline, but a compromised client could pass a valid group
    // UUID from another user. This check is explicit and logged.
    const { data: group, error: groupError } = await supabase
      .from('agent_session_groups')
      .select('id, user_id')
      .eq('id', groupId)
      .eq('user_id', user.id)
      .single();

    if (groupError || !group) {
      return NextResponse.json(
        apiError('FORBIDDEN', 'Session group not found or access denied'),
        { status: 403 }
      );
    }

    // ── 2. Verify the sessionId belongs to this group ──────────────────────
    // WHY: Without this check, a user could focus an arbitrary session (from
    // a different group or a different user) onto this group. The
    // active_agent_session_id FK has no user_id constraint — the RLS guard
    // must come from this explicit membership check.
    const { data: sessionRow, error: sessionError } = await supabase
      .from('sessions')
      .select('id, session_group_id')
      .eq('id', sessionId)
      .eq('session_group_id', groupId)
      .single();

    if (sessionError || !sessionRow) {
      return NextResponse.json(
        apiError(
          'NOT_FOUND',
          'Session not found in this group'
        ),
        { status: 404 }
      );
    }

    // ── 3. Update active_agent_session_id ──────────────────────────────────
    const { data: updated, error: updateError } = await supabase
      .from('agent_session_groups')
      .update({ active_agent_session_id: sessionId })
      .eq('id', groupId)
      .select('id, active_agent_session_id, updated_at')
      .single();

    if (updateError || !updated) {
      const isDev = process.env.NODE_ENV === 'development';
      console.error(
        '[sessions/groups/focus] Failed to update group:',
        isDev ? updateError : updateError?.message
      );
      return NextResponse.json(
        apiError('INTERNAL_ERROR', 'Failed to update session focus'),
        { status: 500 }
      );
    }

    // ── 4. Write audit log (non-fatal) ─────────────────────────────────────
    await supabase.from('audit_log').insert({
      user_id: user.id,
      action: 'session_group_focus_changed',
      metadata: {
        group_id: groupId,
        focused_session_id: sessionId,
      },
    }).then(({ error: auditError }) => {
      if (auditError) {
        // WHY non-fatal: audit log failure must not block the user's UX.
        console.warn('[sessions/groups/focus] Audit log insert failed:', auditError.message);
      }
    });

    // ── 5. Phase 3.5: Fetch context memory and build injection payload ─────
    // WHY after the focus update (not before): The focus update is the critical
    // path. Context injection is a best-effort enhancement — if memory fetch
    // fails, we still return 200 with contextInjection: null. The new agent
    // starts cold (same as pre-Phase-3.5) rather than the entire focus change
    // failing because of a secondary lookup.
    //
    // WHY server-side injection payload: The CLI daemon receives this payload
    // in the response and injects it as a system-role message before the first
    // user prompt. Building the payload here (rather than returning raw memory)
    // means the daemon only needs to pass it through — no summarizer code needed
    // in the daemon process.
    //
    // SECURITY: contextInjection is built from agent_context_memory, which
    // was written by `styrby context sync` after applying the Phase 3.3 scrub
    // engine. No raw message content is in the memory record.
    let contextInjection: ContextInjectionPayload | null = null;

    try {
      const { data: memoryRow } = await supabase
        .from('agent_context_memory')
        .select('*')
        .eq('session_group_id', groupId)
        .order('version', { ascending: false })
        .limit(1)
        .single();

      if (memoryRow) {
        // Map DB columns → AgentContextMemory interface
        const memory: AgentContextMemory = {
          id: String(memoryRow.id),
          sessionGroupId: String(memoryRow.session_group_id),
          summaryMarkdown: String(memoryRow.summary_markdown),
          fileRefs: (memoryRow.file_refs as AgentContextMemory['fileRefs']) ?? [],
          recentMessages: (memoryRow.recent_messages as AgentContextMemory['recentMessages']) ?? [],
          tokenBudget: Number(memoryRow.token_budget),
          version: Number(memoryRow.version),
          createdAt: String(memoryRow.created_at),
          updatedAt: String(memoryRow.updated_at),
        };

        contextInjection = buildInjectionPrompt(memory);

        // Audit the injection (non-fatal)
        await supabase.from('audit_log').insert({
          user_id: user.id,
          action: 'context_memory_injected',
          metadata: {
            group_id: groupId,
            focused_session_id: sessionId,
            estimated_tokens: contextInjection.estimatedTokens,
            file_ref_count: contextInjection.includedFileRefs.length,
            message_count: contextInjection.messageCount,
          },
        }).then(({ error: injAuditError }) => {
          if (injAuditError) {
            console.warn('[sessions/groups/focus] Context injection audit failed:', injAuditError.message);
          }
        });
      }
    } catch (memoryError) {
      // WHY catch-all: context fetch errors must never block the focus change.
      // Log in dev; silence in production to avoid log noise from groups
      // that have no memory record yet.
      if (process.env.NODE_ENV === 'development') {
        console.warn('[sessions/groups/focus] Context memory fetch error:', memoryError);
      }
      // contextInjection remains null — cold start for the new agent
    }

    return NextResponse.json({
      groupId: updated.id,
      activeSessionId: updated.active_agent_session_id,
      updatedAt: updated.updated_at,
      // Phase 3.5: null when no memory record exists yet — agent starts cold
      contextInjection,
    });
  } catch (error) {
    const isDev = process.env.NODE_ENV === 'development';
    console.error(
      '[sessions/groups/focus] Unexpected error:',
      isDev ? error : error instanceof Error ? error.message : 'Unknown'
    );
    return NextResponse.json(
      apiError('INTERNAL_ERROR', 'An unexpected error occurred'),
      { status: 500 }
    );
  }
}
