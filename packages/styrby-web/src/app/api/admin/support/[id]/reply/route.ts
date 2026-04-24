/**
 * Admin Support Ticket Reply API
 *
 * POST /api/admin/support/[id]/reply
 *
 * Adds an admin reply to a support ticket and sends an email notification
 * to the ticket owner via Resend.
 *
 * @auth Required - Supabase Auth JWT via cookie (admin only)
 *
 * @body { message: string }
 *
 * @returns 201 { reply, emailSent: boolean }
 * @error 400 { error: string }
 * @error 401 { error: 'Unauthorized' }
 * @error 403 { error: 'Forbidden' }
 * @error 404 { error: 'Ticket not found' }
 * @error 500 { error: string }
 */

import { createClient, createAdminClient } from '@/lib/supabase/server';
import { isAdmin } from '@/lib/admin';
import { sendSupportReplyEmail } from '@/lib/resend';
import { rateLimit, RATE_LIMITS, rateLimitResponse } from '@/lib/rateLimit';
import { NextResponse } from 'next/server';
import { z } from 'zod';

/** Zod schema for the reply body */
const ReplySchema = z.object({
  message: z.string().min(1).max(5000),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // A-008: Rate limit admin routes
  const { allowed, retryAfter } = await rateLimit(request, RATE_LIMITS.standard, 'admin-support-reply');
  if (!allowed) return rateLimitResponse(retryAfter!);

  // Verify auth and admin status
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // A-001: Use site_admins table / is_site_admin() RPC instead of email claim (migration 042 T3.5 cutover)
  if (!(await isAdmin(user.id))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // Parse and validate body
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const validation = ReplySchema.safeParse(body);
  if (!validation.success) {
    return NextResponse.json(
      { error: 'Message is required (1-5000 characters)' },
      { status: 400 }
    );
  }

  const adminClient = createAdminClient();

  // Verify the ticket exists
  const { data: ticket, error: ticketError } = await adminClient
    .from('support_tickets')
    .select('id, user_id, subject')
    .eq('id', id)
    .single();

  if (ticketError || !ticket) {
    return NextResponse.json({ error: 'Ticket not found' }, { status: 404 });
  }

  // Insert the admin reply
  const { data: reply, error: insertError } = await adminClient
    .from('support_ticket_replies')
    .insert({
      ticket_id: id,
      author_type: 'admin',
      author_id: user.id,
      message: validation.data.message,
    })
    .select()
    .single();

  if (insertError) {
    // A-010: Avoid logging raw Supabase error objects in production
    console.error('[admin/support/reply] Failed to insert reply:', insertError instanceof Error ? insertError.message : String(insertError));
    return NextResponse.json({ error: 'Failed to add reply' }, { status: 500 });
  }

  // SEC-ADMIN-001 FIX: Audit log the admin reply action.
  // WHY: Sending replies to users is a high-impact admin action - it
  // communicates on behalf of the company. An audit trail lets us
  // investigate disputed communications and detect misuse of admin access.
  await adminClient.from('audit_log').insert({
    user_id: user.id,
    action: 'admin.support_ticket.reply',
    resource_type: 'support_ticket',
    resource_id: id,
    metadata: { ticket_id: id, message_length: validation.data.message.length },
  });

  // Send email notification to the ticket owner
  let emailSent = false;
  const { data: ticketOwner } = await adminClient.auth.admin.getUserById(ticket.user_id);

  if (ticketOwner?.user?.email) {
    const emailResult = await sendSupportReplyEmail({
      email: ticketOwner.user.email,
      subject: ticket.subject,
      message: validation.data.message,
      ticketId: ticket.id,
    });
    emailSent = emailResult.success;
  }

  return NextResponse.json({ reply, emailSent }, { status: 201 });
}
