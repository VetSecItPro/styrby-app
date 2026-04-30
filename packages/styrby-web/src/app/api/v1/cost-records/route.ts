/**
 * POST /api/v1/cost-records
 *
 * INSERT into `cost_records`. Used by the CLI daemon's cost reporter
 * (packages/styrby-cli/src/costs/cost-reporter.ts) to persist per-call token /
 * cost telemetry without requiring a project anon key. Strategy C / H41
 * Phase 4-step5 prereq.
 *
 * The body mirrors the columns the CLI writes through toSupabaseRecord +
 * toSupabaseRecordFromCostReport (see cost-reporter.ts SupabaseCostRecord).
 * `user_id` is server-stamped from the auth context (NEVER trusted from the
 * client) — OWASP A01:2021 mass-assignment defense.
 *
 * @auth Required - Bearer `styrby_*` API key via withApiAuthAndRateLimit
 * @rateLimit 100 requests per minute per key (default)
 * @idempotency Opt-in via Idempotency-Key header (24h replay window)
 *
 * @body {
 *   session_id: string,                    // Required - UUID; must belong to caller
 *   agent_type: string,                    // Required - matches agent_type enum
 *   model: string,                         // Required - human-readable model name
 *   input_tokens: number,                  // Required - >= 0
 *   output_tokens: number,                 // Required - >= 0
 *   cache_read_tokens?: number,            // Optional - >= 0, default 0
 *   cache_write_tokens?: number,           // Optional - >= 0, default 0
 *   cost_usd: number,                      // Required - >= 0, NUMERIC(10,6)
 *   price_per_input_token?: number | null, // Optional - NUMERIC(12,10)
 *   price_per_output_token?: number | null,
 *   recorded_at?: string,                  // Optional - ISO 8601, default NOW()
 *   record_date?: string,                  // Optional - YYYY-MM-DD, default CURRENT_DATE
 *   is_pending?: boolean,                  // Optional - default false (migration 013)
 *   billing_model?: string,                // Optional - migration 022 enum
 *   source?: string,                       // Optional - migration 022 enum
 *   raw_agent_payload?: object | null,     // Optional - SOC2 audit trail
 *   subscription_fraction_used?: number | null,
 *   credits_consumed?: number | null,
 *   credit_rate_usd?: number | null,
 * }
 *
 * @returns 201 { id, recorded_at }
 *
 * @error 400 { error }  - Zod validation failure (incl. unknown fields)
 * @error 401 { error }  - Missing or invalid API key
 * @error 404 { error }  - session_id not found OR belongs to another user (IDOR)
 * @error 409 { error }  - Idempotency-Key body mismatch
 * @error 429 { error }  - Rate limit exceeded
 * @error 500 { error }  - Unexpected database error (sanitized)
 *
 * @security OWASP A01:2021 - explicit (session.user_id == auth.userId) check;
 *   404 on cross-user lookups (no existence leak).
 * @security OWASP A03:2021 - Zod .strict() blocks unknown fields incl. user_id.
 *   user_id is ALWAYS server-stamped from auth context.
 * @security OWASP A07:2021 - auth via withApiAuthAndRateLimit.
 * @security SOC 2 CC6.1 - 'write' scope required.
 * @security SOC 2 CC7.2 - raw_agent_payload preserved as-supplied for audit trail.
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

const ROUTE_ID = '/api/v1/cost-records';

/**
 * Body schema. .strict() blocks unknown fields (e.g. injecting `user_id` to
 * write a record under another user). user_id is server-stamped — never read
 * from the body. OWASP A03:2021 + A01:2021.
 *
 * Bounds align with the cost_records column constraints:
 *  - input/output/cache tokens: CHECK (>= 0)
 *  - cost_usd: NUMERIC(10,6), CHECK (>= 0)
 *  - subscription_fraction_used: NUMERIC(5,4), 0..1 (migration 022)
 */
const CostRecordBodySchema = z
  .object({
    /**
     * Session this cost record belongs to. Must be a session owned by the
     * authenticated caller (verified server-side). UUID v4 format enforced
     * before reaching the DB so a malformed value gets a deterministic 400.
     */
    session_id: z.string().uuid('session_id must be a valid UUID'),

    /**
     * Agent type — matches the `agent_type` Postgres enum. WHY string (not
     * enum here): the enum values evolve as new agents are supported; the DB
     * is the source of truth. A bad value will surface a clean 400 from the
     * DB enum check; we don't duplicate the list here to avoid drift.
     */
    agent_type: z.string().min(1, 'agent_type is required').max(64),

    /**
     * Model name (e.g. 'claude-sonnet-4', 'gpt-4o'). max 255 covers any
     * reasonable provider naming convention.
     */
    model: z.string().min(1, 'model is required').max(255),

    input_tokens: z.number().int().min(0, 'input_tokens must be >= 0'),
    output_tokens: z.number().int().min(0, 'output_tokens must be >= 0'),
    cache_read_tokens: z.number().int().min(0).optional(),
    cache_write_tokens: z.number().int().min(0).optional(),

    /**
     * Cost in USD. NUMERIC(10,6) accepts up to 9999.999999. We allow 0 (some
     * cached requests have no marginal cost) but reject negatives. WHY no upper
     * bound: a runaway agent could legitimately spend > $100 on a single call.
     * The DB column max (9999.999999) is the upper guardrail.
     */
    cost_usd: z.number().min(0, 'cost_usd must be >= 0'),

    price_per_input_token: z.number().min(0).nullable().optional(),
    price_per_output_token: z.number().min(0).nullable().optional(),

    /**
     * ISO 8601 timestamp. WHY string (not z.date()): the CLI emits ISO strings;
     * Date coercion would mismatch on round-trip. Server defaults to NOW() if omitted.
     */
    recorded_at: z.string().datetime({ offset: true }).optional(),

    /**
     * YYYY-MM-DD string. WHY regex (not z.date()): record_date is a Postgres
     * DATE column; sending a full timestamp causes a silent truncation. Strict
     * pattern keeps callers honest and matches CURRENT_DATE on the DB side.
     */
    record_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'record_date must be YYYY-MM-DD')
      .optional(),

    is_pending: z.boolean().optional(),

    // Migration 022 columns. WHY string (not enum): same drift argument as
    // agent_type — the DB enum is the source of truth.
    billing_model: z.string().min(1).max(64).optional(),
    source: z.string().min(1).max(64).optional(),

    /**
     * SOC 2 CC7.2 audit trail. WHY z.record(z.unknown()): the agent payload
     * shape is provider-specific and intentionally opaque at this layer.
     * We only require it be a JSON object (not array, not primitive) so it
     * fits the JSONB column without surprise.
     */
    raw_agent_payload: z.record(z.unknown()).nullable().optional(),

    /** 0..1; matches NUMERIC(5,4) bounds in migration 022. */
    subscription_fraction_used: z.number().min(0).max(1).nullable().optional(),
    credits_consumed: z.number().int().min(0).nullable().optional(),
    credit_rate_usd: z.number().min(0).nullable().optional(),
  })
  .strict();

type CostRecordBody = z.infer<typeof CostRecordBodySchema>;

/**
 * Core POST handler for cost record insertion.
 *
 * Wrapped by withApiAuthAndRateLimit (write scope). Ownership is enforced at
 * the app layer because API-key auth has no auth.uid() context (RLS cannot run).
 *
 * Flow:
 *  1. Idempotency replay check (opt-in via Idempotency-Key header)
 *  2. Validate body via Zod .strict()
 *  3. Verify session_id exists AND belongs to authenticated user (404 IDOR)
 *  4. INSERT with user_id stamped from auth context (never from body)
 *  5. Cache the response for 24h replay
 *
 * @param request - Authenticated NextRequest
 * @param authContext - Auth context (userId, keyId, scopes) from the wrapper
 * @returns 201 with `{ id, recorded_at }`, or an appropriate error response
 *
 * @security OWASP A01:2021 - session ownership check + server-stamped user_id
 * @security OWASP A03:2021 - .strict() body, no mass-assignment
 * @security SOC 2 CC6.1 - write scope required
 * @security SOC 2 CC7.2 - raw_agent_payload preserved verbatim for audit
 */
async function handlePost(request: NextRequest, authContext: ApiAuthContext): Promise<NextResponse> {
  const { userId } = authContext;

  // 1. Idempotency replay (opt-in)
  const idempotency = await checkIdempotency(request, userId, ROUTE_ID);

  if ('conflict' in idempotency) {
    return NextResponse.json({ error: idempotency.message }, { status: 409 });
  }

  if (idempotency.replayed) {
    const replay = NextResponse.json(idempotency.body, { status: idempotency.status });
    replay.headers.set('X-Idempotency-Replay', 'true');
    return replay;
  }

  // 2. Parse + validate body
  let parsed: CostRecordBody;
  try {
    const raw = await request.json();
    const result = CostRecordBodySchema.safeParse(raw);
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

  // 3. Verify session ownership — IDOR defense (OWASP A01:2021)
  // 404 on missing AND on cross-user (consistent — caller cannot enumerate).
  const { data: sessionRow, error: sessionErr } = await supabase
    .from('sessions')
    .select('id')
    .eq('id', parsed.session_id)
    .eq('user_id', userId)
    .maybeSingle<{ id: string }>();

  if (sessionErr) {
    Sentry.captureException(new Error(`sessions fetch error: ${sessionErr.message}`), {
      extra: { route: ROUTE_ID, session_id: parsed.session_id },
    });
    return NextResponse.json({ error: 'Failed to record cost' }, { status: 500 });
  }

  if (!sessionRow) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // 4. INSERT with user_id stamped from auth context.
  // WHY explicit object (not parsed spread): the parsed body intentionally
  // omits user_id (mass-assignment guard). Building the insert payload here
  // makes the server-stamping audit-obvious. OWASP A01:2021.
  const insertPayload: Record<string, unknown> = {
    user_id: userId,
    session_id: parsed.session_id,
    agent_type: parsed.agent_type,
    model: parsed.model,
    input_tokens: parsed.input_tokens,
    output_tokens: parsed.output_tokens,
    cache_read_tokens: parsed.cache_read_tokens ?? 0,
    cache_write_tokens: parsed.cache_write_tokens ?? 0,
    cost_usd: parsed.cost_usd,
  };

  // Only set columns that were supplied — let Postgres apply column defaults
  // for everything else (avoids overwriting with explicit nulls).
  if (parsed.price_per_input_token !== undefined)
    insertPayload.price_per_input_token = parsed.price_per_input_token;
  if (parsed.price_per_output_token !== undefined)
    insertPayload.price_per_output_token = parsed.price_per_output_token;
  if (parsed.recorded_at !== undefined) insertPayload.recorded_at = parsed.recorded_at;
  if (parsed.record_date !== undefined) insertPayload.record_date = parsed.record_date;
  if (parsed.is_pending !== undefined) insertPayload.is_pending = parsed.is_pending;
  if (parsed.billing_model !== undefined) insertPayload.billing_model = parsed.billing_model;
  if (parsed.source !== undefined) insertPayload.source = parsed.source;
  if (parsed.raw_agent_payload !== undefined)
    insertPayload.raw_agent_payload = parsed.raw_agent_payload;
  if (parsed.subscription_fraction_used !== undefined)
    insertPayload.subscription_fraction_used = parsed.subscription_fraction_used;
  if (parsed.credits_consumed !== undefined) insertPayload.credits_consumed = parsed.credits_consumed;
  if (parsed.credit_rate_usd !== undefined) insertPayload.credit_rate_usd = parsed.credit_rate_usd;

  const { data: inserted, error: insertErr } = await supabase
    .from('cost_records')
    .insert(insertPayload)
    .select('id, recorded_at')
    .single<{ id: string; recorded_at: string }>();

  if (insertErr) {
    Sentry.captureException(new Error(`cost_records insert error: ${insertErr.message}`), {
      extra: { route: ROUTE_ID, session_id: parsed.session_id },
    });
    return NextResponse.json({ error: 'Failed to record cost' }, { status: 500 });
  }

  if (!inserted) {
    Sentry.captureMessage('cost_records INSERT returned no row', {
      level: 'error',
      tags: { endpoint: ROUTE_ID },
      extra: { session_id: parsed.session_id },
    });
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }

  const responseBody = { id: inserted.id, recorded_at: inserted.recorded_at };

  // 5. Cache for 24h replay
  await storeIdempotencyResult(request, userId, ROUTE_ID, 201, responseBody);

  return NextResponse.json(responseBody, { status: 201 });
}

/**
 * POST /api/v1/cost-records
 *
 * Required scopes: ['write'] — INSERT is a mutating operation.
 * Rate limit: default 100 req/min/key.
 */
export const POST = withApiAuthAndRateLimit(handlePost, ['write']);
