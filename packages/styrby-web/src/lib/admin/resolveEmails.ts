/**
 * Batch-resolves user_id -> email via the admin-gated SECURITY DEFINER RPC.
 *
 * WHY exists: Supabase auth.users.email is not accessible via PostgREST
 * from public schema by default. Direct `.from('profiles').select('email')`
 * returns nothing because profiles does NOT have an email column. This
 * helper wraps the resolve_user_emails_for_admin RPC (migration 043).
 *
 * WHY service-role client required: The `resolve_user_emails_for_admin`
 * Postgres function is GRANT EXECUTE TO service_role only. Calling it
 * with a user-scoped client will receive a permission denied error.
 * The admin gate inside the function body provides the actual authorization
 * check (is_site_admin). SOC 2 CC6.1.
 *
 * WHY missing IDs are absent from the map (not null): Callers can use
 * `map[id] ?? fallback` cleanly without needing to distinguish
 * "present but null" from "not found". TypeScript Record<string, string>
 * makes the absence explicit.
 *
 * @param supabase - A service-role client (createAdminClient())
 * @param userIds  - Array of user UUIDs to resolve
 * @returns A Record<uuid, string> of resolved emails. Missing IDs are absent
 *   from the map (e.g. deleted users, or IDs that are null/undefined).
 *
 * @example
 * const adminDb = createAdminClient();
 * const emailMap = await resolveAdminEmails(adminDb, ['uuid-1', 'uuid-2']);
 * const email = emailMap['uuid-1'] ?? 'uuid-1'; // UUID fallback
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Row shape returned by the `resolve_user_emails_for_admin` RPC.
 * Typed explicitly rather than casting from `unknown` for runtime safety.
 */
interface ResolveEmailRow {
  user_id: string;
  email: string | null;
}

/**
 * SEC-ADV-007: Typed error thrown when resolveAdminEmails is invoked with a
 * non-service-role client. Distinct class so callers can catch this specifically
 * (e.g. to render a forensic-degraded UI) without swallowing other RPC errors.
 *
 * WHY a typed error (not a generic Error): the previous behavior silently
 * returned `{}` when called with a user-scoped client, causing the admin
 * forensic UI to show UUIDs everywhere with no log signal that anything was
 * wrong. A typed throw makes the failure loud and traceable.
 */
export class AdminEmailResolverMisuseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdminEmailResolverMisuseError';
  }
}

/**
 * SEC-ADV-007: Asserts the supplied Supabase client carries the service-role
 * key. The `resolve_user_emails_for_admin` RPC is GRANT EXECUTE TO service_role
 * only; calling with a user-scoped client returns permission-denied that this
 * helper used to swallow into an empty map. Throwing at the boundary surfaces
 * the misuse loudly during dev/test, before it manifests as a degraded admin UI
 * in production. SOC 2 CC6.1 (logical access control assertions).
 *
 * WHY runtime check (not just types): SupabaseClient is the same TypeScript
 * type for both user and service-role clients. The only runtime distinguisher
 * is `client.supabaseKey === process.env.SUPABASE_SERVICE_ROLE_KEY`.
 *
 * WHY skip the check when the env var is unset: in test environments (vitest)
 * the service-role key may be absent. We only enforce when both sides exist;
 * when either is missing we fall back to letting the RPC's own permission
 * check decide. This avoids breaking tests that mock the client without
 * setting env vars.
 */
function assertServiceRoleClient(supabase: SupabaseClient): void {
  const expected = process.env.SUPABASE_SERVICE_ROLE_KEY;
  // Accessing the private supabaseKey field via a typed cast — the property
  // exists at runtime on every supabase-js v2 client (verified in
  // node_modules/@supabase/supabase-js dist).
  const actual = (supabase as unknown as { supabaseKey?: string }).supabaseKey;
  if (!expected || !actual) return;
  if (actual !== expected) {
    throw new AdminEmailResolverMisuseError(
      'resolveAdminEmails requires a service-role client (createAdminClient()). ' +
        'Got a client with a different supabaseKey — likely a user-scoped client. ' +
        'See SEC-ADV-007 in styrby-backlog.md.',
    );
  }
}

export async function resolveAdminEmails(
  supabase: SupabaseClient,
  userIds: string[],
): Promise<Record<string, string>> {
  // SEC-ADV-007: Loud misuse detection — see assertServiceRoleClient above.
  assertServiceRoleClient(supabase);

  // Short-circuit: avoid an unnecessary DB round-trip for empty input.
  if (userIds.length === 0) return {};

  const { data, error } = await supabase.rpc('resolve_user_emails_for_admin', {
    p_user_ids: userIds,
  });

  if (error || !Array.isArray(data)) {
    // WHY log but don't throw: a failure here is non-fatal for the caller.
    // The caller falls back to showing UUIDs rather than crashing the page.
    // SOC 2 CC7.2: warn ops without degrading the admin console entirely.
    console.error('[resolveAdminEmails] RPC error:', error?.message ?? 'unexpected non-array response');
    return {};
  }

  const map: Record<string, string> = {};
  for (const row of data as ResolveEmailRow[]) {
    // WHY skip null emails: a null email means the user record exists in auth.users
    // but has no email set (e.g. phone-only auth). Don't put null in the map —
    // the caller's UUID fallback handles the missing entry cleanly.
    if (row.email) map[row.user_id] = row.email;
  }
  return map;
}
