/**
 * Public health endpoint
 *
 * GET /api/health
 *
 * Returns the live status of Styrby's external dependencies. Designed to be
 * polled every 5 minutes by the self-hosted uptime cron at
 * /api/cron/uptime-monitor (and by any external uptime probe in the
 * future). The response is intentionally JSON + non-cached so the cron
 * can parse a structured payload and surface WHICH dependency is down,
 * not just "site is sick".
 *
 * Dependency checks (each ≤ 5 second timeout, run in parallel):
 *   - Supabase: lightweight `SELECT 1` via admin client. Counts as healthy
 *     iff the round trip completes without an error.
 *   - Polar: HEAD on the public docs base URL (no auth required). We're
 *     proving the merchant-of-record is reachable from this region.
 *   - OpenRouter: GET /api/v1/credits with the existing OPENROUTER_API_KEY.
 *     Reusing the credit-monitor's auth path means an OpenRouter outage
 *     surfaces here AND on the /perf side; no new secret to manage.
 *
 * @auth NONE — must be public so external probes can hit prod without
 *   handing out CRON_SECRET. The endpoint is read-only and exposes only
 *   "ok | down" booleans + commit SHA, no PII or secret material.
 *
 * @returns 200 when status='ok' (every check passed)
 * @returns 503 when status='degraded' or 'down' (one or more checks failed)
 *   503 (not 200) is deliberate: it lets dumb HTTP probes (curl, BetterStack
 *   if we ever swap back) treat the response as a failure without parsing
 *   the body.
 */

import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';

/**
 * Hard ceiling per dependency check. Anything beyond this is "down" for
 * the purposes of the uptime cron — a 5-second-slow Supabase response is
 * already a customer-visible degradation.
 */
const PER_CHECK_TIMEOUT_MS = 5_000;

/**
 * Aggregate ceiling. Even with parallel checks, Vercel functions have
 * their own request budget; 10s gives us margin against a single slow
 * dependency stalling the whole response.
 */
const AGGREGATE_TIMEOUT_MS = 10_000;

/**
 * Polar's docs root is public (no auth, no rate limit reported) and lives
 * on the same edge fabric that processes payments. A failed HEAD here is
 * a strong signal Polar can't service us either.
 */
const POLAR_HEALTH_URL = 'https://polar.sh';

const OPENROUTER_CREDITS_URL = 'https://openrouter.ai/api/v1/credits';

/**
 * Per-dependency health verdict surfaced in the JSON response. The cron
 * reads `checks.<dep>` and emails an alert containing the failing key.
 */
interface DependencyChecks {
  /** Supabase admin-client `SELECT 1` succeeded. */
  db: boolean;
  /** Polar reachability HEAD returned 2xx/3xx. */
  polar: boolean;
  /** OpenRouter /credits GET returned 2xx (auth + reachability). */
  openrouter: boolean;
  /** Build version label (npm package version). */
  version: string;
  /** Vercel git commit SHA short hash, or 'unknown' locally. */
  commit: string;
}

interface HealthResponse {
  status: 'ok' | 'degraded' | 'down';
  checks: DependencyChecks;
  /** ISO 8601 generation timestamp (server clock). */
  timestamp: string;
  /** Total wall-clock time spent running the checks, in milliseconds. */
  elapsed_ms: number;
}

/**
 * Race a promise against a per-check timeout. Returns false on timeout or
 * any thrown error so a failing dependency can never break the response.
 *
 * @param fn - The async work to perform; must resolve to a boolean.
 * @param ms - Timeout in milliseconds.
 */
async function timed(fn: () => Promise<boolean>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([
      fn().catch(() => false),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Supabase reachability check. Uses the admin client + a trivially-cheap
 * read (`SELECT 1` via the well-known auth.uid() RPC isn't quite right;
 * we use a count on `profiles` with head: true to avoid pulling rows).
 */
async function checkDb(): Promise<boolean> {
  try {
    const supabase = createAdminClient();
    // head:true + count: only — Postgres returns row count, no row data.
    // Cheapest possible round trip that proves the connection works.
    const { error } = await supabase
      .from('profiles')
      .select('*', { count: 'exact', head: true });
    return !error;
  } catch {
    return false;
  }
}

/**
 * Polar reachability check. HEAD on the marketing root: counts as healthy
 * if the response is any 2xx/3xx. We deliberately do NOT auth — a Polar
 * API auth failure here would conflate "Polar is down" with "our token
 * expired" and the uptime cron is the wrong place to discover the latter.
 */
async function checkPolar(): Promise<boolean> {
  try {
    const res = await fetch(POLAR_HEALTH_URL, {
      method: 'HEAD',
      cache: 'no-store',
    });
    return res.status >= 200 && res.status < 400;
  } catch {
    return false;
  }
}

/**
 * OpenRouter reachability check. Uses the existing OPENROUTER_API_KEY so
 * a 401 here also flags "our key just got revoked" — a real ops problem
 * the operator wants to know about. If the key is unset (e.g. preview
 * envs), we report healthy so health checks don't fail in dev.
 */
async function checkOpenRouter(): Promise<boolean> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return true;
  try {
    const res = await fetch(OPENROUTER_CREDITS_URL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}` },
      cache: 'no-store',
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function GET() {
  const started = Date.now();

  // Run all three checks in parallel under the aggregate ceiling.
  const work = Promise.all([
    timed(checkDb, PER_CHECK_TIMEOUT_MS),
    timed(checkPolar, PER_CHECK_TIMEOUT_MS),
    timed(checkOpenRouter, PER_CHECK_TIMEOUT_MS),
  ]);

  const aggTimeout = new Promise<[boolean, boolean, boolean]>((resolve) => {
    setTimeout(() => resolve([false, false, false]), AGGREGATE_TIMEOUT_MS);
  });

  const [db, polar, openrouter] = await Promise.race([work, aggTimeout]);

  const checks: DependencyChecks = {
    db,
    polar,
    openrouter,
    version: process.env.npm_package_version ?? '0.0.0',
    commit: (process.env.VERCEL_GIT_COMMIT_SHA ?? 'unknown').slice(0, 7),
  };

  // WHY 'degraded' for partial failures and 'down' only for db: the
  // database being unreachable is a hard customer-impact event (auth,
  // sessions, everything dies). Polar/OpenRouter being down degrades
  // billing/summaries respectively but the core product still works.
  const allOk = db && polar && openrouter;
  const status: HealthResponse['status'] = allOk
    ? 'ok'
    : !db
      ? 'down'
      : 'degraded';

  const body: HealthResponse = {
    status,
    checks,
    timestamp: new Date().toISOString(),
    elapsed_ms: Date.now() - started,
  };

  return NextResponse.json(body, {
    status: allOk ? 200 : 503,
    headers: {
      // Probes must always see fresh status; intermediate caches would
      // defeat the purpose.
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    },
  });
}
