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

export async function resolveAdminEmails(
  supabase: SupabaseClient,
  userIds: string[],
): Promise<Record<string, string>> {
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
