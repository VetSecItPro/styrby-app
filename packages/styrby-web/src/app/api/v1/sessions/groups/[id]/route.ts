/**
 * DELETE /api/v1/sessions/groups/[id]
 *
 * Deletes an agent session group owned by the authenticated user. Used by the
 * CLI's multiAgentOrchestrator when tearing down a multi-agent workflow group.
 *
 * @auth Required - Bearer `styrby_*` API key via withApiAuthAndRateLimit
 * @rateLimit 100 requests per minute per key (default)
 *
 * @pathParam id - UUID of the session group to delete
 * @body none (DELETE operations have no request body by design)
 *
 * @returns 200 { deleted: boolean, id: string }
 *
 * @error 400 { error: 'Invalid id' }      — id is not a valid UUID
 * @error 401 { error: string }            — Missing or invalid API key
 * @error 404 { error: 'Not found' }       — Group does not exist OR belongs to another user
 * @error 500 { error: string }            — Unexpected database error (sanitized)
 *
 * @security OWASP A01:2021 (Broken Access Control / IDOR) — 404 for both
 *   "not found" and "wrong owner" so callers cannot distinguish existence.
 *   Owner check is enforced at the application layer (explicit user_id filter)
 *   rather than relying solely on RLS, because we use the service-role client
 *   to bypass RLS (auth.uid() is null for API-key requests).
 * @security OWASP A07:2021 (Identification and Authentication Failures) — auth
 *   enforced by withApiAuthAndRateLimit wrapper.
 * @security SOC 2 CC6.1 (Logical Access Controls) — 'write' scope required.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import * as Sentry from '@sentry/nextjs';

import {
  withApiAuthAndRateLimit,
  type ApiAuthContext,
} from '@/middleware/api-auth';
import { createAdminClient } from '@/lib/supabase/server';

// ---------------------------------------------------------------------------
// Path-param schema
// ---------------------------------------------------------------------------

/**
 * UUID regex aligned with the pattern used across existing v1 route handlers
 * (e.g. sessions/[id]/route.ts). Validates RFC 4122 UUID format.
 */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Zod schema for the `id` path parameter.
 *
 * WHY a permissive UUID regex (not z.string().uuid() which is v4-only): the
 * agent_session_groups.id column is created via gen_random_uuid() (v4 today),
 * but the project may adopt UUID v7 (time-ordered) for new tables in the
 * future. A permissive regex accepts any valid UUID variant so callers
 * using future v7 IDs aren't rejected at the boundary. Reject malformed
 * IDs (non-hex chars, wrong length, missing dashes) — that's the actual
 * security concern, not the version byte. OWASP A03:2021 injection guard.
 */
const IdParamSchema = z.string().regex(UUID_REGEX, 'Invalid UUID format');

// ---------------------------------------------------------------------------
// DB row interface
// ---------------------------------------------------------------------------

/**
 * Shape of the row returned when verifying group ownership before deletion.
 * Only user_id is needed — no other columns are required for the owner check.
 */
interface SessionGroupRow {
  user_id: string;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Core DELETE handler for session group deletion.
 *
 * Wrapped by withApiAuthAndRateLimit — never called directly. Performs an
 * explicit owner check (user_id filter) before deletion to defend against IDOR.
 *
 * Design notes:
 * - Hard delete: agent_session_groups has no deleted_at column (migration 035).
 *   Member sessions survive via ON DELETE SET NULL on sessions.session_group_id.
 * - Service-role client: RLS auth.uid() is null for API-key sessions; the owner
 *   check is enforced at the app layer instead.
 * - 404 for both "not found" and "wrong owner": consistent with OWASP A01:2021
 *   IDOR defense — do not reveal resource existence to unauthorized callers.
 *
 * @param request - Authenticated NextRequest (path param extracted from URL)
 * @param context - Auth context from withApiAuthAndRateLimit (userId, keyId, scopes)
 * @returns 200 { deleted: true, id } on success, or an error response
 *
 * @security OWASP A01:2021 — IDOR defense via 404 on owner mismatch
 * @security OWASP A07:2021 — auth enforced by withApiAuthAndRateLimit
 * @security SOC 2 CC6.1 — 'write' scope required; service-role with explicit owner check
 */
async function handleDelete(request: NextRequest, context: ApiAuthContext): Promise<NextResponse> {
  const { userId } = context;

  // -------------------------------------------------------------------------
  // Step 1: Extract and validate the `id` path parameter
  // WHY manual URL parsing (not Next.js params): Next.js App Router dynamic
  // segments are not passed into route handlers via the function signature when
  // using the HOC (withApiAuthAndRateLimit) pattern. The existing sessions/[id]/
  // route handler uses the same URL-split approach (see sessions/[id]/route.ts).
  // OWASP A03:2021 injection guard.
  // -------------------------------------------------------------------------
  const url = new URL(request.url);
  const segments = url.pathname.split('/');
  const rawId = segments[segments.length - 1];

  const parseResult = IdParamSchema.safeParse(rawId);
  if (!parseResult.success) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  }

  const id = parseResult.data;

  // -------------------------------------------------------------------------
  // Step 2: Verify group exists AND belongs to the authenticated user
  // WHY 404 on mismatch (not 403): returning 403 would reveal that the group
  // exists, enabling IDOR enumeration. A consistent 404 is the OWASP A01:2021
  // recommended defense. CC6.1: least-disclosure principle.
  // WHY service-role client + explicit user_id filter (not RLS):
  // auth.uid() is null for API-key requests, so RLS policies that use
  // user_id = (SELECT auth.uid()) would block the lookup. We use createAdminClient
  // (service-role) and apply the ownership constraint in the query directly.
  // -------------------------------------------------------------------------
  // WHY per-request createAdminClient: the function reads env vars on each
  // invocation, so a single module-level instance would cache stale config
  // during local dev hot-reload. The per-call overhead is ~1 ms; not a hot path.
  const supabase = createAdminClient();

  const { data: groupRow, error: fetchError } = await supabase
    .from('agent_session_groups')
    .select('user_id')
    .eq('id', id)
    .single<SessionGroupRow>();

  if (fetchError) {
    // PGRST116 = "no rows returned" — group does not exist
    if (fetchError.code === 'PGRST116') {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    // Unexpected DB error — capture + sanitize
    Sentry.captureException(
      new Error(`agent_session_groups fetch error: ${fetchError.message}`),
      {
        extra: {
          // WHY only id + route: avoids leaking user_id or schema internals
          // in Sentry breadcrumbs. PII hygiene (OWASP A02:2021).
          groupId: id,
          route: '/api/v1/sessions/groups/[id]',
        },
      },
    );
    return NextResponse.json({ error: 'Failed to delete session group' }, { status: 500 });
  }

  // Owner check — group exists but belongs to a different user
  // WHY 404 (not 403): consistent IDOR defense — same response as "not found".
  // OWASP A01:2021. Do NOT log or expose the real user_id of the other user.
  if (groupRow.user_id !== userId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // -------------------------------------------------------------------------
  // Step 3: Hard delete the group
  // WHY hard delete: agent_session_groups has no deleted_at column (migration 035).
  // Member sessions survive via ON DELETE SET NULL on sessions.session_group_id
  // and ON DELETE SET NULL on agent_session_groups.active_agent_session_id.
  // WHY no .eq('user_id', userId) on the DELETE: the select above already
  // confirmed ownership; adding a redundant filter is safe but not required
  // given the confirmed owner match. We include it as a defense-in-depth guard
  // (belt-and-suspenders). OWASP A01:2021.
  // -------------------------------------------------------------------------
  const { error: deleteError } = await supabase
    .from('agent_session_groups')
    .delete()
    .eq('id', id)
    .eq('user_id', userId); // defense-in-depth: belt-and-suspenders ownership guard

  if (deleteError) {
    Sentry.captureException(
      new Error(`agent_session_groups delete error: ${deleteError.message}`),
      {
        extra: {
          groupId: id,
          route: '/api/v1/sessions/groups/[id]',
        },
      },
    );
    return NextResponse.json({ error: 'Failed to delete session group' }, { status: 500 });
  }

  // -------------------------------------------------------------------------
  // Step 4: Return success
  // WHY `deleted: true` (not `deleted: false`): a 200 response always means the
  // group was successfully deleted. `deleted: false` would imply a no-op 200,
  // which is ambiguous. Second DELETE of the same id returns 404 (not found),
  // so the handler is naturally idempotent at the HTTP level.
  // -------------------------------------------------------------------------
  return NextResponse.json({ deleted: true, id }, { status: 200 });
}

// ---------------------------------------------------------------------------
// Export — wrapped with auth + default rate limit
// ---------------------------------------------------------------------------

/**
 * DELETE /api/v1/sessions/groups/[id]
 *
 * Required scopes: ['write'] — deletion is a mutating operation.
 * Rate limit: default 100 req/min/key (no override needed — not high-volume).
 *
 * WHY 'write' scope: prevents read-only API keys (e.g. dashboard integrations)
 * from deleting session groups. SOC 2 CC6.1 (least-privilege access).
 */
export const DELETE = withApiAuthAndRateLimit(handleDelete, ['write']);
