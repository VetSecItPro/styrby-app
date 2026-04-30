/**
 * POST /api/v1/contexts
 *
 * UPSERT into `agent_context_memory`. One record per session group; unique
 * constraint on `session_group_id`. Returns 201 on first insert (version=1),
 * 200 on subsequent updates (version incremented).
 *
 * Used by the CLI daemon to persist rolling context snapshots between agent
 * reconnects. On reconnect, the CLI fetches the latest context to restore
 * the agent's working memory without requiring a full session replay.
 *
 * NOTE: The `version` field is advisory under concurrency. Two concurrent
 * requests for the same session_group_id can both observe "no row" and both
 * set version=1. One wins the insert; the other's conflict-update may set
 * version=1 again. Callers using version for optimistic concurrency must
 * handle stale-version conflicts at the application layer.
 *
 * @auth Required - Bearer `styrby_*` API key via withApiAuthAndRateLimit
 * @rateLimit 100 requests per minute per key (default)
 * @idempotency Opt-in via Idempotency-Key header (24h replay window)
 *
 * @body {
 *   session_group_id: string,       // Required - UUID of the owning session group
 *   summary_markdown: string,       // Required - context summary, 1-50,000 chars
 *   file_refs?: FileRef[],          // Optional - files touched in this context window
 *   recent_messages?: RecentMsg[],  // Optional - last N message previews
 *   token_budget?: number,          // Optional - token budget hint, 100-8000 (default 4000)
 * }
 *
 * @returns 201 { id, session_group_id, version, created_at, updated_at } - first insert
 * @returns 200 { id, session_group_id, version, created_at, updated_at } - update
 *
 * @error 400 { error: string }  - Zod validation failure (incl. unknown fields)
 * @error 401 { error: string }  - Missing or invalid API key
 * @error 404 { error: string }  - session_group_id not found OR belongs to another user (IDOR)
 * @error 409 { error: string }  - Idempotency-Key body mismatch
 * @error 429 { error: string }  - Rate limit exceeded
 * @error 500 { error: string }  - Unexpected database error (sanitized)
 *
 * @security OWASP A01:2021 (Broken Access Control / IDOR) - ownership check on
 *   agent_session_groups before upsert; 404 for both "not found" and "wrong owner"
 *   so callers cannot distinguish resource existence from ownership failure.
 * @security OWASP A07:2021 (Identification and Authentication Failures) - auth
 *   enforced by withApiAuthAndRateLimit wrapper.
 * @security OWASP A03:2021 (Injection / Mass Assignment) - Zod .strict() guard
 *   rejects any fields not in the declared schema.
 * @security SOC 2 CC6.1 (Logical Access Controls) - 'write' scope required;
 *   service-role with explicit owner check (no RLS dependency).
 * @security GDPR Art 6(1)(a) - processing is lawful; user has consented to
 *   context memory writes via authenticated API key issuance.
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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Route identifier used as the idempotency cache key discriminator.
 * WHY a constant string (not request.url): URL includes host + query strings
 * which vary across environments. A stable string ensures cache hits work
 * regardless of where the request is routed. PII hygiene (strips query strings).
 */
const ROUTE_ID = '/api/v1/contexts';

/**
 * Default token budget applied when the caller omits token_budget.
 * WHY 4000: matches the DB column default per migration 039. Aligns with
 * the CLI daemon's context-compaction target for mid-sized agent sessions.
 */
const DEFAULT_TOKEN_BUDGET = 4000;

// ---------------------------------------------------------------------------
// Zod Schema — OWASP A03:2021 mass-assignment guard
// ---------------------------------------------------------------------------

/**
 * Request body schema for POST /api/v1/contexts.
 *
 * WHY .strict(): rejects any fields not listed in the schema. This prevents
 * mass-assignment attacks where a caller injects unexpected columns (e.g.
 * `user_id`, `version`, `created_at`) to tamper with the context record.
 * H42 Layer 3, OWASP A03:2021.
 */
const ContextBodySchema = z
  .object({
    /**
     * UUID of the agent_session_groups row that owns this context.
     * WHY uuid(): ensures the value is a well-formed UUID before it reaches
     * the DB — prevents raw string injection into a UUID column (OWASP A03:2021).
     */
    session_group_id: z.string().uuid('session_group_id must be a valid UUID'),

    /**
     * Markdown-formatted context summary produced by the CLI daemon.
     * WHY 50,000 char max: aligns with the agent_context_memory.summary_markdown
     * column's CHECK constraint (max 50KB). Enforced at the API layer so callers
     * get a 400 (not a cryptic DB error) on oversized payloads.
     */
    summary_markdown: z
      .string()
      .min(1, 'summary_markdown is required')
      .max(50_000, 'summary_markdown must be 50,000 characters or fewer'),

    /**
     * Files touched in this context window. Each entry records the path,
     * last-touch timestamp, and a relevance score used by the context
     * compaction algorithm to decide which files to drop first.
     */
    file_refs: z
      .array(
        z
          .object({
            /**
             * File path relative to project root.
             * WHY min(1): empty paths are nonsensical and would silently write an
             * empty string to the DB column. WHY max(1024): matches OS PATH_MAX.
             */
            path: z.string().min(1, 'file path must not be empty').max(1024, 'file path must be 1024 characters or fewer'),
            /**
             * ISO 8601 timestamp of the last edit event in this context window.
             * WHY string (not z.date()): the CLI writes ISO strings; coercing to Date
             * would cause a mismatch when the value is re-read from the DB.
             */
            lastTouchedAt: z.string(),
            /**
             * Relevance score 0-1 for context compaction ranking.
             * 0 = least relevant (drop first), 1 = most relevant (keep last).
             */
            relevance: z.number().min(0).max(1),
          })
          // WHY .strict(): rejects unknown nested fields (e.g. injected metadata).
          // Matches the outer schema's mass-assignment guard. OWASP A03:2021.
          .strict(),
      )
      .optional(),

    /**
     * Last N message previews included for fast reconnect context. The CLI
     * daemon truncates each preview to the `preview` max to avoid bloating
     * the context record with full message text.
     */
    recent_messages: z
      .array(
        z
          .object({
            /**
             * Message sender role. WHY max(50): mirrors typical role names
             * ("user", "assistant", "tool") with room for agent-specific variants.
             */
            role: z.string().max(50, 'role must be 50 characters or fewer'),
            /**
             * Truncated message preview. WHY max(500): enough context for the
             * reconnect agent without storing full message bodies here
             * (session_messages table holds those).
             */
            preview: z.string().max(500, 'preview must be 500 characters or fewer'),
          })
          // WHY .strict(): same mass-assignment guard as file_refs items. OWASP A03:2021.
          .strict(),
      )
      .optional(),

    /**
     * Token budget hint for the context window. The CLI daemon uses this to
     * decide how aggressively to compact context before a new agent turn.
     * WHY 100 min / 8000 max: mirrors the CHECK constraint on the table column
     * (db default is 4000). Values below 100 are nonsensical for any supported
     * model; values above 8000 exceed the CLI's context-compaction budget.
     */
    token_budget: z
      .number()
      .int('token_budget must be an integer')
      .min(100, 'token_budget must be at least 100')
      .max(8000, 'token_budget must be at most 8000')
      .optional(),
  })
  .strict(); // rejects unknown fields — mass-assignment guard

type ContextBody = z.infer<typeof ContextBodySchema>;

// ---------------------------------------------------------------------------
// DB Row interface
// ---------------------------------------------------------------------------

/**
 * Shape of the row returned after the agent_context_memory UPSERT.
 * WHY explicit interface: TypeScript will catch schema drift at compile time
 * rather than surfacing a silent runtime mismatch. Matches the returning
 * columns selected in the upsert query below.
 */
interface ContextRow {
  /** Primary key of the context record. */
  id: string;
  /** UUID of the owning session group. */
  session_group_id: string;
  /**
   * @field version - best-effort monotonic counter. Under concurrent
   * inserts to the same session_group_id, two clients can both observe
   * "no row exists" and both set version=1. One wins the insert; the
   * other's conflict-update may set version=1 again. Callers using
   * version for optimistic concurrency must handle stale-version
   * conflicts at the application layer.
   *
   * WHY this is acceptable: matches the existing CLI optimistic-locking
   * pattern in commands/context.ts. Stronger atomicity would require a
   * SECURITY DEFINER stored procedure - the only one in the codebase
   * for this single field, which is worse than the documented advisory
   * semantic.
   */
  version: number;
  /** ISO 8601 timestamp when this row was first created. */
  created_at: string;
  /** ISO 8601 timestamp of the most recent upsert. */
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Core POST handler for agent context memory upsert.
 *
 * Wrapped by withApiAuthAndRateLimit — never called directly. The wrapper
 * enforces:
 *  1. IP-based pre-auth rate limit (60 req/min/IP) — blocks unauthenticated floods
 *  2. Per-key rate limit (100 req/min/key default)
 *
 * Ownership flow:
 *  1. Validate body via Zod .strict()
 *  2. Verify session_group_id exists AND belongs to authenticated user
 *     (IDOR defense - OWASP A01:2021)
 *  3. Upsert agent_context_memory on conflict(session_group_id)
 *  4. Return 201 on first insert (version=1), 200 on update (version incremented)
 *
 * NOTE: version field is advisory under concurrency - see ContextRow JSDoc for details.
 *
 * @param request - Authenticated NextRequest
 * @param authContext - Auth context from withApiAuthAndRateLimit (userId, keyId, scopes)
 * @returns 201/200 with ContextRow fields, or an appropriate error response
 *
 * @security OWASP A01:2021 - IDOR defense: ownership check before upsert; 404 on mismatch
 * @security OWASP A07:2021 - auth enforced by withApiAuthAndRateLimit
 * @security OWASP A03:2021 - mass-assignment blocked by Zod .strict() (top-level and nested)
 * @security SOC 2 CC6.1 - 'write' scope required; service-role with explicit owner check
 * @security GDPR Art 6(1)(a) - lawful basis: user consent via API key issuance
 */
async function handlePost(request: NextRequest, authContext: ApiAuthContext): Promise<NextResponse> {
  const { userId } = authContext;

  // -------------------------------------------------------------------------
  // Step 1: Idempotency check (opt-in via Idempotency-Key header)
  // WHY before body parsing: the idempotency middleware reads the raw body
  // internally (via request.clone()) and returns the cached response if one
  // exists, short-circuiting before any business logic or DB writes.
  // -------------------------------------------------------------------------
  const idempotency = await checkIdempotency(request, userId, ROUTE_ID);

  if ('conflict' in idempotency) {
    // Same Idempotency-Key was previously used with a different body — reject.
    // WHY 409: RFC 9110 Conflict; client programming error, not server error.
    return NextResponse.json({ error: idempotency.message }, { status: 409 });
  }

  if (idempotency.replayed) {
    // Cache hit — return the stored response verbatim.
    // WHY X-Idempotency-Replay: signals to the CLI that this is a replay, not
    // a fresh upsert. Prevents double-counting on the client side.
    const replayResponse = NextResponse.json(idempotency.body, {
      status: idempotency.status,
    });
    replayResponse.headers.set('X-Idempotency-Replay', 'true');
    return replayResponse;
  }

  // -------------------------------------------------------------------------
  // Step 2: Parse + validate request body
  // WHY Zod .strict(): rejects any fields not in the schema, blocking
  // mass-assignment attempts. OWASP A03:2021, H42 Layer 3.
  // -------------------------------------------------------------------------
  let parsedBody: ContextBody;

  try {
    const rawBody = await request.json();
    const parseResult = ContextBodySchema.safeParse(rawBody);

    if (!parseResult.success) {
      const errorMessage = parseResult.error.errors
        .map((e) => `${e.path.join('.')}: ${e.message}`)
        .join('; ');

      return NextResponse.json({ error: errorMessage }, { status: 400 });
    }

    parsedBody = parseResult.data;
  } catch {
    // JSON.parse failure — malformed body
    return NextResponse.json({ error: 'Request body must be valid JSON' }, { status: 400 });
  }

  const { session_group_id, summary_markdown, file_refs, recent_messages, token_budget } =
    parsedBody;

  // -------------------------------------------------------------------------
  // Step 3: Verify session_group_id exists AND belongs to the authenticated user
  // WHY this check (not RLS): auth.uid() is null for API-key-authenticated
  // requests, so RLS policies referencing auth.uid() would block the SELECT.
  // We use the service-role client and enforce ownership at the app layer.
  // WHY 404 on mismatch (not 403): returning 403 reveals that the group exists,
  // enabling IDOR enumeration. A consistent 404 provides no existence signal.
  // OWASP A01:2021. SOC 2 CC6.1 (least-disclosure principle).
  // WHY per-request createAdminClient: the function reads env vars on each
  // invocation, so a single module-level instance would cache stale config
  // during local dev hot-reload. The per-call overhead is ~1 ms; not a hot path.
  // -------------------------------------------------------------------------
  const supabase = createAdminClient();

  const { data: groupRow, error: fetchError } = await supabase
    .from('agent_session_groups')
    .select('user_id')
    .eq('id', session_group_id)
    .single<{ user_id: string }>();

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
          // WHY only route + session_group_id: avoids leaking user_id or schema
          // internals in Sentry breadcrumbs. PII hygiene (OWASP A02:2021).
          session_group_id,
          route: ROUTE_ID,
        },
      },
    );
    return NextResponse.json({ error: 'Failed to upsert context memory' }, { status: 500 });
  }

  // Owner check — group exists but belongs to a different user.
  // WHY 404 (not 403): consistent IDOR defense — same response as "not found".
  // OWASP A01:2021. Do NOT log or expose the real user_id of the other user.
  if (groupRow.user_id !== userId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // -------------------------------------------------------------------------
  // Step 4: UPSERT into agent_context_memory
  // WHY upsert (not insert): the table has a UNIQUE constraint on
  // session_group_id (one context record per group). On conflict, we want to
  // update the existing row and increment version rather than error with a 409.
  // WHY version logic: on first insert we set version=1. On conflict, Postgres
  // increments the existing row's version via the onConflict update path.
  // The supabase-js .upsert() with ignoreDuplicates=false (default) triggers
  // DO UPDATE on conflict, which allows the DB to run the increment expression.
  //
  // NOTE: Supabase's .upsert() does not support raw SQL expressions in the
  // update payload (e.g. `version: sql'version + 1'`). We determine whether
  // this is an insert or update by checking if a row exists BEFORE the upsert
  // (we already fetched the group row above, but not the context row). We do a
  // SELECT on agent_context_memory to detect prior existence, then either INSERT
  // (version=1) or UPDATE (version++ via fetch → increment → update).
  // -------------------------------------------------------------------------

  // TOCTOU: see ContextRow JSDoc - version is advisory under concurrent writes.
  // Two concurrent requests can both observe "no row" here and both set version=1.
  // This matches the CLI's own optimistic-locking pattern (commands/context.ts).
  // Check for existing context row so we can determine 201 vs 200 and version.
  const { data: existingContext, error: existingError } = await supabase
    .from('agent_context_memory')
    .select('id, version')
    .eq('session_group_id', session_group_id)
    .single<{ id: string; version: number }>();

  if (existingError && existingError.code !== 'PGRST116') {
    // Unexpected error on the pre-check SELECT
    Sentry.captureException(
      new Error(`agent_context_memory select error: ${existingError.message}`),
      {
        extra: {
          session_group_id,
          route: ROUTE_ID,
        },
      },
    );
    return NextResponse.json({ error: 'Failed to upsert context memory' }, { status: 500 });
  }

  const isInsert = existingError?.code === 'PGRST116' || existingContext === null;
  const nextVersion = isInsert ? 1 : (existingContext?.version ?? 0) + 1;

  // Perform the actual upsert with the calculated version.
  // WHY onConflict: 'session_group_id': targets the unique constraint so
  // Postgres routes to DO UPDATE rather than DO NOTHING.
  const { data: upsertedRow, error: upsertError } = await supabase
    .from('agent_context_memory')
    .upsert(
      {
        session_group_id,
        summary_markdown,
        file_refs: file_refs ?? [],
        recent_messages: recent_messages ?? [],
        token_budget: token_budget ?? DEFAULT_TOKEN_BUDGET,
        version: nextVersion,
        updated_at: new Date().toISOString(),
        // WHY user_id from auth context (not body): prevents user_id spoofing.
        // OWASP A01:2021. The authenticated user_id is the ground truth.
        user_id: userId,
      },
      { onConflict: 'session_group_id' },
    )
    .select('id, session_group_id, version, created_at, updated_at')
    .single<ContextRow>();

  if (upsertError) {
    // WHY Sentry: unexpected DB errors need alerting. We do NOT surface the raw
    // error to the caller — it may contain PII or internal schema details.
    // OWASP A02:2021.
    Sentry.captureException(
      new Error(`agent_context_memory upsert error: ${upsertError.message}`),
      {
        extra: {
          session_group_id,
          route: ROUTE_ID,
        },
      },
    );
    return NextResponse.json({ error: 'Failed to upsert context memory' }, { status: 500 });
  }

  // -------------------------------------------------------------------------
  // Step 5: Cache the successful response for idempotency replay
  // WHY after the upsert: we store the committed row's fields so that any
  // replay returns the exact same row identifier and version, not a newly
  // computed one.
  // -------------------------------------------------------------------------

  // Guard: upsert succeeded (no error) but returned no row. This is an
  // unexpected DB behaviour (e.g. RETURNING clause suppressed by RLS on the
  // service role — should never happen, but TypeScript types this as nullable).
  if (!upsertedRow) {
    Sentry.captureMessage('Upsert succeeded but returned no row', {
      level: 'error',
      tags: { endpoint: ROUTE_ID },
      extra: { session_group_id },
    });
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }

  const responseStatus = isInsert ? 201 : 200;
  // TS narrowing from the null guard above — no unsafe cast needed.
  const responseBody: ContextRow = {
    id: upsertedRow.id,
    session_group_id: upsertedRow.session_group_id,
    version: upsertedRow.version,
    created_at: upsertedRow.created_at,
    updated_at: upsertedRow.updated_at,
  };

  await storeIdempotencyResult(request, userId, ROUTE_ID, responseStatus, responseBody);

  return NextResponse.json(responseBody, { status: responseStatus });
}

// ---------------------------------------------------------------------------
// Export — wrapped with auth + default rate limit
// ---------------------------------------------------------------------------

/**
 * POST /api/v1/contexts
 *
 * Required scopes: ['write'] — upsert is a mutating operation.
 * Rate limit: default 100 req/min/key.
 *
 * WHY 'write' scope: prevents read-only API keys (e.g. dashboard integrations)
 * from modifying agent context records. SOC 2 CC6.1 (least-privilege access).
 */
export const POST = withApiAuthAndRateLimit(handlePost, ['write']);
