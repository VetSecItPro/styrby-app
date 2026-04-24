/**
 * Audit Chain Integrity Verify Endpoint
 *
 * GET /api/admin/audit/verify
 *
 * Calls the `verify_admin_audit_chain` Postgres function and returns the
 * hash-chain integrity status. This endpoint lets the admin console UI surface
 * chain-break events without exposing raw audit table access to the frontend.
 *
 * Auth model:
 *   - Middleware (T3) gates the entire `/api/admin/*` path — non-site-admins
 *     receive a 404 before this handler runs.
 *   - As a secondary belt-and-suspenders check this handler also verifies the
 *     caller is authenticated and is a site admin before executing the RPC.
 *   - `createAdminClient()` (service role) is used for the RPC call because
 *     `verify_admin_audit_chain` is SECURITY DEFINER and reads the full
 *     admin_audit_log table across all users. The user-scoped client cannot
 *     access cross-user rows.
 *   SOC 2 CC7.2: Audit log integrity monitoring — chain verification provides
 *   tamper-evidence for the admin action log. NIST SP 800-53 AU-9.
 *
 * @route   GET /api/admin/audit/verify
 * @auth    Required — site admin only (enforced by middleware T3)
 *
 * @returns 200 {@link AuditVerifyResult}
 * @error   401 { error: 'Unauthorized' }
 * @error   403 { error: 'Forbidden' }
 * @error   500 { error: 'INTERNAL_ERROR', message: string }
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient, createAdminClient } from '@/lib/supabase/server';
import { isAdmin } from '@/lib/admin';
import * as Sentry from '@sentry/nextjs';

// ============================================================================
// Types
// ============================================================================

/**
 * Result shape returned by the `verify_admin_audit_chain` Postgres function.
 * Describes whether the hash chain across all admin_audit_log rows is intact.
 *
 * WHY three status values:
 *   - 'ok'                  — every row's prev_hash matches the preceding row's hash.
 *   - 'prev_hash_mismatch'  — a row's prev_hash does not match the preceding row's hash
 *                             (chain link broken, possible row deletion/insertion).
 *   - 'row_hash_mismatch'   — a row's stored hash does not match the recomputed hash
 *                             (row content was tampered with after insertion).
 *
 * SOC 2 CC7.2: The status distinguishes *what* was tampered with, not just *that*
 * something is wrong, which aids forensic investigation.
 */
export interface AuditVerifyResult {
  /** Overall integrity status. */
  status: 'ok' | 'prev_hash_mismatch' | 'row_hash_mismatch';
  /**
   * The first audit log row ID where the chain is broken.
   * null when status is 'ok'.
   */
  first_broken_id: number | null;
  /** Total number of rows evaluated by the verification function. */
  total_rows: number;
}

// ============================================================================
// Zod schema
// ============================================================================

/**
 * Runtime schema for the `verify_admin_audit_chain` RPC response row.
 *
 * WHY Zod here: The RPC returns a TABLE (array of rows from Supabase JS).
 * We parse the first element of that array. Any schema drift (e.g., someone
 * renames a column in the DB function) surfaces immediately as a 500 with a
 * Sentry alert instead of silently returning malformed JSON to the client.
 * OWASP A08:2021 (Software and Data Integrity Failures): validate all
 * third-party / external data before returning it upstream. SOC 2 CC7.2.
 */
const AuditVerifyResultSchema = z.object({
  status: z.enum(['ok', 'prev_hash_mismatch', 'row_hash_mismatch']),
  first_broken_id: z.number().nullable(),
  total_rows: z.number(),
});

// ============================================================================
// Route handler
// ============================================================================

/**
 * GET /api/admin/audit/verify
 *
 * Executes the `verify_admin_audit_chain` RPC and returns the result.
 * Captures unexpected RPC errors to Sentry before returning 500.
 */
export async function GET(): Promise<NextResponse> {
  // ── Auth: confirm the caller is authenticated ──────────────────────────────
  // WHY createClient() here (not createAdminClient): getUser() validates the
  // JWT with Supabase Auth using the caller's session cookie. createAdminClient
  // has no session, so getUser() would return null. We use the user-scoped
  // client solely for the JWT check, then switch to the admin client for data.
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // ── Auth: confirm the caller is a site admin ───────────────────────────────
  // WHY belt-and-suspenders: middleware already 404s non-admins, but this
  // server-side check is defense-in-depth — if middleware is misconfigured or
  // bypassed (e.g., direct invocation), the handler still enforces authorization.
  // OWASP A01:2021: Never rely solely on routing/middleware for access control.
  const adminStatus = await isAdmin(user.id);
  if (!adminStatus) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // ── Execute RPC ────────────────────────────────────────────────────────────
  // WHY createAdminClient(): verify_admin_audit_chain is SECURITY DEFINER and
  // reads the full admin_audit_log table (cross-user data, RLS-protected).
  // Service role bypasses RLS for this trusted server-side operation.
  // SOC 2 CC6.1: admin client used only after the admin gate has passed.
  const adminDb = createAdminClient();

  const { data, error: rpcError } = await adminDb.rpc('verify_admin_audit_chain');

  if (rpcError) {
    // WHY Sentry capture here (not elsewhere): The RPC should never error in
    // a healthy deployment — the function is SECURITY DEFINER with no external
    // dependencies. An error here means DB schema drift or a Postgres bug.
    // Surface immediately to ops via Sentry. SOC 2 CC7.2.
    Sentry.captureException(rpcError, {
      tags: { endpoint: 'audit-verify' },
      extra: { userId: user.id },
    });
    return NextResponse.json(
      { error: 'INTERNAL_ERROR', message: 'verify_admin_audit_chain RPC failed' },
      { status: 500 }
    );
  }

  // WHY parse the first array element: `verify_admin_audit_chain` is declared
  // as RETURNS TABLE, so Supabase JS wraps the result in an array even though
  // the function always returns exactly one row. We extract element [0] and
  // Zod-validate the shape before returning it to the client.
  //
  // WHY Zod instead of a cast: A future DB schema drift (e.g., column rename,
  // type change) would silently return malformed JSON to the client without
  // Zod. With Zod, schema drift surfaces immediately as a 500 + Sentry alert
  // during development or on the first post-deploy health check.
  // OWASP A08:2021 (Software and Data Integrity Failures). SOC 2 CC7.2.
  const rawRow = Array.isArray(data) ? data[0] : data;
  const parsed = AuditVerifyResultSchema.safeParse(rawRow);

  if (!parsed.success) {
    Sentry.captureException(new Error('audit-verify: unexpected RPC shape'), {
      tags: { endpoint: 'audit-verify', schema_drift: 'true' },
      extra: { userId: user.id, raw: rawRow, zodError: parsed.error.flatten() },
    });
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }

  return NextResponse.json(parsed.data);
}
