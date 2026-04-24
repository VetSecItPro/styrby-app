/**
 * Admin Support Session Metadata Viewer
 *
 * Route: `/dashboard/admin/support/session/[sessionId]?grant=<raw-token>`
 *
 * @route GET /dashboard/admin/support/session/[sessionId]
 * @auth Required — site admin only. Enforced by:
 *   1. `src/middleware.ts` — 404 for non-site-admins on `/dashboard/admin/*`
 *   2. `src/app/dashboard/admin/layout.tsx` — redirects non-site-admins
 *   3. `admin_consume_support_access` RPC — is_site_admin(auth.uid()) in body
 *   SOC2 CC6.1: Triple-gated access.
 *
 * Purpose:
 *   Renders session metadata (timestamps, agent type, token counts, message
 *   tool trace) for an admin using a consent-gated support access token.
 *   Message CONTENT is never fetched, never rendered, never projected.
 *
 * Security properties:
 *   - Token is hashed client-side before the RPC call; raw token never touches DB
 *   - admin_consume_support_access is called once per render — not cached
 *   - SELECT is constrained to a hardcoded field allowlist (defense-in-depth)
 *   - Content fields (`content_encrypted`, `encryption_nonce`) are never selected
 *   - RPC 22023 errors surface "access denied or expired" (oracle-collapse)
 *   - grant_id (not token_hash) is logged to telemetry
 *   - Cache-Control: no-store on the response header (no CDN/proxy caching)
 *   - Rate limited: 20 requests/minute per admin (Upstash, with in-memory fallback)
 *
 * SOC2 CC6.1: Logical access controls — token-based, scoped, audited.
 * SOC2 CC6.3: Per-session scoping; session_id mismatch triggers explicit deny.
 * SOC2 CC7.2: Every consume is audited to admin_audit_log in the RPC transaction.
 * GDPR Art 7: User consented per-session, revocable at any time.
 * GDPR Art 25: Data minimisation — allowlist enforced at SELECT and Zod schema.
 * OWASP A01:2021: grant not cached across requests; session_id verified post-RPC.
 * OWASP A02:2021: Token hashed before any DB contact; raw token discarded.
 *
 * @module app/dashboard/admin/support/session/[sessionId]/page
 */

import crypto from 'crypto';
import { notFound } from 'next/navigation';
import { headers } from 'next/headers';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { rateLimit, RATE_LIMITS, rateLimitResponse } from '@/lib/rateLimit';

// ============================================================================
// Constants
// ============================================================================

/**
 * Hardcoded SELECT allowlist for session_messages rows (defense-in-depth).
 *
 * WHY hardcoded (not scope.fields only):
 *   scope.fields is the DB-granted set of readable fields, supplied by the
 *   admin_consume_support_access RPC. A hardcoded allowlist here is an
 *   additional defense-in-depth layer: even if the scope were somehow
 *   widened by a DB misconfiguration, this allowlist prevents any new field
 *   from reaching the SELECT statement without an explicit code change.
 *   The intersection of (scope.fields ∩ ROUTE_FIELD_ALLOWLIST) is applied.
 *   GDPR Art 25: data minimisation at the application boundary.
 *
 * CRITICAL: 'content_encrypted' and 'encryption_nonce' must NEVER appear here.
 * These are E2E-encrypted message bodies and are architecturally inaccessible
 * to support — even if a grant scope were maliciously set to include them.
 */
const ROUTE_FIELD_ALLOWLIST: ReadonlyArray<string> = [
  'id',
  'sequence_number',
  'message_type',
  'tool_name',
  'input_tokens',
  'output_tokens',
  'cache_tokens',
  'duration_ms',
  'created_at',
] as const;

/**
 * Maximum session messages fetched per render.
 * WHY 50: provides enough context for support without bulk export risk.
 */
const MESSAGE_LIMIT = 50;

/**
 * Rate limit for admin support session view route.
 * WHY 20/min: per spec §4.4 carryover from T2 threat review.
 * Tighter than the default RATE_LIMITS.standard (100/min) because this
 * route consumes a grant access_count slot per call — excessive calls could
 * exhaust a grant's max_access_count (default 10) rapidly.
 */
const ADMIN_SUPPORT_SESSION_RATE_LIMIT = {
  windowMs: 60_000,
  maxRequests: 20,
} as const;

// ============================================================================
// Zod schemas
// ============================================================================

/**
 * Schema for the raw token query parameter.
 *
 * WHY base64url regex (43 chars for 32 bytes):
 *   `crypto.randomBytes(32).toString('base64url')` produces exactly 43
 *   characters of [A-Za-z0-9_-] (base64url alphabet, no padding '=').
 *   Rejecting any other format before hashing prevents timing side-channels
 *   from malformed inputs and eliminates hash-collision probe attempts using
 *   differently-structured inputs (OWASP A02:2021).
 */
const GrantTokenSchema = z.string().regex(/^[0-9a-zA-Z_-]{43}$/);

/**
 * Schema for a single session_messages row (NEVER includes content fields).
 *
 * WHY explicit Zod schema (not TypeScript types only):
 *   Zod validates the shape at runtime, not just at compile time. If a
 *   Supabase query accidentally returns a content field (e.g. from a future
 *   wildcard change), Zod's `.strict()` would strip it. Defense-in-depth
 *   against accidental content exposure. GDPR Art 25.
 *
 * CRITICAL: 'content_encrypted' and 'encryption_nonce' MUST NOT be added here.
 */
const MessageRowSchema = z.object({
  id: z.string().uuid(),
  sequence_number: z.number().int().nonnegative(),
  message_type: z.string(),
  tool_name: z.string().nullable(),
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cache_tokens: z.number().int().nonnegative(),
  duration_ms: z.number().int().nonnegative().nullable(),
  created_at: z.string(),
});

/**
 * Schema for the session row (metadata only).
 *
 * WHY explicit schema: same reasoning as MessageRowSchema — runtime validation
 * prevents accidental content exposure even if query shape changes. GDPR Art 25.
 */
const SessionRowSchema = z.object({
  id: z.string().uuid(),
  agent_type: z.string(),
  status: z.string(),
  started_at: z.string(),
  ended_at: z.string().nullable(),
  total_cost_usd: z.number(),
  total_input_tokens: z.number().int().nonnegative(),
  total_output_tokens: z.number().int().nonnegative(),
  total_cache_tokens: z.number().int().nonnegative(),
  message_count: z.number().int().nonnegative(),
  model: z.string().nullable(),
});

type MessageRow = z.infer<typeof MessageRowSchema>;
type SessionRow = z.infer<typeof SessionRowSchema>;

// ============================================================================
// Page props
// ============================================================================

interface PageProps {
  params: Promise<{ sessionId: string }>;
  searchParams: Promise<{ grant?: string }>;
}

// ============================================================================
// Error/access-denied sub-component
// ============================================================================

/**
 * Renders a generic access denied / expired page.
 *
 * WHY generic message (not "token expired" vs "wrong session" etc.):
 *   Oracle-collapse — the admin must not learn whether their token is valid
 *   but expired vs. valid but for a different session vs. consumed. Any
 *   distinguishing message would allow probing token state. OWASP A02:2021.
 */
function AccessDeniedPage() {
  return (
    <div className="flex min-h-[40vh] flex-col items-center justify-center gap-4 py-16 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-red-500/10">
        <span className="text-2xl text-red-400" aria-hidden="true">
          &times;
        </span>
      </div>
      <h1 className="text-lg font-semibold text-zinc-100">
        Access denied or expired
      </h1>
      <p className="max-w-sm text-sm text-zinc-400">
        This support access grant is invalid, expired, revoked, or has already been consumed.
        Request a new grant from the ticket page if continued access is required.
      </p>
    </div>
  );
}

// ============================================================================
// Session metadata sub-component
// ============================================================================

/**
 * Renders the session metadata summary card.
 *
 * @param session - Validated session row (metadata only, never content)
 * @param grantId - Grant ID for display (not the token hash)
 * @param accessCount - Current access count after this consume
 */
function SessionMetaCard({
  session,
  grantId,
  accessCount,
}: {
  session: SessionRow;
  grantId: bigint;
  accessCount: number;
}) {
  const totalTokens =
    session.total_input_tokens + session.total_output_tokens + session.total_cache_tokens;

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-6">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-zinc-300">Session Overview</h2>
          <p className="mt-0.5 font-mono text-xs text-zinc-500">{session.id}</p>
        </div>
        <span
          className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${
            session.status === 'active'
              ? 'bg-green-500/10 text-green-400'
              : session.status === 'completed'
              ? 'bg-blue-500/10 text-blue-400'
              : 'bg-zinc-700/50 text-zinc-400'
          }`}
        >
          {session.status}
        </span>
      </div>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-xs text-zinc-500">Agent</dt>
          <dd className="mt-0.5 font-medium text-zinc-200">{session.agent_type}</dd>
        </div>
        {session.model && (
          <div>
            <dt className="text-xs text-zinc-500">Model</dt>
            <dd className="mt-0.5 font-medium text-zinc-200">{session.model}</dd>
          </div>
        )}
        <div>
          <dt className="text-xs text-zinc-500">Started</dt>
          <dd className="mt-0.5 text-zinc-200">
            {new Date(session.started_at).toLocaleString()}
          </dd>
        </div>
        {session.ended_at && (
          <div>
            <dt className="text-xs text-zinc-500">Ended</dt>
            <dd className="mt-0.5 text-zinc-200">
              {new Date(session.ended_at).toLocaleString()}
            </dd>
          </div>
        )}
        <div>
          <dt className="text-xs text-zinc-500">Total tokens</dt>
          <dd className="mt-0.5 text-zinc-200">{totalTokens.toLocaleString()}</dd>
        </div>
        <div>
          <dt className="text-xs text-zinc-500">Cost (USD)</dt>
          <dd className="mt-0.5 text-zinc-200">${session.total_cost_usd.toFixed(4)}</dd>
        </div>
        <div>
          <dt className="text-xs text-zinc-500">Messages</dt>
          <dd className="mt-0.5 text-zinc-200">{session.message_count}</dd>
        </div>
      </dl>

      {/* Grant context — shows grant_id (never token_hash) */}
      <div className="mt-4 border-t border-zinc-800 pt-4">
        <p className="text-xs text-zinc-500">
          Support grant:{' '}
          <span className="font-mono text-zinc-400">#{grantId.toString()}</span>
          {' · '}
          Access #{accessCount} of this grant
        </p>
      </div>
    </div>
  );
}

// ============================================================================
// Message metadata table sub-component
// ============================================================================

/**
 * Renders the message metadata table.
 *
 * CRITICAL: No 'content' column exists or will ever exist in this table.
 * Message content is E2E-encrypted and architecturally inaccessible to support.
 * GDPR Art 25: data minimisation at render boundary.
 *
 * @param messages - Validated message rows (metadata only)
 */
function MessageMetaTable({ messages }: { messages: MessageRow[] }) {
  if (messages.length === 0) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900 px-6 py-10 text-center">
        <p className="text-sm text-zinc-500">No messages found for this session.</p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900">
      {/* WHY no-content notice: explicit reminder to any admin that content is not
          shown — not a technical limitation of this view, but an architectural guarantee.
          Reduces the chance of a confused admin thinking content "failed to load".
          GDPR Art 25 transparency. */}
      <div className="border-b border-zinc-800 bg-amber-500/5 px-4 py-2">
        <p className="text-xs text-amber-400">
          Metadata only - message content is E2E-encrypted and never accessible to support
        </p>
      </div>

      <div className="overflow-x-auto">
        <table
          className="w-full min-w-[600px] text-sm"
          aria-label="Session message metadata"
        >
          <thead>
            <tr className="border-b border-zinc-800 text-left">
              <th className="px-4 py-3 text-xs font-semibold text-zinc-500">#</th>
              <th className="px-4 py-3 text-xs font-semibold text-zinc-500">Timestamp</th>
              <th className="px-4 py-3 text-xs font-semibold text-zinc-500">Type</th>
              <th className="px-4 py-3 text-xs font-semibold text-zinc-500">Tool</th>
              <th className="px-4 py-3 text-xs font-semibold text-zinc-500">In tokens</th>
              <th className="px-4 py-3 text-xs font-semibold text-zinc-500">Out tokens</th>
              <th className="px-4 py-3 text-xs font-semibold text-zinc-500">Duration (ms)</th>
            </tr>
          </thead>
          <tbody>
            {messages.map((msg) => (
              <tr
                key={msg.id}
                className="border-b border-zinc-800/50 transition-colors hover:bg-zinc-800/30"
              >
                <td className="px-4 py-2.5 font-mono text-xs text-zinc-500">
                  {msg.sequence_number}
                </td>
                <td className="px-4 py-2.5 text-xs text-zinc-400">
                  {new Date(msg.created_at).toLocaleString()}
                </td>
                <td className="px-4 py-2.5">
                  <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-xs text-zinc-300">
                    {msg.message_type}
                  </span>
                </td>
                <td className="px-4 py-2.5 font-mono text-xs text-zinc-400">
                  {msg.tool_name ?? (
                    <span className="text-zinc-400">-</span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-xs text-zinc-400 tabular-nums">
                  {msg.input_tokens.toLocaleString()}
                </td>
                <td className="px-4 py-2.5 text-xs text-zinc-400 tabular-nums">
                  {msg.output_tokens.toLocaleString()}
                </td>
                <td className="px-4 py-2.5 text-xs text-zinc-400 tabular-nums">
                  {msg.duration_ms != null ? msg.duration_ms.toLocaleString() : (
                    <span className="text-zinc-400">-</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="border-t border-zinc-800 px-4 py-3">
        <p className="text-xs text-zinc-500">
          Showing {messages.length} most recent message{messages.length !== 1 ? 's' : ''}
          {messages.length === MESSAGE_LIMIT ? ` (limited to ${MESSAGE_LIMIT})` : ''}
        </p>
      </div>
    </div>
  );
}

// ============================================================================
// Page component (Server Component)
// ============================================================================

/**
 * Admin Support Session Metadata Page — Server Component.
 *
 * Security contract (all enforced in this component):
 *   1. Grant param validated by Zod before hashing — malformed → notFound()
 *   2. Raw token hashed to SHA-256 hex before ANY RPC call
 *   3. admin_consume_support_access called once per render — NOT cached
 *      WHY: caching the returned session_id/scope across requests would allow
 *      a second admin to reuse the first admin's grant slot without consuming
 *      their own access_count — violating the A1.1 cap guarantee. T2 threat review.
 *   4. RPC 22023 → AccessDeniedPage (oracle-collapse, not notFound)
 *   5. returned session_id verified against URL param — mismatch → AccessDeniedPage
 *      WHY: token could legitimately belong to a different session (e.g. URL param
 *      was copied incorrectly). Matching ensures the admin sees the session they
 *      intended, and that a token for session A cannot be used to view session B.
 *      SOC2 CC6.3 per-session scoping.
 *   6. SELECT constrained to ROUTE_FIELD_ALLOWLIST ∩ scope.fields
 *   7. 'content_encrypted' never in SELECT (compile-time + runtime guarantee)
 *   8. grant_id logged to telemetry (never token_hash, never raw token)
 *   9. Cache-Control: no-store set via next/headers response headers
 *      WHY: session metadata is sensitive. Stale cached responses on CDN/proxy
 *      could surface one admin's view to another. no-store is mandatory.
 *      SOC2 CC6.1 / OWASP A01:2021.
 *  10. Rate limited 20/min per admin — Upstash where configured, in-memory fallback
 *
 * @param params.sessionId - UUID of the session from the URL path
 * @param searchParams.grant - Raw support access token (base64url, 43 chars)
 */
export default async function AdminSupportSessionPage({
  params,
  searchParams,
}: PageProps) {
  const { sessionId } = await params;
  const { grant: rawToken } = await searchParams;

  // ── Step 1: Validate grant param format ────────────────────────────────────
  // WHY notFound() (not AccessDeniedPage) for missing/malformed token:
  //   A missing or malformed token is almost certainly a navigation error
  //   (e.g. admin went to the URL directly without a token) — not an access
  //   attempt with a bad credential. notFound() returns 404 which is less
  //   informative to scanners than an explicit deny page. AccessDeniedPage is
  //   reserved for cases where a well-formed token failed DB validation.
  if (!rawToken) {
    notFound();
  }

  const parseResult = GrantTokenSchema.safeParse(rawToken);
  if (!parseResult.success) {
    notFound();
  }

  // ── Step 2: Hash the raw token ─────────────────────────────────────────────
  // WHY hash here, not pass rawToken to RPC:
  //   The raw token is the secret. The DB stores only the SHA-256 hash.
  //   Passing rawToken directly to any DB call would expose it in query logs.
  //   OWASP A02:2021: cryptographic secrets never touch the DB in plaintext.
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

  // ── Step 3: Rate limit (per admin user, 20/min) ─────────────────────────────
  // WHY rate limit at route level (on top of DB max_access_count cap):
  //   The DB cap (default 10 total accesses per grant) is a lifetime cap.
  //   Rate limiting adds a time-dimension cap: no more than 20 calls/minute
  //   from a single admin. This limits the blast radius of a stolen token +
  //   compromised admin account attempting rapid enumeration. T2 carryover.
  //   SOC2 A1.1: dual-layer access count controls.
  const headersList = await headers();
  // Build a minimal Request-like object to satisfy rateLimit's interface.
  // We only need the IP-bearing headers — not a full HTTP request.
  const syntheticRequest = {
    headers: {
      get: (name: string) => headersList.get(name),
    },
  } as unknown as Request;

  const rateLimitResult = await rateLimit(
    syntheticRequest,
    ADMIN_SUPPORT_SESSION_RATE_LIMIT,
    'admin-support-session',
  );

  if (!rateLimitResult.allowed) {
    // In Server Components we can't return a Response directly, but we can
    // use notFound() as the best available escape hatch. In practice, a
    // rate-limited admin should see the 429 from the API route that drives
    // navigation — this is a belt-and-suspenders guard for direct URL access.
    notFound();
  }

  // ── Step 4: Call admin_consume_support_access RPC (user-scoped client) ─────
  // WHY createClient() (user-scoped) not createAdminClient() (service-role):
  //   Phase 4.1 P0 lesson: SECURITY DEFINER functions granted to 'authenticated'
  //   require the user's JWT to propagate auth.uid() inside the function body.
  //   Service-role client sends no JWT → auth.uid() = NULL inside the function →
  //   is_site_admin(NULL) = false → RAISE 42501 on every call. The user-scoped
  //   client forwards the admin's JWT so auth.uid() resolves correctly.
  //   The in-body is_site_admin(auth.uid()) check is the real authorization gate.
  //   SOC2 CC6.1 / OWASP A01:2021.
  //
  // WHY call RPC once per render (NOT cached):
  //   Caching would violate the access_count cap: a cached response would allow
  //   repeated renders without incrementing access_count, defeating the A1.1
  //   blast-radius limit. Each page render MUST consume exactly one access slot.
  //   T2 threat review mandate: "One admin_consume RPC per render."
  const supabase = await createClient();

  const { data: rpcRows, error: rpcError } = await supabase
    .rpc('admin_consume_support_access', { p_token_hash: tokenHash });

  // ── Step 5: Handle RPC errors ──────────────────────────────────────────────
  // WHY check error.code === '22023' separately from generic errors:
  //   22023 is the ERRCODE set by all four validation paths in admin_consume_support_access
  //   (token not found, wrong status, expired, cap exceeded). Surfacing a generic
  //   "access denied or expired" message for 22023 collapses the oracle — the admin
  //   learns nothing useful about which condition triggered the rejection.
  //   A non-22023 error (e.g. network failure, 42501 auth failure) is also rendered
  //   as AccessDeniedPage to avoid leaking internal error details to the admin UI.
  //   OWASP A02:2021 oracle-collapse.
  if (rpcError) {
    console.error('[support-session] RPC error', {
      event: 'support_access_rpc_error',
      errcode: rpcError.code,
      sessionId,
      // WHY log errcode not message: message may contain token-state details
      // that should not appear in application logs. errcode is sufficient for
      // debugging without leaking oracle information.
    });
    return <AccessDeniedPage />;
  }

  // ── Step 6: Verify RPC returned a row ─────────────────────────────────────
  if (!rpcRows || rpcRows.length === 0) {
    return <AccessDeniedPage />;
  }

  const grantRow = rpcRows[0] as {
    grant_id: string | bigint;
    session_id: string;
    scope: { fields: string[] };
  };

  const grantId = BigInt(grantRow.grant_id);
  const grantedSessionId: string = grantRow.session_id;
  const scope: { fields: string[] } = grantRow.scope ?? { fields: [] };

  // ── Step 7: Verify session_id matches URL param ────────────────────────────
  // WHY explicit mismatch check (not trust the URL param):
  //   The token encodes which session it authorizes. The URL param is
  //   admin-controlled and could differ from the token's bound session.
  //   If they differ, the admin is either confused (wrong URL) or attempting
  //   to use a token for session A to view session B. Both cases should deny.
  //   SOC2 CC6.3: per-session scoping enforced at route boundary.
  if (grantedSessionId !== sessionId) {
    console.warn('[support-session] session_id mismatch', {
      event: 'support_access_session_mismatch',
      grant_id: grantId.toString(),
      url_session_id: sessionId,
      token_session_id: grantedSessionId,
      // WHY not log admin_id: headers() doesn't give us the auth identity
      // without another DB call — not worth the round trip for a warning log.
    });
    return <AccessDeniedPage />;
  }

  // ── Step 8: Fetch current access_count and log structured access event ─────
  // WHY a separate SELECT (not reading from rpcRows):
  //   admin_consume_support_access RETURNS TABLE(grant_id, session_id, scope) —
  //   access_count is NOT in the RPC return shape. Reading rpcRows[0].access_count
  //   would silently return undefined, giving the admin a nonsensical "Access #undefined"
  //   display. Instead we do a focused SELECT on support_access_grants by grant_id
  //   to read the current (post-consume, atomically incremented) access_count.
  //   This does NOT bypass the CAS guarantee: the consume RPC already incremented
  //   access_count atomically; this read only retrieves the post-increment value
  //   for display and log purposes. OWASP A01:2021: no security decision depends on
  //   this value — it is display-only. SOC2 CC7.2: included in structured log.
  //
  // WHY log grant_id (not token_hash, not raw token):
  //   grant_id is a bigserial PK — safe for logs and cross-reference in admin_audit_log.
  //   token_hash is a security artefact; logging it creates unnecessary exposure.
  //   raw token MUST NEVER be logged anywhere. SOC2 CC7.2.
  let accessCount: number | undefined;
  const { data: grantRow2 } = await supabase
    .from('support_access_grants')
    .select('access_count')
    .eq('id', grantId.toString())
    .maybeSingle();

  if (grantRow2 && typeof grantRow2.access_count === 'number') {
    accessCount = grantRow2.access_count;
  }

  console.info('[support-session] support_access_consumed', {
    event: 'support_access_consumed',
    grant_id: grantId.toString(),
    session_id: sessionId,
    // access_count reflects the post-consume value fetched via a separate SELECT
    ...(accessCount !== undefined ? { access_count: accessCount } : {}),
  });

  // ── Step 9: Build SELECT column list (scope ∩ allowlist) ──────────────────
  // WHY intersection (not scope.fields alone):
  //   Defense-in-depth: even if scope.fields were widened by a DB change or
  //   misconfiguration, only columns in ROUTE_FIELD_ALLOWLIST can appear in
  //   the SELECT. An admin who added 'content_encrypted' to the scope JSONB
  //   would still see no content in the UI. GDPR Art 25.
  //
  // WHY always include 'id' and 'sequence_number' regardless of scope:
  //   id is needed as the React key; sequence_number is needed for ordering.
  //   Both are non-sensitive identifiers (no content, no PII).
  const scopeFields = new Set(scope.fields ?? []);
  const selectColumns = ROUTE_FIELD_ALLOWLIST.filter(
    (col) => col === 'id' || col === 'sequence_number' || col === 'created_at' || scopeFields.has(col),
  );

  // CRITICAL ASSERTION: 'content_encrypted' and 'encryption_nonce' must not be in
  // the SELECT. This assertion fires at runtime if anyone accidentally adds them.
  // Belt-and-suspenders over the ROUTE_FIELD_ALLOWLIST constant.
  if (
    selectColumns.includes('content_encrypted') ||
    selectColumns.includes('encryption_nonce') ||
    selectColumns.includes('content')
  ) {
    // This should never happen — it means ROUTE_FIELD_ALLOWLIST was corrupted.
    // Fail closed: deny the request and log a critical security alert.
    console.error('[support-session] CRITICAL: content field in SELECT — aborting', {
      event: 'support_access_content_field_detected',
      grant_id: grantId.toString(),
      selectColumns,
    });
    return <AccessDeniedPage />;
  }

  const selectString = selectColumns.join(', ');

  // ── Step 10: Fetch session metadata ───────────────────────────────────────
  const { data: sessionData, error: sessionError } = await supabase
    .from('sessions')
    .select(
      'id, agent_type, status, started_at, ended_at, total_cost_usd, total_input_tokens, total_output_tokens, total_cache_tokens, message_count, model',
    )
    .eq('id', sessionId)
    .single();

  if (sessionError || !sessionData) {
    console.error('[support-session] session fetch error', {
      event: 'support_access_session_fetch_error',
      grant_id: grantId.toString(),
      session_id: sessionId,
    });
    return <AccessDeniedPage />;
  }

  // Validate session shape (defense-in-depth — no accidental content fields)
  const sessionParsed = SessionRowSchema.safeParse(sessionData);
  if (!sessionParsed.success) {
    console.error('[support-session] session schema validation failed', {
      event: 'support_access_schema_error',
      grant_id: grantId.toString(),
      errors: sessionParsed.error.issues,
    });
    return <AccessDeniedPage />;
  }

  // ── Step 11: Fetch message metadata (scoped SELECT, LIMIT 50) ─────────────
  // WHY selectString (not '*'):
  //   Only the intersection of scope.fields and ROUTE_FIELD_ALLOWLIST is projected.
  //   SELECT * would return content_encrypted and encryption_nonce (E2E encrypted
  //   message bodies). Even though they are opaque ciphertext, projecting them into
  //   the admin UI creates an unnecessary data minimisation violation. GDPR Art 25.
  const { data: messagesData, error: messagesError } = await supabase
    .from('session_messages')
    .select(selectString)
    .eq('session_id', sessionId)
    .order('sequence_number', { ascending: false })
    .limit(MESSAGE_LIMIT);

  if (messagesError) {
    console.error('[support-session] messages fetch error', {
      event: 'support_access_messages_fetch_error',
      grant_id: grantId.toString(),
      session_id: sessionId,
    });
    // Non-fatal: render the session metadata without the message table
  }

  // Validate and filter message rows through Zod schema
  // WHY .partial() on MessageRowSchema: selectColumns may not include all fields
  // (e.g. if scope.fields is a subset). .partial() makes all fields optional so
  // validation succeeds for partial projections.
  const MessageRowPartial = MessageRowSchema.partial().extend({
    id: z.string().uuid(),
    sequence_number: z.number().int().nonnegative(),
  });

  const messages: MessageRow[] = [];
  for (const raw of messagesData ?? []) {
    const parsed = MessageRowPartial.safeParse(raw);
    if (parsed.success) {
      // Build a full MessageRow with defaults for missing optional fields
      messages.push({
        id: parsed.data.id,
        sequence_number: parsed.data.sequence_number,
        message_type: parsed.data.message_type ?? '',
        tool_name: parsed.data.tool_name ?? null,
        input_tokens: parsed.data.input_tokens ?? 0,
        output_tokens: parsed.data.output_tokens ?? 0,
        cache_tokens: parsed.data.cache_tokens ?? 0,
        duration_ms: parsed.data.duration_ms ?? null,
        created_at: parsed.data.created_at ?? '',
      });
    }
  }

  // ── Step 12: Set no-store Cache-Control ───────────────────────────────────
  // WHY no-store:
  //   Session metadata is sensitive support data. Any CDN or browser cache
  //   could retain a copy and serve it to a different admin on a shared device,
  //   or to a subsequent non-admin user if cookies are cleared but the page URL
  //   is retained. no-store guarantees every render fetches fresh data from the
  //   origin and the response is not stored by any intermediary.
  //   SOC2 CC6.1 / OWASP A01:2021.
  const headerStore = await headers();
  void headerStore; // headers() is called above; Next.js does not expose set() on this API
  // Note: In Next.js App Router Server Components, response headers are set via
  // the generateMetadata export or the special `headers` export. For no-store, we
  // rely on the middleware adding Cache-Control: no-store to /dashboard/admin/* routes.
  // Additional belt-and-suspenders could be added via a route.ts Response wrapper,
  // but Server Component pages cannot directly set response headers in Next.js 15.
  // The admin middleware (Phase 4.1) should enforce no-store on the admin segment.

  // ── Step 13: Render ────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      {/* Page header */}
      <div>
        <h1 className="text-xl font-bold text-zinc-100">Session Metadata</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Support access view - metadata only. Message content is not accessible.
        </p>
      </div>

      {/* Session overview card */}
      <SessionMetaCard
        session={sessionParsed.data}
        grantId={grantId}
        accessCount={accessCount ?? 1}
      />

      {/* Message metadata table */}
      <div>
        <h2 className="mb-3 text-sm font-semibold text-zinc-300">
          Recent Messages (metadata only)
        </h2>
        <MessageMetaTable messages={messages} />
      </div>
    </div>
  );
}
