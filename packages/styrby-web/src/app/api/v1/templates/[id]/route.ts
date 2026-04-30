/**
 * /api/v1/templates/[id]  —  GET (fetch one) + PATCH (update) + DELETE
 *
 * Per-template operations bound to the authenticated user. The [id] segment
 * is the template UUID (matches context_templates.id). Ownership is enforced
 * server-side via WHERE user_id = auth context — RLS-equivalent at the app
 * layer because /api/v1 routes use the service-role client.
 *
 * @auth Required - Bearer `styrby_*` API key via withApiAuthAndRateLimit
 * @rateLimit 100 requests per minute per key (default)
 *
 * GET @returns 200 { template: TemplateRow } | 404 { error: 'Not found' }
 *
 * PATCH @body {
 *   name?: string,           // 1-255
 *   content?: string,        // 1-50000
 *   description?: string,    // max 1000, set to null to clear
 *   variables?: Variable[],
 *   is_default?: boolean
 * }
 * PATCH @returns 200 { template: TemplateRow } | 404 | 400
 *
 * DELETE @returns 200 { deleted: true, id }  |  404
 *
 * @error 401 { error }  - Missing or invalid API key
 * @error 404 { error }  - Template not found OR belongs to another user
 *                        (consistent 404 prevents IDOR enumeration)
 * @error 429 { error }  - Rate limit exceeded
 * @error 500 { error }  - Unexpected database error (sanitized)
 *
 * @security OWASP A01:2021 - 404 on cross-user lookup (no existence leak).
 * @security OWASP A03:2021 - PATCH body uses Zod .strict() (mass-assignment).
 * @security OWASP A07:2021 - auth enforced by withApiAuthAndRateLimit.
 * @security SOC 2 CC6.1 - 'read' for GET, 'write' for PATCH/DELETE.
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
// Constants — mirror /api/v1/templates POST handler (route.ts)
// ---------------------------------------------------------------------------

const ROUTE_ID = '/api/v1/templates/[id]';
const MAX_NAME_LENGTH = 255;
const MAX_CONTENT_LENGTH = 50_000;
const MAX_DESCRIPTION_LENGTH = 1_000;
const MAX_VARIABLE_FIELD_LENGTH = 255;
const MAX_VARIABLE_DEFAULT_LENGTH = 1_000;

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const VariableSchema = z
  .object({
    name: z.string().min(1, 'variable name must not be empty').max(MAX_VARIABLE_FIELD_LENGTH),
    description: z.string().max(MAX_VARIABLE_FIELD_LENGTH).optional(),
    defaultValue: z.string().max(MAX_VARIABLE_DEFAULT_LENGTH).optional(),
  })
  .strict();

/**
 * PATCH body — every field optional. WHY .strict(): even on PATCH, unknown
 * fields are mass-assignment vectors (e.g. injecting user_id, created_at).
 *
 * WHY description allows null (not just optional): empty description is a
 * legitimate state ("clear the description"); .nullable().optional() distinguishes
 * "leave alone" (omit) from "explicitly clear" (null). The handler treats both
 * the same in the UPDATE — but the API contract is honest about the difference.
 */
const PatchBodySchema = z
  .object({
    name: z.string().min(1).max(MAX_NAME_LENGTH).optional(),
    content: z.string().min(1).max(MAX_CONTENT_LENGTH).optional(),
    description: z.string().max(MAX_DESCRIPTION_LENGTH).nullable().optional(),
    variables: z.array(VariableSchema).optional(),
    is_default: z.boolean().optional(),
  })
  .strict()
  .refine(
    (data) => Object.keys(data).length > 0,
    { message: 'PATCH body must include at least one field to update' },
  );

type PatchBody = z.infer<typeof PatchBodySchema>;

// ---------------------------------------------------------------------------
// Row interface
// ---------------------------------------------------------------------------

interface TemplateRow {
  id: string;
  name: string;
  description: string | null;
  content: string;
  variables: unknown;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Helper — dynamic route param extractor
// ---------------------------------------------------------------------------

/**
 * Extract `id` from the URL pathname. WHY this manual extraction (not the
 * Next.js `{ params }` second arg): the withApiAuthAndRateLimit wrapper
 * doesn't pass route params through — only `(request, authContext)`. Parsing
 * the pathname keeps the wrapper signature stable across all routes.
 *
 * WHY validate as UUID: bare strings would happily reach the DB and produce
 * a cryptic "invalid input syntax for type uuid" 500. Failing fast at the
 * route boundary gives a clean 400 with a helpful message.
 */
function extractTemplateId(request: NextRequest): { ok: true; id: string } | { ok: false; error: string } {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  // Path: /api/v1/templates/[id]  →  segments = ['api','v1','templates','[id]']
  const id = segments[segments.length - 1];
  if (!id) return { ok: false, error: 'Missing template id' };
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(id)) return { ok: false, error: 'Invalid template id format' };
  return { ok: true, id };
}

// ===========================================================================
// GET handler
// ===========================================================================

async function handleGet(request: NextRequest, authContext: ApiAuthContext): Promise<NextResponse> {
  const { userId } = authContext;
  const idResult = extractTemplateId(request);
  if (!idResult.ok) return NextResponse.json({ error: idResult.error }, { status: 400 });

  const supabase = createAdminClient();
  const { data: row, error } = await supabase
    .from('context_templates')
    .select('id, name, description, content, variables, is_default, created_at, updated_at')
    .eq('id', idResult.id)
    .eq('user_id', userId)
    .maybeSingle<TemplateRow>();

  if (error) {
    Sentry.captureException(new Error(`context_templates fetch error: ${error.message}`), {
      extra: { route: ROUTE_ID },
    });
    return NextResponse.json({ error: 'Failed to fetch template' }, { status: 500 });
  }
  if (!row) {
    // WHY 404 (not 403) on cross-user: consistent IDOR defense — same response
    // as "not found". OWASP A01:2021. Don't reveal that the template exists.
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  return NextResponse.json({ template: row }, { headers: { 'Cache-Control': 'no-store' } });
}

// ===========================================================================
// PATCH handler
// ===========================================================================

async function handlePatch(request: NextRequest, authContext: ApiAuthContext): Promise<NextResponse> {
  const { userId } = authContext;
  const idResult = extractTemplateId(request);
  if (!idResult.ok) return NextResponse.json({ error: idResult.error }, { status: 400 });

  let parsed: PatchBody;
  try {
    const raw = await request.json();
    const result = PatchBodySchema.safeParse(raw);
    if (!result.success) {
      const msg = result.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ');
      return NextResponse.json({ error: msg }, { status: 400 });
    }
    parsed = result.data;
  } catch {
    return NextResponse.json({ error: 'Request body must be valid JSON' }, { status: 400 });
  }

  // Build update payload — only include fields the caller supplied. supabase-js
  // .update() with a sparse object emits an UPDATE that touches only those columns.
  // WHY explicit object construction (not spread): spread would forward Zod's
  // unknown-key errors silently. Explicit picks force compile-time discipline.
  const update: Partial<TemplateRow> = {};
  if (parsed.name !== undefined) update.name = parsed.name;
  if (parsed.content !== undefined) update.content = parsed.content;
  if (parsed.description !== undefined) update.description = parsed.description; // null clears
  if (parsed.variables !== undefined) update.variables = parsed.variables;
  if (parsed.is_default !== undefined) update.is_default = parsed.is_default;

  const supabase = createAdminClient();
  // WHY user_id in WHERE: cross-user UPDATEs would silently match 0 rows; we
  // make that explicit by filtering. Combined with the .single() expectation,
  // a missing match returns no row and we surface 404.
  const { data: row, error } = await supabase
    .from('context_templates')
    .update(update)
    .eq('id', idResult.id)
    .eq('user_id', userId)
    .select('id, name, description, content, variables, is_default, created_at, updated_at')
    .maybeSingle<TemplateRow>();

  if (error) {
    Sentry.captureException(new Error(`context_templates update error: ${error.message}`), {
      extra: { route: ROUTE_ID },
    });
    return NextResponse.json({ error: 'Failed to update template' }, { status: 500 });
  }
  if (!row) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  return NextResponse.json({ template: row });
}

// ===========================================================================
// DELETE handler
// ===========================================================================

async function handleDelete(request: NextRequest, authContext: ApiAuthContext): Promise<NextResponse> {
  const { userId } = authContext;
  const idResult = extractTemplateId(request);
  if (!idResult.ok) return NextResponse.json({ error: idResult.error }, { status: 400 });

  const supabase = createAdminClient();
  // WHY .select() after .delete(): supabase-js returns the deleted row when
  // .select() is chained, letting us distinguish "deleted" from "didn't exist".
  // A bare .delete() would succeed even if 0 rows matched, masking IDOR misses.
  const { data: row, error } = await supabase
    .from('context_templates')
    .delete()
    .eq('id', idResult.id)
    .eq('user_id', userId)
    .select('id')
    .maybeSingle<{ id: string }>();

  if (error) {
    Sentry.captureException(new Error(`context_templates delete error: ${error.message}`), {
      extra: { route: ROUTE_ID },
    });
    return NextResponse.json({ error: 'Failed to delete template' }, { status: 500 });
  }
  if (!row) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  return NextResponse.json({ deleted: true, id: row.id });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const GET = withApiAuthAndRateLimit(handleGet, ['read']);
export const PATCH = withApiAuthAndRateLimit(handlePatch, ['write']);
export const DELETE = withApiAuthAndRateLimit(handleDelete, ['write']);
