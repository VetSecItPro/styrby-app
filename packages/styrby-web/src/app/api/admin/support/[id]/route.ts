/**
 * Admin Single Support Ticket API
 *
 * GET /api/admin/support/[id] - Fetch ticket with replies and user info
 * PATCH /api/admin/support/[id] - Update ticket status or admin notes
 *
 * @auth Required - Supabase Auth JWT via cookie (admin only)
 *
 * GET @returns 200 { ticket, replies, user }
 * PATCH @body { status?: string, admin_notes?: string }
 * PATCH @returns 200 { ticket }
 *
 * @error 401 { error: 'Unauthorized' }
 * @error 403 { error: 'Forbidden' }
 * @error 404 { error: 'Ticket not found' }
 * @error 500 { error: string }
 */

import { createClient, createAdminClient } from '@/lib/supabase/server';
import { isAdminEmail } from '@/lib/admin';
import { NextResponse } from 'next/server';
import { z } from 'zod';

/**
 * Zod schema for PATCH request body validation.
 * Both fields are optional so admins can update one at a time.
 */
const PatchSchema = z.object({
  status: z.enum(['open', 'in_progress', 'resolved', 'closed']).optional(),
  admin_notes: z.string().max(10000).optional(),
});

/**
 * Verifies the request comes from an authenticated admin user.
 *
 * @returns The authenticated user, or a NextResponse error
 */
async function verifyAdmin() {
  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }

  if (!isAdminEmail(user.email)) {
    return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }

  return { user };
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const result = await verifyAdmin();
  if ('error' in result && result.error) return result.error;

  const adminClient = createAdminClient();

  // Fetch ticket
  const { data: ticket, error: ticketError } = await adminClient
    .from('support_tickets')
    .select('*')
    .eq('id', id)
    .single();

  if (ticketError || !ticket) {
    return NextResponse.json({ error: 'Ticket not found' }, { status: 404 });
  }

  // Fetch replies
  const { data: replies } = await adminClient
    .from('support_ticket_replies')
    .select('*')
    .eq('ticket_id', id)
    .order('created_at', { ascending: true });

  // Fetch user info
  const { data: userData } = await adminClient.auth.admin.getUserById(ticket.user_id);
  const { data: profile } = await adminClient
    .from('profiles')
    .select('display_name, avatar_url, created_at')
    .eq('id', ticket.user_id)
    .single();

  // Fetch subscription info
  const { data: subscription } = await adminClient
    .from('subscriptions')
    .select('tier, status')
    .eq('user_id', ticket.user_id)
    .single();

  // Fetch machine count
  const { count: machineCount } = await adminClient
    .from('machines')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', ticket.user_id);

  return NextResponse.json({
    ticket,
    replies: replies || [],
    user: {
      id: ticket.user_id,
      email: userData?.user?.email || 'Unknown',
      display_name: profile?.display_name || null,
      avatar_url: profile?.avatar_url || null,
      joined_at: profile?.created_at || null,
      tier: subscription?.tier || 'free',
      subscription_status: subscription?.status || null,
      machines_count: machineCount || 0,
    },
  });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const result = await verifyAdmin();
  if ('error' in result && result.error) return result.error;

  // Parse and validate body
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const validation = PatchSchema.safeParse(body);
  if (!validation.success) {
    return NextResponse.json(
      { error: 'Invalid request body', details: validation.error.flatten() },
      { status: 400 }
    );
  }

  const adminClient = createAdminClient();

  // Build update object from validated fields
  const updates: Record<string, unknown> = {};
  if (validation.data.status !== undefined) {
    updates.status = validation.data.status;
  }
  if (validation.data.admin_notes !== undefined) {
    updates.admin_notes = validation.data.admin_notes;
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
  }

  const { data: ticket, error } = await adminClient
    .from('support_tickets')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    console.error('[admin/support] Failed to update ticket:', error);
    return NextResponse.json({ error: 'Failed to update ticket' }, { status: 500 });
  }

  return NextResponse.json({ ticket });
}
