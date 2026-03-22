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
 *   status?: 'open' | 'in_progress' | 'resolved' | 'closed',
 *   page?: number (default 1),
 *   limit?: number (default 50, max 100)
 * }
 *
 * @returns 200 { tickets: Array, total: number }
 * @error 401 { error: 'Unauthorized' }
 * @error 403 { error: 'Forbidden' }
 * @error 500 { error: string }
 */

import { createClient, createAdminClient } from '@/lib/supabase/server';
import { isAdminEmail } from '@/lib/admin';
import { NextResponse } from 'next/server';

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

  // Verify admin access
  if (!isAdminEmail(user.email)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // Parse query params
  const url = new URL(request.url);
  const status = url.searchParams.get('status');
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '50', 10)));
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

  if (status && ['open', 'in_progress', 'resolved', 'closed'].includes(status)) {
    query = query.eq('status', status);
  }

  const { data: tickets, count, error } = await query;

  if (error) {
    console.error('[admin/support] Failed to fetch tickets:', error);
    return NextResponse.json({ error: 'Failed to fetch tickets' }, { status: 500 });
  }

  // Fetch user emails from auth.users via admin client
  // WHY: profiles table does not store emails; those live in auth.users.
  // We batch-fetch user data for all unique user_ids in the result set.
  const userIds = [...new Set((tickets || []).map((t: Record<string, unknown>) => t.user_id as string))];

  const userMap: Record<string, { email: string }> = {};

  for (const uid of userIds) {
    const { data: userData } = await adminClient.auth.admin.getUserById(uid);
    if (userData?.user) {
      userMap[uid] = { email: userData.user.email || '' };
    }
  }

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
