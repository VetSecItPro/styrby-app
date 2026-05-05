/**
 * GET /api/admin/sentry-smoke
 *
 * Triggers a deliberate, tagged Sentry event so the operator can confirm
 * the production Sentry pipeline is wired end-to-end (DSN configured, ingest
 * reaches the dashboard, alerts fire, etc.). Exists because P5 in the launch
 * backlog couldn't be closed by setting env vars alone — there's no
 * substitute for a real round-trip.
 *
 * @auth Required - admin gate via isAdmin()
 * @rateLimit standard (30/min) — smoke test, not customer-facing
 *
 * @returns 200 { event_id: string, kind: 'message' | 'exception' }
 *
 * Behavior:
 *   - Sends a `Sentry.captureMessage` at level=info with the tag
 *     `smoke_test=true` AND a `Sentry.captureException` with the same tag.
 *   - Returns the Sentry-assigned event IDs so the operator can search the
 *     Sentry dashboard ("Issues" → filter by tag `smoke_test:true`) and
 *     confirm both events landed.
 *   - Does NOT throw. The test is the side-effect; the response is
 *     diagnostic.
 *
 * @example
 *   curl -H "Cookie: <admin-session-cookie>" https://styrbyapp.com/api/admin/sentry-smoke
 *   # → {"event_id":"abc...","exception_event_id":"def..."}
 *   # Then check Sentry dashboard for tag smoke_test=true
 *
 * Security:
 *   - Admin-only (no anon access; could otherwise be abused to flood Sentry).
 *   - The synthetic exception is plainly tagged `smoke_test=true` so on-call
 *     can filter it out of any alert rules.
 *
 * @module api/admin/sentry-smoke/route
 */

import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { createClient } from '@/lib/supabase/server';
import { isAdmin } from '@/lib/admin';
import { rateLimit, RATE_LIMITS, rateLimitResponse } from '@/lib/rateLimit';

export async function GET(request: Request) {
  // Rate-limit even though admin-gated — defense in depth.
  const { allowed, retryAfter } = await rateLimit(
    request as Parameters<typeof rateLimit>[0],
    RATE_LIMITS.standard,
    'sentry-smoke',
  );
  if (!allowed) return rateLimitResponse(retryAfter!);

  // Admin gate (mirrors founder-metrics pattern).
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!(await isAdmin(user.id))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // Fire a tagged info-level message AND a tagged synthetic exception.
  // WHY both: some alert rules trigger on errors only; some on messages.
  // Hitting both confirms the full ingestion path for both event types.
  const messageEventId = Sentry.captureMessage('Styrby Sentry smoke test (info)', {
    level: 'info',
    tags: { smoke_test: 'true', triggered_by: user.id },
  });

  const exceptionEventId = Sentry.captureException(
    new Error('Styrby Sentry smoke test (synthetic exception — IGNORE)'),
    {
      tags: { smoke_test: 'true', triggered_by: user.id },
      level: 'warning',
    },
  );

  // Flush so the events leave the process before the response returns.
  // Without flush, serverless cold-stop might lose them.
  await Sentry.flush(2_000);

  return NextResponse.json({
    ok: true,
    message_event_id: messageEventId,
    exception_event_id: exceptionEventId,
    next_step: 'Open Sentry dashboard → Issues → search tag smoke_test:true to confirm both events landed.',
  });
}
