/**
 * GET /api/v1/notification_preferences
 *
 * Returns the authenticated user's notification preferences row, or
 * `{ preferences: null }` if the row hasn't been created yet (callers apply
 * defaults). Mirror of the legacy notification settings query but exposed via
 * the per-user `styrby_*` API key surface for the CLI daemon (Phase 4-step5
 * budget-actions consumer).
 *
 * @auth Required - Bearer `styrby_*` API key via withApiAuthAndRateLimit
 * @rateLimit 100 requests per minute per key (default)
 *
 * @returns 200 { preferences: NotificationPreferencesRow | null }
 *
 * @error 401 { error }  - Missing or invalid API key
 * @error 429 { error }  - Rate limit exceeded
 * @error 500 { error }  - Unexpected database error (sanitized)
 *
 * @security OWASP A01:2021 - row is filtered by `user_id = auth context user`;
 *   no IDOR surface (the caller cannot specify a target user).
 * @security OWASP A02:2021 - response excludes the `user_id` column (redundant
 *   with the authenticated caller). Avoids accidental PII duplication.
 * @security OWASP A07:2021 - auth via withApiAuthAndRateLimit.
 * @security SOC 2 CC6.1 - 'read' scope required; service-role with explicit
 *   user_id filter (no RLS dependency since auth.uid() is null for API keys).
 */

import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';

import {
  withApiAuthAndRateLimit,
  type ApiAuthContext,
} from '@/middleware/api-auth';
import { createAdminClient } from '@/lib/supabase/server';

const ROUTE_ID = '/api/v1/notification_preferences';

/**
 * Columns selected from notification_preferences. Excludes `user_id` (redundant
 * with caller identity) to keep the payload minimal and avoid duplicating PII.
 *
 * Schema authoritatively derived from migrations 001 (base), 005 (priority),
 * 026 (retention hooks), 038 (predictive alerts). If a future migration adds
 * a column, append it here so the CLI surfaces it.
 */
const NOTIFICATION_PREFS_COLUMNS = [
  'id',
  'push_enabled',
  'push_permission_requests',
  'push_session_errors',
  'push_budget_alerts',
  'push_session_complete',
  'email_enabled',
  'email_weekly_summary',
  'email_budget_alerts',
  'quiet_hours_enabled',
  'quiet_hours_start',
  'quiet_hours_end',
  'quiet_hours_timezone',
  'priority_threshold',
  'priority_rules',
  'push_agent_finished',
  'push_budget_threshold',
  'push_weekly_summary',
  'weekly_digest_email',
  'push_predictive_alert',
  'created_at',
  'updated_at',
].join(', ');

/**
 * Core GET handler.
 *
 * Wrapped by withApiAuthAndRateLimit (read scope). Looks up the single row in
 * notification_preferences scoped to the authenticated user. Uses .maybeSingle()
 * so the absence of a row is not an error — callers apply default values when
 * they receive `{ preferences: null }`.
 *
 * @param _request - Authenticated NextRequest (unused; method takes no body/params)
 * @param authContext - Auth context (userId, keyId, scopes) from the wrapper
 * @returns 200 with `{ preferences }` or an appropriate error response
 *
 * @security OWASP A01:2021 - filters strictly by `user_id = authenticated user`.
 * @security SOC 2 CC6.1 - read scope required.
 */
async function handleGet(_request: NextRequest, authContext: ApiAuthContext): Promise<NextResponse> {
  const { userId } = authContext;

  const supabase = createAdminClient();

  // WHY .maybeSingle (not .single): the row is created lazily — the first time
  // the user hits the notification settings UI or the CLI requests prefs. Until
  // then, `null` is the expected, non-error state. .single would raise PGRST116
  // and force callers to special-case it; .maybeSingle yields { data: null }
  // cleanly. SOC 2 CC6.1 (least disclosure — no error noise on absent rows).
  const { data, error } = await supabase
    .from('notification_preferences')
    .select(NOTIFICATION_PREFS_COLUMNS)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    Sentry.captureException(new Error(`notification_preferences fetch error: ${error.message}`), {
      extra: { route: ROUTE_ID },
    });
    return NextResponse.json(
      { error: 'Failed to load notification preferences' },
      { status: 500 },
    );
  }

  return NextResponse.json(
    { preferences: data ?? null },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

/**
 * GET /api/v1/notification_preferences
 *
 * Required scopes: ['read'].
 * Rate limit: default 100 req/min/key.
 */
export const GET = withApiAuthAndRateLimit(handleGet, ['read']);
