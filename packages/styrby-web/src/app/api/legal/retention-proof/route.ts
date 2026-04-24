/**
 * GET /api/legal/retention-proof
 *
 * Purpose: Returns anonymized aggregate counts of data purged by the
 * retention cron in the last 30 days. Rendered on /legal/retention-proof
 * as live proof that Styrby's retention policy is actively enforced.
 *
 * WHY this endpoint exists:
 *   GDPR Article 5(1)(e) — Storage limitation principle: personal data shall
 *   be kept in a form which permits identification of data subjects for no
 *   longer than is necessary. Publishing verifiable purge counts demonstrates
 *   active enforcement rather than passive policy statements.
 *
 *   This is a trust signal for enterprise procurement and acquisition
 *   due-diligence reviewers who want proof that data hygiene is real.
 *
 * Security design:
 *   - No authentication required: the response is aggregate counts only.
 *     There is no personal data in the response. Unauthenticated read of
 *     counts carries zero privacy risk.
 *   - Uses createAdminClient (service role) to bypass RLS. Safe because we
 *     return only count(), not individual row data.
 *   - Cache-Control: public, max-age=3600 — aggregate counts are fresh enough
 *     at 1-hour granularity. CDN caching reduces DB load.
 *
 * Audit citations:
 *   GDPR Art. 5(1)(e) — Storage limitation
 *   SOC2 CC6.5         — Logical access controls: removal of access on deletion
 *   Migration 025      — delete_expired_sessions() cron (soft-delete → deleted_at IS NOT NULL)
 *
 * @auth None required (public aggregate endpoint)
 * @rateLimit Handled by Vercel edge + CDN cache (max-age=3600)
 *
 * @returns 200 {
 *   sessions_purged_30d: number,   // sessions soft-deleted by retention cron in last 30 days
 *   as_of: string                  // ISO 8601 timestamp of when this count was computed
 * }
 *
 * @error 503 { error: true } on database failure (Sentry-logged)
 */

import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import * as Sentry from '@sentry/nextjs';

/** Shape of a successful retention-proof response. */
export type RetentionProofResponse = {
  sessions_purged_30d: number;
  as_of: string;
};

/** Shape of an error response. */
export type RetentionProofErrorResponse = {
  error: true;
};

/**
 * GET /api/legal/retention-proof
 *
 * Returns anonymized aggregate counts of sessions soft-deleted by the
 * retention cron in the last 30 days (from migration 025's
 * delete_expired_sessions() function which sets deleted_at = NOW()).
 */
export async function GET(): Promise<NextResponse<RetentionProofResponse | RetentionProofErrorResponse>> {
  const supabase = createAdminClient();

  try {
    // WHY we query sessions WHERE deleted_at IS NOT NULL AND deleted_at > now() - 30d:
    //   Migration 025's delete_expired_sessions() soft-deletes sessions by setting
    //   deleted_at = NOW(). "Purged in last 30 days" means deleted_at was set recently.
    //   We use IS NOT NULL + range filter (not a separate purge-log table) because
    //   that's the canonical signal from migration 025's cron semantics.
    const { count, error } = await supabase
      .from('sessions')
      .select('*', { count: 'exact', head: true })
      .not('deleted_at', 'is', null)
      .gte('deleted_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());

    if (error) {
      Sentry.captureException(error, {
        tags: { route: 'GET /api/legal/retention-proof' },
      });
      return NextResponse.json(
        { error: true as const },
        {
          status: 503,
          headers: {
            'Cache-Control': 'no-store',
          },
        }
      );
    }

    const response: RetentionProofResponse = {
      sessions_purged_30d: count ?? 0,
      as_of: new Date().toISOString(),
    };

    return NextResponse.json(response, {
      status: 200,
      headers: {
        // WHY 1-hour cache: aggregate retention counts are informational —
        // precision to the hour is more than sufficient for a public proof page.
        // CDN caching reduces unnecessary DB reads for a high-visibility public page.
        'Cache-Control': 'public, max-age=3600, stale-while-revalidate=60',
      },
    });
  } catch (err) {
    Sentry.captureException(err, {
      tags: { route: 'GET /api/legal/retention-proof' },
    });
    return NextResponse.json(
      { error: true as const },
      {
        status: 503,
        headers: {
          'Cache-Control': 'no-store',
        },
      }
    );
  }
}
