/**
 * GDPR Data Export API Route
 *
 * POST /api/account/export
 *
 * Allows users to download all their data in JSON format for GDPR compliance.
 * Fetches data from all user-related tables in parallel and returns a
 * downloadable JSON file.
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
  const { allowed, retryAfter } = rateLimit(request, RATE_LIMITS.export, 'export');
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
    // Fetch all user data in parallel for performance
    // WHY: Each table is independent, so parallel fetches are safe and faster
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
    ] = await Promise.all([
      supabase.from('profiles').select('*').eq('id', user.id).single(),
      supabase.from('sessions').select('*').eq('user_id', user.id),
      supabase.from('session_messages').select('*').eq('user_id', user.id),
      supabase.from('cost_records').select('*').eq('user_id', user.id),
      supabase.from('budget_alerts').select('*').eq('user_id', user.id),
      supabase.from('agent_configs').select('*').eq('user_id', user.id),
      supabase.from('device_tokens').select('*').eq('user_id', user.id),
      supabase.from('user_feedback').select('*').eq('user_id', user.id),
      supabase.from('machines').select('*').eq('user_id', user.id),
      supabase.from('subscriptions').select('*').eq('user_id', user.id),
      supabase.from('notification_preferences').select('*').eq('user_id', user.id),
      supabase.from('session_bookmarks').select('*').eq('user_id', user.id),
    ]);

    // Compile export data with clear structure
    // WHY: Organized format makes it easy for users to understand their data
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
    };

    // Calculate record counts for audit
    // WHY: Audit log entry documents what was exported for compliance purposes
    const totalRecords = Object.entries(exportData)
      .filter(([key]) => Array.isArray(exportData[key as keyof typeof exportData]))
      .reduce((sum, [, value]) => sum + (value as unknown[]).length, 0);

    // Log export in audit_log
    // WHY: GDPR compliance requires tracking when data was exported
    await supabase.from('audit_log').insert({
      user_id: user.id,
      action: 'export_requested',
      details: {
        tables_exported: 12,
        total_records: totalRecords,
        ip_address: request.headers.get('x-forwarded-for') || 'unknown',
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
