/**
 * POST /api/v1/templates
 *
 * INSERT into `context_templates`. Creates a new reusable project context
 * template for the authenticated user. Templates support variable placeholders
 * ({{variable_name}}) that get substituted at runtime by the CLI daemon.
 *
 * SPEC DEVIATION (verified against migration 002_context_templates.sql):
 * The original Strategy C spec declared body: { name, body, agent_type? }.
 * The actual table has different column names:
 *   - `body` → `content` (TEXT NOT NULL)
 *   - `agent_type` → does NOT exist in the schema
 *   - Additional optional fields: `description` (TEXT), `variables` (JSONB array), `is_default` (BOOLEAN)
 * This implementation uses the verified schema shape.
 *
 * WHY INSERT (not UPSERT): context_templates has no unique constraint on name.
 * Multiple templates with the same name are allowed. Conflict handling via
 * ON CONFLICT is therefore not applicable.
 *
 * @auth Required - Bearer `styrby_*` API key via withApiAuthAndRateLimit
 * @rateLimit 100 requests per minute per key (default)
 * @idempotency Opt-in via Idempotency-Key header (24h replay window)
 *
 * @body {
 *   name: string,          // Required - template name, 1-255 chars
 *   content: string,       // Required - template body with {{var}} placeholders, 1-50000 chars
 *   description?: string,  // Optional - human-readable description, max 1000 chars
 *   variables?: Array<{    // Optional - placeholder variable definitions
 *     name: string,        // Variable name (must match {{name}} in content)
 *     description?: string,
 *     defaultValue?: string
 *   }>,
 *   is_default?: boolean,  // Optional - auto-apply to new sessions (default false)
 * }
 *
 * @returns 201 { id, name, created_at }
 *
 * @error 400 { error: string }  - Zod validation failure (incl. unknown fields)
 * @error 401 { error: string }  - Missing or invalid API key
 * @error 409 { error: string }  - Idempotency-Key body mismatch
 * @error 429 { error: string }  - Rate limit exceeded
 * @error 500 { error: string }  - Unexpected database error (sanitized)
 *
 * @security OWASP A07:2021 (Identification and Authentication Failures) - auth
 *   enforced by withApiAuthAndRateLimit wrapper; user_id sourced from auth
 *   context, never from request body.
 * @security OWASP A03:2021 (Injection / Mass Assignment) - Zod .strict() guard
 *   rejects any fields not in the declared schema, including user_id injection.
 * @security GDPR Art 6(1)(a) - processing is lawful; user has consented to
 *   template creation via authenticated API key issuance.
 * @security SOC 2 CC6.1 (Logical Access Controls) - 'write' scope required;
 *   user_id always sourced from authenticated context (not body).
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
const ROUTE_ID = '/api/v1/templates';

/**
 * Maximum length for the `name` field (TEXT column in context_templates).
 * WHY 255: standard identifier max that prevents DB bloat while allowing
 * descriptive names. Enforced at API layer for clean 400 (not cryptic DB error).
 */
const MAX_NAME_LENGTH = 255;

/**
 * Maximum length for the `content` field (TEXT column in context_templates).
 * WHY 50_000: aligns with the pattern used across the CLI's context management.
 * Template content can be large (architectural docs, coding standards) but must
 * stay within token-budget constraints at injection time.
 */
const MAX_CONTENT_LENGTH = 50_000;

/**
 * Maximum length for the `description` field.
 * WHY 1_000: enough for a thorough description without unbounded storage.
 */
const MAX_DESCRIPTION_LENGTH = 1_000;

/**
 * Maximum length for a variable name or description within the variables array.
 * WHY 255: matches identifier conventions; variable names map to {{placeholders}}.
 */
const MAX_VARIABLE_FIELD_LENGTH = 255;

/**
 * Maximum length for a variable's defaultValue.
 * WHY 1_000: default values can be multi-line code snippets but must stay bounded.
 */
const MAX_VARIABLE_DEFAULT_LENGTH = 1_000;

// ---------------------------------------------------------------------------
// Zod Schema — OWASP A03:2021 mass-assignment guard
// ---------------------------------------------------------------------------

/**
 * Single variable definition within the `variables` array.
 *
 * WHY .strict(): rejects unknown nested fields injected alongside known ones.
 * Nested mass-assignment is as dangerous as top-level. OWASP A03:2021.
 */
const VariableSchema = z
  .object({
    /**
     * Variable name matching the {{variable_name}} placeholder in content.
     * WHY min(1): empty variable names are nonsensical and would silently write
     * an unusable placeholder definition to the DB. OWASP A03:2021.
     */
    name: z
      .string()
      .min(1, 'variable name must not be empty')
      .max(MAX_VARIABLE_FIELD_LENGTH, `variable name must be ${MAX_VARIABLE_FIELD_LENGTH} characters or fewer`),

    /**
     * Human-readable description of what the variable represents.
     * Optional — CLI prompts use this as help text when substituting values.
     */
    description: z
      .string()
      .max(MAX_VARIABLE_FIELD_LENGTH, `variable description must be ${MAX_VARIABLE_FIELD_LENGTH} characters or fewer`)
      .optional(),

    /**
     * Default value substituted when the user provides no input.
     * Optional — templates can be strictly required (no default) or have
     * a sensible default (e.g. language: "TypeScript").
     */
    defaultValue: z
      .string()
      .max(MAX_VARIABLE_DEFAULT_LENGTH, `variable defaultValue must be ${MAX_VARIABLE_DEFAULT_LENGTH} characters or fewer`)
      .optional(),
  })
  .strict(); // WHY .strict(): nested mass-assignment guard. OWASP A03:2021.

/**
 * Request body schema for POST /api/v1/templates.
 *
 * WHY .strict(): rejects any fields not listed in the schema. This prevents
 * mass-assignment attacks where a caller injects unexpected columns (e.g.
 * `user_id`, `created_at`) to tamper with the template record.
 * H42 Layer 3, OWASP A03:2021.
 *
 * SPEC DEVIATION: spec said { name, body, agent_type? }. Verified actual columns:
 * `content` (not `body`), `description` (not present in spec), `variables` JSONB,
 * `is_default` boolean. No `agent_type` column exists in context_templates.
 * (Migration 002_context_templates.sql, lines 29-57)
 */
const TemplateBodySchema = z
  .object({
    /**
     * Template display name.
     * WHY min(1).max(255): matches the DB CHECK constraint (name must not be empty).
     * The max cap prevents DB bloat and aligns with standard identifier conventions.
     */
    name: z
      .string()
      .min(1, 'name is required')
      .max(MAX_NAME_LENGTH, `name must be ${MAX_NAME_LENGTH} characters or fewer`),

    /**
     * Template body — the actual context injected into agent sessions.
     * May contain {{variable_name}} placeholders substituted at runtime.
     * WHY min(1).max(50_000): matches DB CHECK constraint (content must not be empty);
     * max aligns with context-window budget constraints.
     */
    content: z
      .string()
      .min(1, 'content is required')
      .max(MAX_CONTENT_LENGTH, `content must be ${MAX_CONTENT_LENGTH} characters or fewer`),

    /**
     * Human-readable description of the template's purpose.
     * Optional — shown in CLI and mobile template picker.
     */
    description: z
      .string()
      .max(MAX_DESCRIPTION_LENGTH, `description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer`)
      .optional(),

    /**
     * Variable placeholder definitions.
     * Optional — omitting defaults to an empty array (no variables).
     * Each element maps a placeholder name to its description and default value.
     */
    variables: z.array(VariableSchema).optional(),

    /**
     * Whether this template is automatically applied to new sessions.
     * Optional — defaults to false. The DB trigger ensures only one template
     * per user can be default (unsets any prior default on insert when true).
     */
    is_default: z.boolean().optional(),
  })
  .strict(); // rejects unknown fields — mass-assignment guard

type TemplateBody = z.infer<typeof TemplateBodySchema>;

// ---------------------------------------------------------------------------
// DB Row interface
// ---------------------------------------------------------------------------

/**
 * Shape of the row returned after the context_templates INSERT.
 * WHY explicit interface: TypeScript will catch schema drift at compile time
 * rather than surfacing a silent runtime mismatch. Matches the returning
 * columns selected in the insert query below.
 *
 * Only the fields required by the spec response are included: { id, name, created_at }.
 */
interface TemplateRow {
  /** Primary key of the template record (UUID). */
  id: string;
  /** Template display name. */
  name: string;
  /** ISO 8601 timestamp when this row was first created. */
  created_at: string;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Core POST handler for context template creation.
 *
 * Wrapped by withApiAuthAndRateLimit — never called directly. The wrapper
 * enforces:
 *  1. IP-based pre-auth rate limit (60 req/min/IP) — blocks unauthenticated floods
 *  2. Per-key rate limit (100 req/min/key default)
 *
 * Insert flow:
 *  1. Idempotency check (opt-in)
 *  2. Validate body via Zod .strict() — rejects unknown fields (mass-assignment)
 *  3. INSERT into context_templates with user_id from auth context (not body)
 *  4. Null guard on .single() return
 *  5. Cache result for idempotency replay
 *  6. Return 201 with { id, name, created_at }
 *
 * WHY no UPSERT: context_templates has no unique constraint on name.
 * Multiple templates with the same name are allowed per user. ON CONFLICT
 * has no applicable conflict target.
 *
 * @param request - Authenticated NextRequest
 * @param authContext - Auth context from withApiAuthAndRateLimit (userId, keyId, scopes)
 * @returns 201 with TemplateRow fields, or an appropriate error response
 *
 * @security OWASP A07:2021 - auth enforced by withApiAuthAndRateLimit
 * @security OWASP A03:2021 - mass-assignment blocked by Zod .strict() (top-level and nested)
 * @security SOC 2 CC6.1 - 'write' scope required; user_id from auth context only
 * @security GDPR Art 6(1)(a) - lawful basis: user consent via API key issuance
 */
export async function handlePost(request: NextRequest, authContext: ApiAuthContext): Promise<NextResponse> {
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
    // a fresh insert. Prevents duplicate template creation on retry.
    const replayResponse = NextResponse.json(idempotency.body, {
      status: idempotency.status,
    });
    replayResponse.headers.set('X-Idempotency-Replay', 'true');
    return replayResponse;
  }

  // -------------------------------------------------------------------------
  // Step 2: Parse + validate request body
  // WHY Zod .strict(): rejects any fields not in the schema, blocking
  // mass-assignment attempts (e.g. injecting user_id, created_at).
  // OWASP A03:2021, H42 Layer 3.
  // -------------------------------------------------------------------------
  let parsedBody: TemplateBody;

  try {
    const rawBody = await request.json();
    const parseResult = TemplateBodySchema.safeParse(rawBody);

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

  const { name, content, description, variables, is_default } = parsedBody;

  // -------------------------------------------------------------------------
  // Step 3: INSERT into context_templates
  // WHY createAdminClient() per-request: the function reads env vars on each
  // invocation, so a single module-level instance would cache stale config
  // during local dev hot-reload. The per-call overhead is ~1 ms; not a hot path.
  // WHY user_id from auth context (not body): .strict() prevents injection via
  // the body, but explicit sourcing from authContext is the definitive guard.
  // OWASP A07:2021, SOC 2 CC6.1.
  // -------------------------------------------------------------------------
  const supabase = createAdminClient();

  const { data: insertedRow, error: insertError } = await supabase
    .from('context_templates')
    .insert({
      // WHY user_id from auth context: prevents user_id spoofing even if Zod
      // strict were somehow bypassed. The authenticated identity is ground truth.
      // OWASP A01:2021, SOC 2 CC6.1.
      user_id: userId,
      name,
      content,
      description: description ?? null,
      variables: variables ?? [],
      is_default: is_default ?? false,
    })
    .select('id, name, created_at')
    .single<TemplateRow>();

  if (insertError) {
    // WHY Sentry: unexpected DB errors need alerting. We do NOT surface the raw
    // error to the caller — it may contain PII or internal schema details.
    // OWASP A02:2021.
    Sentry.captureException(
      new Error(`context_templates insert error: ${insertError.message}`),
      {
        extra: {
          // WHY only route: avoids leaking user_id or template name in Sentry
          // breadcrumbs. PII hygiene (OWASP A02:2021).
          route: ROUTE_ID,
        },
      },
    );
    return NextResponse.json({ error: 'Failed to create template' }, { status: 500 });
  }

  // -------------------------------------------------------------------------
  // Step 4: Null guard on .single() return
  // WHY: insert succeeded (no error) but .single() returned null — this is an
  // unexpected DB state (e.g. RETURNING clause suppressed by RLS on the service
  // role — should never happen, but TypeScript types this as nullable).
  // Catching it here prevents a downstream TypeError on insertedRow.id access.
  // -------------------------------------------------------------------------
  if (!insertedRow) {
    Sentry.captureMessage('Insert succeeded but returned no row', {
      level: 'error',
      tags: { endpoint: ROUTE_ID },
    });
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }

  // -------------------------------------------------------------------------
  // Step 5: Cache the successful response for idempotency replay
  // WHY after the insert: we store the committed row's fields so that any
  // replay returns the exact same row identifier, not a duplicate insert.
  // -------------------------------------------------------------------------
  const responseBody: TemplateRow = {
    id: insertedRow.id,
    name: insertedRow.name,
    created_at: insertedRow.created_at,
  };

  await storeIdempotencyResult(request, userId, ROUTE_ID, 201, responseBody);

  return NextResponse.json(responseBody, { status: 201 });
}

// ---------------------------------------------------------------------------
// Export — wrapped with auth + default rate limit
// ---------------------------------------------------------------------------

/**
 * POST /api/v1/templates
 *
 * Required scopes: ['write'] — INSERT is a mutating operation.
 * Rate limit: default 100 req/min/key.
 *
 * WHY 'write' scope: prevents read-only API keys (e.g. dashboard integrations)
 * from creating template records. SOC 2 CC6.1 (least-privilege access).
 */
export const POST = withApiAuthAndRateLimit(handlePost, ['write']);
