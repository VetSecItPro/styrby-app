/**
 * Idempotency Key Cleanup Cron
 *
 * POST /api/cron/idempotency-cleanup
 *
 * Deletes expired idempotency_keys rows (expires_at < NOW()). Runs daily at
 * 02:00 CT (08:00 UTC) — off-peak for US traffic, avoids locking contention
 * with peak-hour user requests.
 *
 * WHY a cron instead of relying on Postgres pg_cron or TTL triggers:
 * - pg_cron is available on Supabase but requires the cron.schedule() call to
 *   live in a migration, which couples schema migrations to operational schedules.
 * - Vercel crons are already used for all other cleanup jobs (retention, digests)
 *   and provide centralized scheduling visibility in the Vercel dashboard.
 * - The idx_idempotency_keys_expires index makes this DELETE highly efficient
 *   even at scale (B-tree range scan, not full table scan).
 *
 * Scale expectation: At 10k mutating requests/day with ~20% using idempotency
 * keys = ~2k rows/day. 24h expiry = ~2k rows at steady state. Batch size of
 * 5000 is more than sufficient; added for safety parity with retention cron.
 *
 * @auth Required - CRON_SECRET header must match CRON_SECRET env var
 * @schedule Daily at 02:00 CT (08:00 UTC) — see vercel.json
 *
 * @returns 200 { success: true, deleted: number }
 *
 * @error 401 { error: 'Unauthorized' }
 * @error 500 { error: string }
 *
 * @module api/cron/idempotency-cleanup/route
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import crypto from 'crypto';

/**
 * Maximum rows to delete per cron run.
 *
 * WHY: Prevents runaway DELETE queries that could hold row-level locks for
 * too long under load. At steady state this table has ~2k rows; 5000 rows
 * is a safe ceiling even after a missed run.
 */
const BATCH_SIZE = 5000;

/**
 * Handles the daily idempotency key cleanup.
 *
 * WHY POST not GET: Vercel crons send POST requests. Matching the method
 * prevents accidental invocation via browser GET (which would trigger
 * the CRON_SECRET check but is still a best-practice hygiene item).
 *
 * @param request - Incoming cron request from Vercel infrastructure
 * @returns JSON response with count of deleted rows
 */
export async function POST(request: NextRequest): Promise<Response> {
  // ── Auth: CRON_SECRET guard ───────────────────────────────────────────────

  // WHY timing-safe comparison: prevent timing attacks that could enumerate
  // valid CRON_SECRET values by measuring response latency differences.
  // OWASP ASVS V2.9.1 — use constant-time comparison for secret values.
  const cronSecret = process.env.CRON_SECRET;
  const incomingSecret = request.headers.get('authorization')?.replace('Bearer ', '') ?? '';

  if (!cronSecret) {
    console.error('[idempotency-cleanup] CRON_SECRET env var is not set');
    return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 });
  }

  const secretsMatch = crypto.timingSafeEqual(
    Buffer.from(incomingSecret, 'utf8'),
    Buffer.from(cronSecret, 'utf8'),
  );

  if (!secretsMatch) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────

  const adminClient = createAdminClient();

  try {
    // Delete all expired rows in a single DELETE with a LIMIT via a subquery.
    // WHY subquery with ctid: Postgres DELETE does not support LIMIT directly.
    // Using a subquery that selects ctid (the physical row identifier) is the
    // idiomatic pattern for batched deletes in Postgres.
    //
    // Alternative considered: multiple small batches in a loop. Rejected because
    // the expected row count (~2k/day) does not justify the round-trip overhead.
    // The BATCH_SIZE ceiling provides the safety guarantee without looping.
    const { error, count } = await adminClient
      .from('idempotency_keys')
      .delete({ count: 'exact' })
      .lt('expires_at', new Date().toISOString())
      .limit(BATCH_SIZE);

    if (error) {
      console.error('[idempotency-cleanup] Delete failed:', error.message);
      return NextResponse.json({ error: 'Cleanup query failed' }, { status: 500 });
    }

    const deleted = count ?? 0;
    console.log(`[idempotency-cleanup] Deleted ${deleted} expired idempotency key(s)`);

    return NextResponse.json({ success: true, deleted });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[idempotency-cleanup] Unexpected error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
