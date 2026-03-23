/**
 * Account Deletion API Route
 *
 * DELETE /api/account/delete
 *
 * Initiates account deletion using a soft-delete pattern. Data is marked as
 * deleted immediately but not permanently removed for 30 days, allowing for
 * recovery if needed.
 *
 * @auth Required - Supabase Auth JWT via cookie
 * @rateLimit 1 request per day
 *
 * @body {
 *   confirmation: 'DELETE MY ACCOUNT' (exact match required),
 *   reason?: string (optional feedback)
 * }
 *
 * @returns 200 { success: true, message: string }
 *
 * @error 400 { error: string } - Invalid JSON or confirmation mismatch
 * @error 401 { error: 'Unauthorized' }
 * @error 429 { error: 'RATE_LIMITED', retryAfter: number }
 * @error 500 { error: 'Failed to delete account' }
 */

import { createClient, createAdminClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { rateLimit, RATE_LIMITS, rateLimitResponse } from '@/lib/rateLimit';

/**
 * Zod schema for delete request validation.
 * WHY: The confirmation literal ensures users consciously acknowledge deletion.
 * This prevents accidental deletions from automated tools or misclicks.
 */
const DeleteRequestSchema = z.object({
  confirmation: z.literal('DELETE MY ACCOUNT'),
  reason: z.string().optional(),
});

/**
 * Handles account deletion requests.
 *
 * WHY soft-delete: Allows recovery within 30 days if user changes their mind
 * or if the deletion was unauthorized. Hard deletion is scheduled separately.
 *
 * @param request - The incoming HTTP request
 * @returns Success message or error response
 */
export async function DELETE(request: Request) {
  // Rate limit check - 1 deletion attempt per day
  // WHY: Prevents abuse and accidental rapid clicks
  const { allowed, retryAfter } = await rateLimit(request, RATE_LIMITS.delete, 'delete');
  if (!allowed) {
    return rateLimitResponse(retryAfter!);
  }

  const supabase = await createClient();

  // Get authenticated user
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Validate request body
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const validation = DeleteRequestSchema.safeParse(body);
  if (!validation.success) {
    return NextResponse.json(
      { error: 'Must confirm with "DELETE MY ACCOUNT"' },
      { status: 400 }
    );
  }

  const now = new Date().toISOString();

  try {
    // Soft-delete profile (RLS ensures ownership)
    // WHY: Setting deleted_at triggers RLS policies that hide deleted data
    const { error: profileError } = await supabase
      .from('profiles')
      .update({ deleted_at: now })
      .eq('id', user.id);

    if (profileError) throw profileError;

    // Soft-delete sessions
    // WHY: Preserves session data for potential recovery
    await supabase
      .from('sessions')
      .update({ deleted_at: now })
      .eq('user_id', user.id);

    // Delete device tokens (hard delete - no need to keep)
    // WHY: Push tokens are useless after account deletion and could be
    // a privacy concern if retained
    await supabase.from('device_tokens').delete().eq('user_id', user.id);

    // SEC-INTEG-001 FIX: Hard-delete data that references auth.users directly
    // (not via profiles). These tables do NOT cascade from profiles.deleted_at
    // and would remain accessible until the retention cron fires 30 days later.
    // Since the user is banned immediately, API access is blocked — but for
    // defense in depth, we remove sensitive data now rather than waiting.
    //
    // Tables verified to cascade from profiles ON DELETE CASCADE (handled by
    // the retention cron's hard delete of auth.users):
    //   machines -> machine_keys, sessions -> session_messages/bookmarks,
    //   agent_configs, cost_records, subscriptions, budget_alerts,
    //   notification_preferences, prompt_templates, offline_command_queue,
    //   audit_log, user_feedback, api_keys, webhooks -> webhook_deliveries
    //
    // Tables that reference auth.users DIRECTLY (not profiles) — these must
    // be handled explicitly here or they persist until auth.users hard-delete:
    await Promise.allSettled([
      // context_templates: references auth.users ON DELETE CASCADE, but we
      // purge immediately since templates have no recovery value.
      supabase.from('context_templates').delete().eq('user_id', user.id),

      // notification_logs: analytics/debug logs — no recovery value, purge now.
      // References auth.users ON DELETE CASCADE.
      supabase.from('notification_logs').delete().eq('user_id', user.id),

      // support_tickets: references auth.users ON DELETE CASCADE, but we
      // purge immediately for privacy. support_ticket_replies will cascade
      // automatically from the support_tickets FK (ticket_id ON DELETE CASCADE).
      // Note: support_ticket_replies uses author_id (not user_id), so we
      // only need to delete the parent tickets; replies cascade automatically.
      supabase.from('support_tickets').delete().eq('user_id', user.id),
    ]);

    // Log deletion in audit_log (before signing out user)
    // WHY: Compliance requirement - track account lifecycle events
    // WHY: 'account_deleted' is not in audit_action enum. Use 'settings_updated'
    // with resource_type to indicate it was a deletion. Column is 'metadata', not 'details'.
    await supabase.from('audit_log').insert({
      user_id: user.id,
      action: 'settings_updated',
      resource_type: 'account_deletion',
      ip_address: request.headers.get('x-forwarded-for') || 'unknown',
      metadata: {
        soft_delete: true,
        reason: validation.data.reason || 'Not provided',
        hard_delete_scheduled: '30 days',
      },
    });

    // FIX-012: Ban the user in auth.users to prevent login during grace period
    // WHY: Soft-deleting the profile doesn't prevent re-authentication.
    // The user could log back in and see their (partially deleted) data.
    // Banning via admin API ensures the JWT is invalidated immediately.
    const adminClient = createAdminClient();
    await adminClient.auth.admin.updateUserById(user.id, {
      ban_duration: '720h', // 30 days — matches hard-delete grace period
    });

    // Sign out the user
    // WHY: User should no longer have access after initiating deletion
    await supabase.auth.signOut();

    return NextResponse.json({
      success: true,
      message:
        'Account scheduled for deletion. Data will be permanently removed in 30 days.',
    });
  } catch (error) {
    const isDev = process.env.NODE_ENV === 'development';
    console.error(
      'Delete error:',
      isDev ? error : error instanceof Error ? error.message : 'Unknown error'
    );
    return NextResponse.json({ error: 'Failed to delete account' }, { status: 500 });
  }
}
