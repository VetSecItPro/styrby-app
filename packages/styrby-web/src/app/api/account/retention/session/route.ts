/**
 * Per-Session Retention Override API Route
 *
 * PUT /api/account/retention/session
 *
 * Updates the retention_override for a specific session. Power users can
 * pin a session to never-delete or set a shorter-than-default window.
 *
 * @auth Required - Supabase Auth JWT via cookie (web) OR Bearer token
 * @rateLimit 10 requests per minute (sensitive)
 *
 * @body {
 *   session_id: string (UUID),
 *   retention_override: 'inherit' | 'pin_forever' | 'pin_days:7' | 'pin_days:30' | 'pin_days:90' | 'pin_days:365'
 * }
 *
 * @returns 200 { success: true, session_id: string, retention_override: string }
 *
 * @error 400 { error: string } - Invalid input
 * @error 401 { error: 'Unauthorized' }
 * @error 403 { error: 'Forbidden' } - Session belongs to another user
 * @error 404 { error: 'Session not found' }
 * @error 429 { error: 'RATE_LIMITED', retryAfter: number }
 * @error 500 { error: string }
 */

import { createClient } from '@/lib/supabase/server';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { rateLimit, RATE_LIMITS, rateLimitResponse } from '@/lib/rateLimit';

/**
 * Allowed retention_override values.
 *
 * WHY regex not enum: avoids creating a new Postgres enum type for a value
 * that is already validated by CHECK constraint in migration 025.
 */
const VALID_OVERRIDE_PATTERN = /^(inherit|pin_forever|pin_days:(7|30|90|365))$/;

// MASS-ASSIGN-SAFE: OWASP A04:2021 — only `session_id` and `retention_override`
// are accepted. `.strict()` rejects unknown keys (e.g. `user_id`, `is_admin`)
// at parse time, returning 400 before any DB write occurs. The `.update()` call
// below writes only `{ retention_override }` extracted from `parsed.data`.
const SessionRetentionSchema = z
  .object({
    session_id: z.string().uuid('session_id must be a valid UUID'),
    retention_override: z.string().regex(
      VALID_OVERRIDE_PATTERN,
      'retention_override must be: inherit, pin_forever, pin_days:7, pin_days:30, pin_days:90, or pin_days:365',
    ),
  })
  .strict(); // OWASP A04:2021 — reject unknown keys (mass-assignment guard)

async function resolveClient(request: Request) {
  const authHeader = request.headers.get('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    return createSupabaseClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { global: { headers: { Authorization: `Bearer ${token}` } } },
    );
  }
  return createClient();
}

/**
 * PUT /api/account/retention/session
 *
 * Sets a per-session retention override. RLS on the sessions table ensures
 * the user can only update sessions they own.
 *
 * WHY we verify session ownership explicitly before updating:
 *   Without the ownership check, a user could attempt to update any session ID
 *   and receive a "not found" or "no rows affected" response — which leaks that
 *   the session ID exists. The explicit SELECT + UPDATE with user_id filter
 *   prevents oracle-style session enumeration. (OWASP A01:2021)
 */
export async function PUT(request: Request) {
  const { allowed, retryAfter } = await rateLimit(request, RATE_LIMITS.sensitive, 'session-retention');
  if (!allowed) return rateLimitResponse(retryAfter!);

  const supabase = await resolveClient(request);
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = SessionRetentionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.errors[0]?.message ?? 'Invalid input' },
      { status: 400 },
    );
  }

  const { session_id, retention_override } = parsed.data;

  // Verify the session exists AND belongs to this user
  // WHY: RLS already blocks cross-user access at the DB level, but an explicit
  // ownership check here produces a meaningful 403/404 vs a silent no-op.
  const { data: session, error: fetchError } = await supabase
    .from('sessions')
    .select('id, user_id')
    .eq('id', session_id)
    .eq('user_id', user.id)
    .is('deleted_at', null)
    .single();

  if (fetchError || !session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  // WHY audit BEFORE update (same rationale as retention/route.ts)
  await supabase.from('audit_log').insert({
    user_id: user.id,
    action: 'retention_changed',
    resource_type: 'session_retention',
    resource_id: session_id,
    ip_address: request.headers.get('x-forwarded-for') ?? null,
    user_agent: request.headers.get('user-agent') ?? null,
    metadata: {
      session_id,
      new_retention_override: retention_override,
    },
  });

  const { error: updateError } = await supabase
    .from('sessions')
    .update({ retention_override })
    .eq('id', session_id)
    .eq('user_id', user.id);

  if (updateError) {
    return NextResponse.json({ error: 'Failed to update session retention' }, { status: 500 });
  }

  return NextResponse.json({ success: true, session_id, retention_override });
}
