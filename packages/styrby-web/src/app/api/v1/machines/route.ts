/**
 * /api/v1/machines
 *
 * GET  - Lists machines (CLI instances) for the authenticated user.
 * POST - Registers (or re-registers) a machine. Used by `styrby onboard`.
 *
 * @auth Required - API key via Authorization: Bearer styrby_xxx
 * @rateLimit 100 requests per minute per key
 *
 * GET Query Parameters:
 * - online_only: Filter to only online machines (default: false)
 *
 * GET @returns 200 {
 *   machines: Array<{ id, name, platform, platformVersion, architecture,
 *     hostname, cliVersion, isOnline, lastSeenAt, createdAt }>,
 *   count: number
 * }
 *
 * POST @body {
 *   machine_fingerprint: string (16-128),  // stable client-generated ID
 *   name: string (1-255),
 *   platform?: 'darwin'|'linux'|'win32',
 *   platform_version?: string (max 64),
 *   architecture?: 'arm64'|'x64'|'x86',
 *   hostname?: string (max 255),
 *   cli_version?: string (max 64)
 * }
 *
 * POST @returns 201 { machine_id, name, is_new: true,  created_at } - new
 *              200 { machine_id, name, is_new: false, created_at } - re-pair
 *
 * @security OWASP A01:2021 - user_id sourced from auth context only.
 * @security OWASP A03:2021 - Zod .strict() on POST body (mass-assignment).
 * @security OWASP A07:2021 - auth enforced by withApiAuthAndRateLimit.
 * @security SOC 2 CC6.1 - 'write' scope required for POST.
 * @security GDPR Art 6(1)(b) - lawful basis: contract performance.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { withApiAuthAndRateLimit, addRateLimitHeaders, type ApiAuthContext } from '@/middleware/api-auth';
import { createAdminClient } from '@/lib/supabase/server';
import { checkIdempotency, storeIdempotencyResult } from '@/lib/middleware/idempotency';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';

const ROUTE_ID = '/api/v1/machines';

// ---------------------------------------------------------------------------
// Query Schema
// ---------------------------------------------------------------------------

const QuerySchema = z.object({
  online_only: z.enum(['true', 'false']).default('false'),
});

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

  // Parse query parameters
  const url = new URL(request.url);
  const rawQuery = {
    online_only: url.searchParams.get('online_only') ?? undefined,
  };

  const parseResult = QuerySchema.safeParse(rawQuery);
  if (!parseResult.success) {
    return NextResponse.json(
      { error: parseResult.error.errors.map((e) => e.message).join(', ') },
      { status: 400 }
    );
  }

  const { online_only } = parseResult.data;
  const onlineOnly = online_only === 'true';

  const supabase = createApiAdminClient();

  // Build query
  let query = supabase
    .from('machines')
    .select(
      `
      id,
      name,
      platform,
      platform_version,
      architecture,
      hostname,
      cli_version,
      is_online,
      last_seen_at,
      created_at
    `
    )
    .eq('user_id', userId)
    .eq('is_enabled', true)
    .is('deleted_at', null);

  // Apply online filter
  if (onlineOnly) {
    query = query.eq('is_online', true);
  }

  // Order by last seen
  query = query.order('last_seen_at', { ascending: false, nullsFirst: false });

  const { data: machines, error } = await query;

  if (error) {
    console.error('Failed to fetch machines:', error.message);
    return NextResponse.json(
      { error: 'Failed to fetch machines' },
      { status: 500 }
    );
  }

  // Transform to camelCase for API response
  const transformedMachines = (machines || []).map((m) => ({
    id: m.id,
    name: m.name,
    platform: m.platform,
    platformVersion: m.platform_version,
    architecture: m.architecture,
    hostname: m.hostname,
    cliVersion: m.cli_version,
    isOnline: m.is_online,
    lastSeenAt: m.last_seen_at,
    createdAt: m.created_at,
  }));

  const response = NextResponse.json({
    machines: transformedMachines,
    count: transformedMachines.length,
  });

  return addRateLimitHeaders(response, keyId, keyExpiresAt);
}

export const GET = withApiAuthAndRateLimit(handler);

// ===========================================================================
// POST /api/v1/machines  —  register or re-register a CLI machine
// ===========================================================================

/** Min length of the client-generated machine_fingerprint. WHY 16: aligns with
 * a typical 128-bit ID hex-encoded; rejects accidental empty/short values. */
const MIN_FINGERPRINT_LENGTH = 16;
const MAX_FINGERPRINT_LENGTH = 128;
const MAX_NAME_LENGTH = 255;
const MAX_VERSION_LENGTH = 64;
const MAX_HOSTNAME_LENGTH = 255;

const MachineBodySchema = z
  .object({
    machine_fingerprint: z
      .string()
      .min(MIN_FINGERPRINT_LENGTH, `machine_fingerprint must be at least ${MIN_FINGERPRINT_LENGTH} characters`)
      .max(MAX_FINGERPRINT_LENGTH, `machine_fingerprint must be ${MAX_FINGERPRINT_LENGTH} characters or fewer`),
    name: z
      .string()
      .min(1, 'name is required')
      .max(MAX_NAME_LENGTH, `name must be ${MAX_NAME_LENGTH} characters or fewer`),
    platform: z.enum(['darwin', 'linux', 'win32']).optional(),
    platform_version: z.string().max(MAX_VERSION_LENGTH).optional(),
    architecture: z.enum(['arm64', 'x64', 'x86']).optional(),
    hostname: z.string().max(MAX_HOSTNAME_LENGTH).optional(),
    cli_version: z.string().max(MAX_VERSION_LENGTH).optional(),
  })
  .strict();

type MachineBody = z.infer<typeof MachineBodySchema>;

async function handlePost(request: NextRequest, authContext: ApiAuthContext): Promise<NextResponse> {
  const { userId } = authContext;

  // Idempotency check (opt-in via Idempotency-Key header).
  // The unique constraint (user_id, machine_fingerprint) makes upsert
  // inherently idempotent — but the 24h replay cache returns the *exact*
  // first response (including is_new=true) so retries don't see is_new flip.
  const idempotency = await checkIdempotency(request, userId, ROUTE_ID);
  if ('conflict' in idempotency) {
    return NextResponse.json({ error: idempotency.message }, { status: 409 });
  }
  if (idempotency.replayed) {
    const replay = NextResponse.json(idempotency.body, { status: idempotency.status });
    replay.headers.set('X-Idempotency-Replay', 'true');
    return replay;
  }

  let parsed: MachineBody;
  try {
    const raw = await request.json();
    const result = MachineBodySchema.safeParse(raw);
    if (!result.success) {
      const msg = result.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ');
      return NextResponse.json({ error: msg }, { status: 400 });
    }
    parsed = result.data;
  } catch {
    return NextResponse.json({ error: 'Request body must be valid JSON' }, { status: 400 });
  }

  const supabase = createAdminClient();

  // Pre-check: does a row exist for this (user_id, machine_fingerprint)?
  // WHY: distinguishes first registration (201, is_new=true) from re-pair
  // (200, is_new=false). supabase-js .upsert() doesn't expose this.
  // TOCTOU: a concurrent insert between SELECT and UPSERT would land on the
  // unique constraint and the UPSERT's ON CONFLICT path would update.
  // is_new could be advisory-only in that race; not worth a transaction.
  const { data: existing, error: existingErr } = await supabase
    .from('machines')
    .select('id')
    .eq('user_id', userId)
    .eq('machine_fingerprint', parsed.machine_fingerprint)
    .maybeSingle();

  if (existingErr) {
    Sentry.captureException(new Error(`machines pre-check error: ${existingErr.message}`), {
      extra: { route: ROUTE_ID },
    });
    return NextResponse.json({ error: 'Failed to register machine' }, { status: 500 });
  }

  const isNew = existing === null;

  const { data: row, error: upsertErr } = await supabase
    .from('machines')
    .upsert(
      {
        user_id: userId,
        machine_fingerprint: parsed.machine_fingerprint,
        name: parsed.name,
        platform: parsed.platform ?? null,
        platform_version: parsed.platform_version ?? null,
        architecture: parsed.architecture ?? null,
        hostname: parsed.hostname ?? null,
        cli_version: parsed.cli_version ?? null,
        is_online: true,
        last_seen_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,machine_fingerprint' },
    )
    .select('id, name, created_at')
    .single<{ id: string; name: string; created_at: string }>();

  if (upsertErr) {
    Sentry.captureException(new Error(`machines upsert error: ${upsertErr.message}`), {
      extra: { route: ROUTE_ID },
    });
    return NextResponse.json({ error: 'Failed to register machine' }, { status: 500 });
  }
  if (!row) {
    Sentry.captureMessage('Machines upsert returned no row', { level: 'error', tags: { endpoint: ROUTE_ID } });
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }

  const status = isNew ? 201 : 200;
  const responseBody = {
    machine_id: row.id,
    name: row.name,
    is_new: isNew,
    created_at: row.created_at,
  };

  await storeIdempotencyResult(request, userId, ROUTE_ID, status, responseBody);

  return NextResponse.json(responseBody, { status });
}

export const POST = withApiAuthAndRateLimit(handlePost, ['write']);
