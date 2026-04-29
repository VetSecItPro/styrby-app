/**
 * POST /api/v1/audit
 *
 * High-volume audit log ingestion endpoint. Used by 7 of 11 CLI callsites
 * that write security and operational events to the `audit_log` table.
 *
 * @auth Required - Bearer `styrby_*` API key via withApiAuthAndRateLimit
 * @rateLimit 1000 requests per minute per key (high — audit_log is high-volume)
 * @idempotency Opt-in via Idempotency-Key header (24h replay window)
 *
 * @body {
 *   action: string,            // Required — event name (e.g. "session.started")
 *   resource_type?: string,    // Optional — entity type (e.g. "session")
 *   resource_id?: string,      // Optional — entity UUID
 *   metadata?: Record<string, unknown>  // Optional — structured context
 * }
 *
 * @returns 201 { id: string, created_at: string }
 *
 * @error 400 { error: string }  — Zod validation failure (incl. unknown fields)
 * @error 401 { error: string }  — Missing or invalid API key
 * @error 409 { error: string }  — Idempotency-Key body mismatch
 * @error 429 { error: string }  — Rate limit exceeded
 * @error 500 { error: string }  — Unexpected database error (sanitized)
 *
 * @security OWASP A07:2021 (Identification and Authentication Failures)
 * @security OWASP A03:2021 (Injection / Mass Assignment — Zod .strict() guard)
 * @security SOC 2 CC7.2 (System Monitoring — audit log integrity)
 * @security SOC 2 CC6.1 (Logical Access Controls)
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
const ROUTE_ID = '/api/v1/audit';

/**
 * Rate limit override for this route.
 * WHY 1000 req/min: audit_log is high-volume — every CLI action, every agent
 * message, every reconnect fires an audit event. The default 100 req/min
 * would throttle normal CLI usage. The middleware default is still applied
 * (IP-based pre-auth 60 req/min + per-key 100 req/min from authenticateApiRequest).
 * This override relaxes the per-route secondary check to 1000 req/min/key.
 */
const AUDIT_RATE_LIMIT = {
  windowMs: 60_000,
  maxRequests: 1_000,
};

// ---------------------------------------------------------------------------
// Zod Schema — H42 Layer 3 mass-assignment guard
// ---------------------------------------------------------------------------

/**
 * Request body schema for POST /api/v1/audit.
 *
 * WHY .strict(): rejects any fields not listed in the schema. This prevents
 * mass-assignment attacks where a caller injects unexpected columns (e.g.
 * `user_id`, `created_at`) to spoof the audit trail or poison the table.
 * H42 Layer 3, OWASP A03:2021.
 */
const AuditBodySchema = z
  .object({
    /**
     * Dot-namespaced event name. Examples: "session.started", "agent.connected",
     * "user.login". CLI callsites define these; the API stores them verbatim.
     */
    action: z.string().min(1, 'action is required').max(255, 'action must be 255 characters or fewer'),

    /**
     * Entity type that the event relates to. Examples: "session", "machine", "user".
     * Omit when the event is not associated with a specific entity.
     * WHY .max(100): mirrors typical table-name length limits; prevents oversized INSERTs.
     */
    resource_type: z.string().max(100, 'resource_type must be 100 characters or fewer').optional(),

    /**
     * UUID of the specific entity. Paired with resource_type to form a
     * (type, id) reference for the entity that the event acted on.
     * WHY .max(255): guards against unbounded string IDs reaching the DB.
     */
    resource_id: z.string().max(255, 'resource_id must be 255 characters or fewer').optional(),

    /**
     * Arbitrary structured metadata. Stored as JSONB in Postgres.
     * CLI callsites use this for context such as agent_type, project_path,
     * reconnect reason, or cost data. No schema enforcement beyond "is an object".
     */
    metadata: z.record(z.unknown()).optional(),
  })
  .strict(); // rejects unknown fields — mass-assignment guard

type AuditBody = z.infer<typeof AuditBodySchema>;

// ---------------------------------------------------------------------------
// DB Row interface
// ---------------------------------------------------------------------------

/**
 * Shape of the row returned by the audit_log INSERT ... RETURNING.
 * WHY explicit interface (not inline cast): TypeScript will complain here if the
 * DB schema evolves and the columns change, giving us a compile-time contract
 * rather than a silent runtime surprise. IMPORTANT-2 fix.
 */
interface AuditRow {
  id: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Core POST handler for audit log ingestion.
 *
 * Wrapped by withApiAuthAndRateLimit — never called directly. The wrapper
 * enforces:
 *  1. IP-based pre-auth rate limit (60 req/min/IP) — blocks unauthenticated floods
 *  2. Per-key rate limit (100 req/min/key default from authenticateApiRequest)
 *  3. This route's per-route override (1000 req/min/key via AUDIT_RATE_LIMIT)
 *
 * @param request - Authenticated NextRequest
 * @param context - Auth context from withApiAuthAndRateLimit (userId, keyId, scopes)
 * @returns 201 with { id, created_at }, or an appropriate error response
 *
 * @security OWASP A07:2021 — auth enforced by withApiAuthAndRateLimit
 * @security OWASP A03:2021 — mass-assignment blocked by Zod .strict()
 * @security SOC 2 CC7.2 — writes to audit_log via service-role client (RLS bypassed)
 */
async function handlePost(request: NextRequest, context: ApiAuthContext): Promise<NextResponse> {
  const { userId } = context;

  // -------------------------------------------------------------------------
  // Step 1: Idempotency check (opt-in via Idempotency-Key header)
  // WHY before body parsing: the idempotency middleware reads the raw body
  // internally (via request.clone()) and returns the cached response if one
  // exists, so we short-circuit before any business logic or DB writes.
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
    // a fresh insert. CLI clients can avoid double-counting on their side.
    const replayResponse = NextResponse.json(idempotency.body, {
      status: idempotency.status,
    });
    replayResponse.headers.set('X-Idempotency-Replay', 'true');
    return replayResponse;
  }

  // -------------------------------------------------------------------------
  // Step 2: Parse + validate request body
  // WHY Zod .strict() here (not schema-level): the schema is already defined
  // with .strict(); this parse call enforces it and surfaces field-level errors.
  // -------------------------------------------------------------------------
  let parsedBody: AuditBody;

  try {
    const rawBody = await request.json();
    const parseResult = AuditBodySchema.safeParse(rawBody);

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

  const { action, resource_type, resource_id, metadata } = parsedBody;

  // -------------------------------------------------------------------------
  // Step 3: Insert into audit_log via service-role client (bypasses RLS)
  // WHY service-role (createAdminClient): The auth_uid() function returns null
  // for API-key-authenticated requests because we are not using Supabase JWT
  // sessions. RLS policies that reference auth.uid() would reject the insert.
  // We trust the user_id from the validated API key context (not from the body).
  // SOC 2 CC7.2.
  // -------------------------------------------------------------------------
  const supabase = createAdminClient();

  const { data: insertedRow, error: insertError } = await supabase
    .from('audit_log')
    .insert({
      user_id: userId,     // from API key context — never from request body
      action,
      resource_type: resource_type ?? null,
      resource_id: resource_id ?? null,
      metadata: metadata ?? null,
      created_at: new Date().toISOString(),
    })
    .select('id, created_at')
    .single();

  if (insertError) {
    // WHY Sentry: unexpected DB errors (deadlocks, schema drift, connectivity)
    // need alerting. We do NOT surface the raw error to the caller — it may
    // contain PII or internal schema details (OWASP A02:2021).
    Sentry.captureException(new Error(`audit_log insert error: ${insertError.message}`), {
      extra: {
        // WHY only action + resource_type: these are the lowest-PII fields.
        // We deliberately exclude metadata and resource_id from the Sentry context.
        action,
        resource_type: resource_type ?? null,
        // Strip any URL-like fields to avoid PII leakage via Sentry breadcrumbs.
        route: ROUTE_ID,
      },
    });

    return NextResponse.json({ error: 'Failed to write audit event' }, { status: 500 });
  }

  // -------------------------------------------------------------------------
  // Step 4: Cache the successful response for idempotency replay
  // WHY after the insert: we store the committed row's id + created_at so that
  // any replay returns the exact same row identifier, not a newly generated one.
  // -------------------------------------------------------------------------
  const responseBody: AuditRow = {
    id: (insertedRow as AuditRow).id,
    created_at: (insertedRow as AuditRow).created_at,
  };

  await storeIdempotencyResult(request, userId, ROUTE_ID, 201, responseBody);

  return NextResponse.json(responseBody, { status: 201 });
}

// ---------------------------------------------------------------------------
// Export — wrapped with auth + rate limit override
// ---------------------------------------------------------------------------

/**
 * POST /api/v1/audit
 *
 * Rate limit override: 1000 req/min/key (high-volume audit endpoint).
 * Required scopes: ['write'] — audit writes require the write scope.
 *
 * WHY 'write' scope: the audit log is append-only and idempotent, but it is
 * still a mutating operation. Requiring 'write' scope prevents read-only
 * API keys (e.g. dashboard integrations) from accidentally writing audit
 * events. SOC 2 CC6.1 (least-privilege access).
 */
export const POST = withApiAuthAndRateLimit(handlePost, ['write'], {
  rateLimit: AUDIT_RATE_LIMIT,
});
