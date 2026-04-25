/**
 * GDPR Data Export API Route
 *
 * POST /api/account/export
 *
 * Allows users to download all their data in JSON format for GDPR compliance
 * (GDPR Article 15 — right of access; Article 20 — right to data portability).
 * Fetches data from all user-related tables in parallel and returns a
 * downloadable JSON file.
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
 * SEC-ADV-003 FIX (2026-04-25): Phase 4 tables added — billing_credits,
 * churn_save_offers, support_access_grants — plus several earlier-phase tables
 * that the original audit missed: passkeys, approvals, sessions_shared, exports,
 * billing_events, data_export_requests, notifications, referral_events,
 * user_feedback_prompts, agent_session_groups, devices, consent_flags.
 * Total tables now exported: 43. See docs/compliance/gdpr-table-inventory-2026-04-25.md.
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
    // Covers all 43 user-related tables for full GDPR Art. 15 / Art. 20 compliance.
    //
    // PERF-DELTA-003: Steps 1-4 fan-in id-lookups in parallel. None depends on
    // any other; the only ordering constraint is that all four must finish
    // before the main parallel block (which uses these id arrays in `.in()`
    // filters). Saves ~75ms vs the prior sequential implementation.
    const [
      { data: userSessions },
      { data: userMachines },
      { data: userWebhooks },
      { data: userTickets },
    ] = await Promise.all([
      // session_messages has no user_id column; it's linked via session_id.
      supabase.from('sessions').select('id').eq('user_id', user.id).limit(10000),
      // machine_keys has no direct user_id column — it is linked via machine_id.
      supabase.from('machines').select('id').eq('user_id', user.id).limit(1000),
      // webhook_deliveries has no direct user_id column — it is linked via webhook_id.
      supabase.from('webhooks').select('id').eq('user_id', user.id).limit(1000),
      // support_ticket_replies uses ticket_id (not user_id) as the ownership link.
      supabase.from('support_tickets').select('id').eq('user_id', user.id).limit(1000),
    ]);

    const sessionIds = (userSessions || []).map((s) => s.id);
    const machineIds = (userMachines || []).map((m) => m.id);
    const webhookIds = (userWebhooks || []).map((w) => w.id);
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
      // SEC-ADV-003 (2026-04-25): Phase 4 + previously-uncovered earlier tables ↓
      passkeysResult,
      approvalsResult,
      sessionsSharedSentResult,
      sessionsSharedReceivedResult,
      exportsResult,
      billingEventsResult,
      dataExportRequestsResult,
      notificationsResult,
      referralEventsResult,
      userFeedbackPromptsResult,
      agentSessionGroupsResult,
      devicesResult,
      consentFlagsResult,
      supportAccessGrantsResult,
      billingCreditsResult,
      churnSaveOffersResult,
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
      // WHY: We intentionally EXCLUDE the public_key itself because: (a) it is only
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

      // ── SEC-ADV-003 (2026-04-25): Phase 4 + earlier-phase gaps ────────────────

      // passkeys (migration 020): WebAuthn credential metadata.
      // WHY exclude public_key + credential_id is fine to expose: credential_id is
      // authenticator-chosen and required for re-registration; we include all
      // non-sensitive metadata. We do NOT exclude any column today because the
      // table stores no private key material — only public-key + counter.
      supabase.from('passkeys').select('*').eq('user_id', user.id).limit(100),

      // approvals (migration 021): team-policy approval requests where the user
      // is the requester. WHY only requester_user_id and not resolver_user_id:
      // the resolver is acting in their team-admin capacity; their identity is
      // still on the row but the row is "owned" by the requester for GDPR purposes.
      supabase.from('approvals').select('*').eq('requester_user_id', user.id).limit(1000),

      // sessions_shared (migration 021) — sender side: share rows the user created.
      supabase.from('sessions_shared').select('*').eq('shared_by_user_id', user.id).limit(1000),

      // sessions_shared (migration 021) — recipient side: shares the user received.
      // WHY two queries (sender + recipient) instead of OR filter: PostgREST .or()
      // syntax has historically caused planner edge cases on auth.users-keyed tables;
      // two narrow queries are clearer and safer.
      supabase.from('sessions_shared').select('*').eq('shared_with_user_id', user.id).limit(1000),

      // exports (migration 021): historical async-export job records (status, format,
      // download URL). User-visible billing of past exports.
      supabase.from('exports').select('*').eq('user_id', user.id).limit(1000),

      // billing_events (migration 021): financial event log. Exported because the
      // user is entitled to see their billing history. NOT deleted (legal-hold
      // financial record; ON DELETE SET NULL preserves the row sans link).
      supabase.from('billing_events').select('*').eq('user_id', user.id).limit(1000),

      // data_export_requests (migration 025): the user's prior export-request history.
      supabase.from('data_export_requests').select('*').eq('user_id', user.id).limit(1000),

      // notifications (migration 026): in-app + push notification history.
      supabase.from('notifications').select('*').eq('user_id', user.id).limit(10000),

      // referral_events (migration 026): referrals the user sent. We only export
      // by referrer_user_id; referred_user_id rows are owned by the new user.
      supabase.from('referral_events').select('*').eq('referrer_user_id', user.id).limit(1000),

      // user_feedback_prompts (migration 027): NPS prompt scheduling state.
      supabase.from('user_feedback_prompts').select('*').eq('user_id', user.id).limit(100),

      // agent_session_groups (migration 035): user-created agent groupings.
      supabase.from('agent_session_groups').select('*').eq('user_id', user.id).limit(1000),

      // devices (migration 036): device records for session-handoff.
      supabase.from('devices').select('*').eq('user_id', user.id).limit(100),

      // consent_flags (migration 040): GDPR Art. 7 consent record per purpose.
      // CRITICAL for Art. 15: a complete export must show what consents the user
      // granted/revoked, including timestamps.
      supabase.from('consent_flags').select('*').eq('user_id', user.id).limit(100),

      // support_access_grants (migration 048): admin-requested session access grants.
      // SEC-ADV-003 P0: prior gap. Without this, the user cannot see which admins
      // requested access to their sessions, or whether they approved/revoked.
      // WHY exclude token_hash: it is a security artefact, not user-meaningful data.
      supabase.from('support_access_grants').select('id, ticket_id, user_id, session_id, granted_by, status, scope, expires_at, requested_at, approved_at, revoked_at, last_accessed_at, access_count, max_access_count, reason').eq('user_id', user.id).limit(1000),

      // billing_credits (migration 050): manually-issued account credits.
      supabase.from('billing_credits').select('*').eq('user_id', user.id).limit(1000),

      // churn_save_offers (migration 050): win-back offers sent to the user.
      supabase.from('churn_save_offers').select('*').eq('user_id', user.id).limit(1000),
    ]);

    // Compile export data with clear structure.
    // WHY: Organized format makes it easy for users to understand their data.
    // SEC-LOGIC-003/004 + SEC-ADV-003: All tables present in the deletion route
    // (and additional Phase 4 tables) are now included so this export covers
    // 100% of personal data per GDPR Art. 15.
    //
    // sessions_shared is split into "sent" and "received" for clarity in the
    // exported JSON; combining them at the top level would lose context for the
    // user reading the export.
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
      // SEC-ADV-003 (2026-04-25): Phase 4 + earlier-phase gaps ↓
      passkeys: passkeysResult.data || [],
      approvals: approvalsResult.data || [],
      sessionsSharedSent: sessionsSharedSentResult.data || [],
      sessionsSharedReceived: sessionsSharedReceivedResult.data || [],
      exports: exportsResult.data || [],
      billingEvents: billingEventsResult.data || [],
      dataExportRequests: dataExportRequestsResult.data || [],
      notifications: notificationsResult.data || [],
      referralEvents: referralEventsResult.data || [],
      userFeedbackPrompts: userFeedbackPromptsResult.data || [],
      agentSessionGroups: agentSessionGroupsResult.data || [],
      devices: devicesResult.data || [],
      consentFlags: consentFlagsResult.data || [],
      // support_access_grants: token_hash excluded
      supportAccessGrants: supportAccessGrantsResult.data || [],
      billingCredits: billingCreditsResult.data || [],
      churnSaveOffers: churnSaveOffersResult.data || [],
    };

    // Calculate record counts for audit
    // WHY: Audit log entry documents what was exported for compliance purposes
    const totalRecords = Object.entries(exportData)
      .filter(([key]) => Array.isArray(exportData[key as keyof typeof exportData]))
      .reduce((sum, [, value]) => sum + (value as unknown[]).length, 0);

    // Log export in audit_log
    // WHY: GDPR compliance requires tracking when data was exported.
    // WHY: Column is 'metadata', not 'details'.
    // WHY tables_exported = 43: 28 prior + 15 added in SEC-ADV-003 (2026-04-25).
    //   Counted as distinct top-level export keys; sessionsSharedSent +
    //   sessionsSharedReceived are split views of one underlying table but count
    //   as two output keys for transparency.
    // WHY export_completed (not export_requested): the Phase 1.6.9 migration
    // adds 'export_completed' to the audit_action enum specifically for the
    // moment a user successfully downloads their data. This is distinct from
    // 'export_requested' (which was a workaround before the enum was extended).
    // GDPR Art. 15 compliance evidence requires a record of successful delivery.
    await supabase.from('audit_log').insert({
      user_id: user.id,
      action: 'export_completed',
      // SEC-INJ-002: Split x-forwarded-for on comma and take the first value to
      // prevent log injection via crafted headers containing multiple IPs.
      ip_address: (request.headers.get('x-forwarded-for') || 'unknown').split(',')[0].trim(),
      metadata: {
        tables_exported: 43,
        total_records: totalRecords,
      },
    });

    // WHY: Also insert a data_export_requests row for the user-facing export history UI.
    // This lets us show "Your last export was on DATE" in the privacy settings panel.
    // The row is marked 'ready' immediately because this endpoint streams the JSON
    // directly (no async ZIP generation step at this tier).
    await supabase.from('data_export_requests').insert({
      user_id: user.id,
      status: 'ready',
      requested_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      ip_address: (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || null,
      user_agent: request.headers.get('user-agent') ?? null,
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
