/**
 * Account Retention Policy API Route
 *
 * GET  /api/account/retention — Fetch the current user's retention policy
 * PUT  /api/account/retention — Update the current user's retention policy
 *
 * Manages the global "auto-delete sessions older than N days" setting stored
 * in profiles.retention_days. NULL means "never auto-delete" (default).
 *
 * @auth Required - Supabase Auth JWT via cookie (web) OR Bearer token in
 *   Authorization header (mobile).
 * @rateLimit 10 requests per minute (sensitive)
 *
 * PUT @body {
 *   retention_days: 7 | 30 | 90 | 365 | null   — null = never
 * }
 *
 * GET @returns 200 { retention_days: number | null }
 * PUT @returns 200 { success: true, retention_days: number | null }
 *
 * @error 400 { error: string } - Invalid retention_days value
 * @error 401 { error: 'Unauthorized' }
 * @error 429 { error: 'RATE_LIMITED', retryAfter: number }
 * @error 500 { error: string }
 */

import { createClient } from '@/lib/supabase/server';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { rateLimit, RATE_LIMITS, rateLimitResponse } from '@/lib/rateLimit';

/** Allowed retention window values. NULL means never delete. */
const ALLOWED_RETENTION_DAYS = [7, 30, 90, 365] as const;

/**
 * Zod schema for retention PUT request body.
 *
 * WHY nullable union: retention_days: null is a valid payload meaning
 * "clear my retention policy — never auto-delete". Without explicit null
 * support, users couldn't revert to "never delete" after setting a window.
 *
 * MASS-ASSIGN-SAFE: OWASP A04:2021 — only `retention_days` is accepted.
 * `.strict()` rejects unknown keys (e.g. `is_admin`, `tier`) at parse time,
 * returning 400 before any DB write occurs. The `.update()` call below writes
 * only `{ retention_days: parsed.data.retention_days }` — never raw user input.
 */
const RetentionUpdateSchema = z
  .object({
    retention_days: z.union([
      z.enum(['7', '30', '90', '365'] as unknown as [string, ...string[]]).transform(Number),
      z.literal(7),
      z.literal(30),
      z.literal(90),
      z.literal(365),
      z.null(),
    ]),
  })
  .strict(); // OWASP A04:2021 — reject unknown keys (mass-assignment guard)

/**
 * Resolve the Supabase client from cookie session or Bearer token.
 *
 * WHY duplicated from delete/route.ts: the helper is intentionally inlined
 * rather than extracted to a shared module so each route is independently
 * auditable. (SOC2 CC7.2 — reviewers can audit each route in isolation.)
 */
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
 * GET /api/account/retention
 *
 * Returns the current user's retention policy.
 */
export async function GET(request: Request) {
  const supabase = await resolveClient(request);
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('retention_days')
    .eq('id', user.id)
    .single();

  if (profileError) {
    return NextResponse.json({ error: 'Failed to fetch retention settings' }, { status: 500 });
  }

  return NextResponse.json({
    retention_days: profile?.retention_days ?? null,
  });
}

/**
 * PUT /api/account/retention
 *
 * Updates the current user's global session retention policy.
 * Writes an audit_log row before updating the profile so we have a record
 * even if the update partially fails.
 *
 * @param request - HTTP request with JSON body { retention_days: number | null }
 */
export async function PUT(request: Request) {
  const { allowed, retryAfter } = await rateLimit(request, RATE_LIMITS.sensitive, 'retention');
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

  const parsed = RetentionUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: `Invalid retention_days. Allowed values: ${ALLOWED_RETENTION_DAYS.join(', ')}, or null (never).`,
      },
      { status: 400 },
    );
  }

  const newRetentionDays = parsed.data.retention_days;

  // WHY audit BEFORE update: ensures compliance record exists even if the
  // profile UPDATE fails. The audit_log uses service_role so it always succeeds.
  // (GDPR Art. 5(2) — accountability; SOC2 CC7.2 — audit trail)
  await supabase.from('audit_log').insert({
    user_id: user.id,
    action: 'retention_changed',
    resource_type: 'profile_retention',
    ip_address: request.headers.get('x-forwarded-for') ?? null,
    user_agent: request.headers.get('user-agent') ?? null,
    metadata: {
      new_retention_days: newRetentionDays,
      retention_policy: newRetentionDays === null ? 'never_delete' : `delete_after_${newRetentionDays}_days`,
    },
  });

  const { error: updateError } = await supabase
    .from('profiles')
    .update({ retention_days: newRetentionDays })
    .eq('id', user.id);

  if (updateError) {
    return NextResponse.json({ error: 'Failed to update retention settings' }, { status: 500 });
  }

  return NextResponse.json({ success: true, retention_days: newRetentionDays });
}
