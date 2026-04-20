/**
 * Admin Support Tickets API
 *
 * GET /api/admin/support
 *
 * Lists all support tickets with user info for admin management.
 * Requires the requesting user to be in the admin allowlist.
 *
 * @auth Required - Supabase Auth JWT via cookie (admin only)
 *
 * @query {
 *   status?: 'open' | 'in_progress' | 'resolved' | 'closed',  // validated via Zod enum
 *   page?: number (default 1, min 1),                          // validated via Zod int min(1)
 *   limit?: number (default 50, max 100)                       // validated via Zod int 1-100
 * }
 *
 * Validation: OWASP ASVS V5.1.3 — all inputs validated against an allowlist schema
 * before use. Query params are coerced from strings and rejected with 400 on failure.
 *
 * @returns 200 { tickets: Array, total: number }
 * @error 400 { error: string }  // Zod parse failure
 * @error 401 { error: 'Unauthorized' }
 * @error 403 { error: 'Forbidden' }
 * @error 500 { error: string }
 */

import { createClient, createAdminClient } from '@/lib/supabase/server';
import { isAdmin } from '@/lib/admin';
import { rateLimit, RATE_LIMITS, rateLimitResponse } from '@/lib/rateLimit';
import { NextResponse } from 'next/server';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Query Schema
// ---------------------------------------------------------------------------

// WHY: Manual parseInt/clamp was not rejecting non-numeric strings — they
// silently coerced to NaN and fell back to defaults, allowing callers to
// supply arbitrary garbage that could confuse downstream query logic.
// Replacing with Zod z.coerce ensures type-safe, allowlist-validated params
// per OWASP ASVS V5.1.3 (Input Validation) and SOC2 CC7.2 (System Monitoring —
// inputs to admin endpoints must be fully validated before processing).
const QuerySchema = z.object({
  status: z.enum(['open', 'in_progress', 'resolved', 'closed']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export async function GET(request: Request) {
  // Verify the requesting user is authenticated
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Rate limit check (A-008)
  const { allowed, retryAfter } = await rateLimit(request, RATE_LIMITS.standard, 'admin-support');
  if (!allowed) return rateLimitResponse(retryAfter!);

  // Verify admin access via profiles.is_admin (A-001)
  if (!(await isAdmin(user.id))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // Parse and validate query params via Zod schema (OWASP ASVS V5.1.3)
  const url = new URL(request.url);
  const rawQuery = {
    status: url.searchParams.get('status') ?? undefined,
    page: url.searchParams.get('page') ?? undefined,
    limit: url.searchParams.get('limit') ?? undefined,
  };

  const parseResult = QuerySchema.safeParse(rawQuery);
  if (!parseResult.success) {
    return NextResponse.json(
      { error: parseResult.error.errors.map((e) => e.message).join(', ') },
      { status: 400 }
    );
  }

  const { status, page, limit } = parseResult.data;
  const offset = (page - 1) * limit;

  // Use admin client to bypass RLS and access all tickets
  const adminClient = createAdminClient();

  // Build the query
  let query = adminClient
    .from('support_tickets')
    .select(
      `
      *,
      profiles!support_tickets_user_id_fkey(
        display_name,
        avatar_url
      )
    `,
      { count: 'exact' }
    )
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  // status is already validated as a valid enum value by QuerySchema above
  if (status) {
    query = query.eq('status', status);
  }

  const { data: tickets, count, error } = await query;

  if (error) {
    // A-009: Avoid logging raw Supabase error objects in production
    console.error('[admin/support] Failed to fetch tickets:', error instanceof Error ? error.message : String(error));
    return NextResponse.json({ error: 'Failed to fetch tickets' }, { status: 500 });
  }

  // Fetch user emails from auth.users via admin client
  // WHY: profiles table does not store emails; those live in auth.users.
  // We batch-fetch user data for all unique user_ids in the result set.
  const userIds = [...new Set((tickets || []).map((t: Record<string, unknown>) => t.user_id as string))];

  // A-005: Parallel fetch instead of sequential N+1 loop
  const userMap: Record<string, { email: string }> = {};

  const userFetches = await Promise.all(
    userIds.map((uid) => adminClient.auth.admin.getUserById(uid))
  );
  userFetches.forEach(({ data: userData }) => {
    if (userData?.user) {
      userMap[userData.user.id] = { email: userData.user.email || '' };
    }
  });

  // Enrich tickets with user email
  const enrichedTickets = (tickets || []).map((ticket: Record<string, unknown>) => ({
    ...ticket,
    user_email: userMap[ticket.user_id as string]?.email || 'Unknown',
  }));

  return NextResponse.json({
    tickets: enrichedTickets,
    total: count || 0,
  });
}
