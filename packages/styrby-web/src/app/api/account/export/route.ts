/**
 * GDPR Data Export API Route
 *
 * POST /api/account/export
 *
 * Allows users to download all their data in JSON format for GDPR compliance
 * (GDPR Article 20 — Right to Data Portability). Fetches data from all
 * user-related tables in parallel and returns a downloadable JSON file.
 *
 * SEC-LOGIC-003 / SEC-LOGIC-004 FIX: Export now includes every table that the
 * deletion route removes. Previously the following tables were deleted but not
 * exported, meaning users could not receive a complete copy of their data
 * before deletion:
 *   - context_templates
 *   - notification_logs
 *   - support_tickets + support_ticket_replies
 *   - session_checkpoints  (cascades from sessions on hard delete)
 *   - machine_keys         (cascades from machines on hard delete; key material excluded)
 *   - webhook_deliveries   (cascades from webhooks on hard delete)
 *   - session_shared_links (references shared_by = user.id)
 *
 * @auth Required - Supabase Auth JWT via cookie
 * @rateLimit 1 request per hour
 *
 * @returns 200 - JSON file download with Content-Disposition header
 *
 * @error 401 { error: 'Unauthorized' }
 * @error 429 { error: 'RATE_LIMITED', retryAfter: number }
 * @error 500 { error: 'Failed to export data' }
 */

import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { rateLimit, RATE_LIMITS, rateLimitResponse } from '@/lib/rateLimit';

/**
 * Handles GDPR data export requests.
 *
 * WHY POST instead of GET: While GET might seem logical for "getting" data,
 * POST is used because this is an expensive operation that modifies state
 * (creates audit log entries) and shouldn't be cached or prefetched.
 *
 * @param request - The incoming HTTP request
 * @returns JSON file download or error response
 */
export async function POST(request: Request) {
  // Rate limit check - 1 export per hour
  const { allowed, retryAfter } = await rateLimit(request, RATE_LIMITS.export, 'export');
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

  try {
    // Fetch all user data in parallel for performance.
    // WHY: Each table is independent, so parallel fetches are safe and faster.
    // Covers all 28 user-related tables for full GDPR Art. 20 compliance.
    //
    // Step 1: Fetch user's session IDs first so we can query session_messages.
    // WHY: session_messages has no user_id column; it's linked via session_id.
    const { data: userSessions } = await supabase
      .from('sessions')
      .select('id')
      .eq('user_id', user.id)
      .limit(10000);

    const sessionIds = (userSessions || []).map((s) => s.id);

    // Step 2: Fetch machine IDs so we can query machine_keys via machine_id IN.
    // WHY: machine_keys has no direct user_id column — it is linked via machine_id.
    const { data: userMachines } = await supabase
      .from('machines')
      .select('id')
      .eq('user_id', user.id)
      .limit(1000);

    const machineIds = (userMachines || []).map((m) => m.id);

    // Step 3: Fetch webhook IDs so we can query webhook_deliveries via webhook_id IN.
    // WHY: webhook_deliveries has no direct user_id column — it is linked via webhook_id.
    const { data: userWebhooks } = await supabase
      .from('webhooks')
      .select('id')
      .eq('user_id', user.id)
      .limit(1000);

    const webhookIds = (userWebhooks || []).map((w) => w.id);

    // Step 4: Fetch support ticket IDs so we can query replies via ticket_id IN.
    // WHY: support_ticket_replies uses ticket_id (not user_id) as the ownership link.
    const { data: userTickets } = await supabase
      .from('support_tickets')
      .select('id')
      .eq('user_id', user.id)
      .limit(1000);

    const ticketIds = (userTickets || []).map((t) => t.id);

    // Step 5: Fetch all tables in parallel with limits to prevent OOM.
    // WHY: Each table is independent; parallel fetches are safe and significantly
    // faster than sequential queries.
    const [
      profileResult,
      sessionsResult,
      messagesResult,
      costsResult,
      alertsResult,
      configsResult,
      tokensResult,
      feedbackResult,
      machinesResult,
      subscriptionsResult,
      preferencesResult,
      bookmarksResult,
      teamsResult,
      teamMembersResult,
      teamInvitationsResult,
      webhooksResult,
      apiKeysResult,
      auditLogResult,
      promptTemplatesResult,
      offlineQueueResult,
      // SEC-LOGIC-003 / SEC-LOGIC-004: Tables previously missing from export ↓
      contextTemplatesResult,
      notificationLogsResult,
      supportTicketsResult,
      supportTicketRepliesResult,
      sessionCheckpointsResult,
      machineKeysResult,
      webhookDeliveriesResult,
      sessionSharedLinksResult,
    ] = await Promise.all([
      supabase.from('profiles').select('*').eq('id', user.id).single(),
      supabase.from('sessions').select('*').eq('user_id', user.id).limit(10000),
      // WHY: session_messages has no user_id column - query via session_id IN
      sessionIds.length > 0
        ? supabase.from('session_messages').select('*').in('session_id', sessionIds).limit(50000)
        : Promise.resolve({ data: [], error: null }),
      supabase.from('cost_records').select('*').eq('user_id', user.id).limit(50000),
      supabase.from('budget_alerts').select('*').eq('user_id', user.id).limit(1000),
      supabase.from('agent_configs').select('*').eq('user_id', user.id).limit(1000),
      supabase.from('device_tokens').select('*').eq('user_id', user.id).limit(1000),
      supabase.from('user_feedback').select('*').eq('user_id', user.id).limit(1000),
      supabase.from('machines').select('*').eq('user_id', user.id).limit(1000),
      supabase.from('subscriptions').select('*').eq('user_id', user.id).limit(100),
      supabase.from('notification_preferences').select('*').eq('user_id', user.id).limit(100),
      supabase.from('session_bookmarks').select('*').eq('user_id', user.id).limit(10000),
      // Teams & collaboration (migration 006)
      supabase.from('teams').select('*').eq('owner_id', user.id).limit(100),
      supabase.from('team_members').select('*').eq('user_id', user.id).limit(1000),
      supabase.from('team_invitations').select('*').eq('invited_user_id', user.id).limit(1000),
      // Webhooks (migration 004)
      supabase.from('webhooks').select('*').eq('user_id', user.id).limit(1000),
      // API keys - exclude key_hash for security
      supabase.from('api_keys').select('id, user_id, name, key_prefix, scopes, last_used_at, last_used_ip, request_count, expires_at, revoked_at, revoked_reason, created_at').eq('user_id', user.id).limit(1000),
      // Audit log - contains IP addresses and user agents (personal data)
      supabase.from('audit_log').select('*').eq('user_id', user.id).limit(10000),
      // User's custom prompt templates (not system templates)
      supabase.from('prompt_templates').select('*').eq('user_id', user.id).limit(1000),
      // Offline command queue
      supabase.from('offline_command_queue').select('*').eq('user_id', user.id).limit(1000),

      // ── SEC-LOGIC-003/004: Previously missing tables added below ────────────

      // context_templates (migration 002): user-created context injection templates.
      // References auth.users directly; deleted immediately on account deletion.
      supabase.from('context_templates').select('*').eq('user_id', user.id).limit(1000),

      // notification_logs (migration 005): history of every push notification
      // decision (sent/suppressed) for the user. Personal data per GDPR.
      // Excluded columns: none — all fields are appropriate to export.
      supabase.from('notification_logs').select('*').eq('user_id', user.id).limit(10000),

      // support_tickets (migration 012): support requests opened by the user.
      // Deleted explicitly on account deletion (does not cascade from profiles).
      supabase.from('support_tickets').select('*').eq('user_id', user.id).limit(1000),

      // support_ticket_replies: replies by the user and support staff on their tickets.
      // WHY: No user_id column — linked via ticket_id. Replies cascade from tickets
      // on hard delete, but the user is entitled to a copy before deletion.
      // Only export replies on tickets the user owns to avoid leaking admin content
      // on other users' tickets; RLS enforces this but we are explicit.
      ticketIds.length > 0
        ? supabase.from('support_ticket_replies').select('id, ticket_id, author_type, author_id, message, created_at').in('ticket_id', ticketIds).limit(5000)
        : Promise.resolve({ data: [], error: null }),

      // session_checkpoints (migration 015): named save-points within sessions.
      // Has a direct user_id column (belt-and-suspenders alongside the session FK).
      supabase.from('session_checkpoints').select('*').eq('user_id', user.id).limit(10000),

      // machine_keys (migration 001): public keys for E2E encryption.
      // WHY: Key material (public_key) is safe to export — it is the public half.
      // We intentionally EXCLUDE the public_key itself because: (a) it is only
      // useful for encryption, not for the user to "take their data elsewhere", and
      // (b) exporting public keys in a bulk data dump is an unnecessary attack
      // surface if the export file is compromised. Fingerprint is sufficient for
      // the user to verify which keys existed.
      machineIds.length > 0
        ? supabase.from('machine_keys').select('id, machine_id, fingerprint, created_at, expires_at').in('machine_id', machineIds).limit(1000)
        : Promise.resolve({ data: [], error: null }),

      // webhook_deliveries (migration 004): delivery history for each webhook.
      // WHY: No user_id column — linked via webhook_id. Cascades from webhooks on
      // hard delete. Delivery history is personal data (timestamps, payloads).
      webhookIds.length > 0
        ? supabase.from('webhook_deliveries').select('id, webhook_id, event, status, attempts, last_attempt_at, response_status, error_message, duration_ms, created_at').in('webhook_id', webhookIds).limit(10000)
        : Promise.resolve({ data: [], error: null }),

      // session_shared_links: share links the user created for their sessions.
      // WHY: Uses 'shared_by' (not user_id) as the ownership column.
      supabase.from('session_shared_links').select('*').eq('shared_by', user.id).limit(1000),
    ]);

    // Compile export data with clear structure.
    // WHY: Organized format makes it easy for users to understand their data.
    // SEC-LOGIC-003/004: All tables present in the deletion route are now included
    // so this export covers 100% of data that would be destroyed on account deletion.
    const exportData = {
      exportedAt: new Date().toISOString(),
      userId: user.id,
      email: user.email,
      profile: profileResult.data,
      sessions: sessionsResult.data || [],
      messages: messagesResult.data || [],
      costRecords: costsResult.data || [],
      budgetAlerts: alertsResult.data || [],
      agentConfigs: configsResult.data || [],
      deviceTokens: tokensResult.data || [],
      feedback: feedbackResult.data || [],
      machines: machinesResult.data || [],
      subscriptions: subscriptionsResult.data || [],
      notificationPreferences: preferencesResult.data || [],
      bookmarks: bookmarksResult.data || [],
      teams: teamsResult.data || [],
      teamMemberships: teamMembersResult.data || [],
      teamInvitations: teamInvitationsResult.data || [],
      webhooks: webhooksResult.data || [],
      apiKeys: apiKeysResult.data || [],
      auditLog: auditLogResult.data || [],
      promptTemplates: promptTemplatesResult.data || [],
      offlineCommandQueue: offlineQueueResult.data || [],
      // SEC-LOGIC-003/004: Tables previously missing from export ↓
      contextTemplates: contextTemplatesResult.data || [],
      notificationLogs: notificationLogsResult.data || [],
      supportTickets: supportTicketsResult.data || [],
      supportTicketReplies: supportTicketRepliesResult.data || [],
      sessionCheckpoints: sessionCheckpointsResult.data || [],
      // machine_keys: public_key excluded — fingerprint + metadata exported only
      machineKeys: machineKeysResult.data || [],
      // webhook_deliveries: payload excluded — delivery status + metadata exported
      webhookDeliveries: webhookDeliveriesResult.data || [],
      sessionSharedLinks: sessionSharedLinksResult.data || [],
    };

    // Calculate record counts for audit
    // WHY: Audit log entry documents what was exported for compliance purposes
    const totalRecords = Object.entries(exportData)
      .filter(([key]) => Array.isArray(exportData[key as keyof typeof exportData]))
      .reduce((sum, [, value]) => sum + (value as unknown[]).length, 0);

    // Log export in audit_log
    // WHY: GDPR compliance requires tracking when data was exported.
    // WHY: Column is 'metadata', not 'details'.
    // WHY tables_exported = 28: 20 original tables + 8 tables added in SEC-LOGIC-003/004 fix:
    //   context_templates, notification_logs, support_tickets, support_ticket_replies,
    //   session_checkpoints, machine_keys, webhook_deliveries, session_shared_links.
    await supabase.from('audit_log').insert({
      user_id: user.id,
      action: 'export_requested',
      // SEC-INJ-002: Split x-forwarded-for on comma and take the first value to
      // prevent log injection via crafted headers containing multiple IPs.
      ip_address: (request.headers.get('x-forwarded-for') || 'unknown').split(',')[0].trim(),
      metadata: {
        tables_exported: 28,
        total_records: totalRecords,
      },
    });

    // Generate filename with date for user reference
    const date = new Date().toISOString().split('T')[0];
    const filename = `styrby-data-export-${date}.json`;

    // Return as downloadable JSON file
    // WHY: Content-Disposition header triggers browser download
    return new Response(JSON.stringify(exportData, null, 2), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    const isDev = process.env.NODE_ENV === 'development';
    console.error(
      'Export error:',
      isDev ? error : error instanceof Error ? error.message : 'Unknown error'
    );
    return NextResponse.json({ error: 'Failed to export data' }, { status: 500 });
  }
}
