/**
 * Admin authorization utilities.
 *
 * Phase 4.1 T3.5 cutover (PR #154): isAdmin() previously queried
 * `profiles.is_admin` directly. That column is now DEPRECATED (migration 042).
 * All admin authorization calls now route through the `is_site_admin` Postgres
 * function via RPC, which queries the canonical `site_admins` table.
 *
 * WHY is_site_admin() via RPC instead of a direct table query:
 *   - `is_site_admin` is SECURITY DEFINER — it executes with the function
 *     definer's privileges so the RLS self-SELECT policy on site_admins works
 *     correctly even when called from a service-role context.
 *   - Centralising the check in a Postgres function means future changes to
 *     the admin allowlist logic (e.g. adding expiry, role tiers) require only
 *     a DB migration, not an application deploy.
 *   - SOC 2 CC6.1: A single, auditable access-control function is easier to
 *     verify than disparate direct table queries scattered across API routes.
 *
 * WHY fail-closed (return false on error):
 *   An availability failure in the authorization path MUST default to DENY.
 *   A database outage or unexpected RPC error must never become an admin-access
 *   bypass. NIST SP 800-53 AC-3 (Access Enforcement): "deny-all, permit-by-exception."
 *   OWASP A01:2021 (Broken Access Control): errors in auth checks must not
 *   silently grant access.
 */

import { createAdminClient } from '@/lib/supabase/server';

/**
 * Checks whether the given user ID belongs to a site admin.
 *
 * Calls the `is_site_admin` Postgres function via RPC (migration 040).
 * The function queries the `site_admins` table using SECURITY DEFINER
 * privileges and returns a boolean.
 *
 * WHY createAdminClient() here: The service-role key is needed so the RPC
 * call reaches the DB with full privileges. The `is_site_admin` function is
 * itself SECURITY DEFINER and performs its own access check — the caller does
 * not need a user-scoped client. Using the admin client also ensures the RPC
 * works correctly in server-side contexts (API routes, Server Components)
 * where a user session cookie may not be present.
 *
 * T3.5 cutover: Previously queried `profiles.is_admin` via
 * `.from('profiles').select('is_admin')`. That column is deprecated as of
 * migration 042. New callers must use this function.
 *
 * @param userId - The authenticated user's UUID (from supabase.auth.getUser())
 * @returns `true` if the user is a confirmed site admin, `false` for any other
 *   outcome: non-admin, unauthenticated, empty userId, or database error.
 *   Fail-closed: errors always return `false`.
 *
 * @example
 * const adminStatus = await isAdmin(user.id);
 * if (!adminStatus) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
 */
export async function isAdmin(userId: string): Promise<boolean> {
  // Short-circuit for empty/falsy userId — no DB query needed.
  // WHY: Calling RPC with an empty string would be a wasteful round-trip and
  // could produce unexpected Postgres behaviour (empty string ≠ NULL UUID).
  if (!userId) return false;

  const supabase = createAdminClient();

  // WHY p_user_id: The is_site_admin() function signature is:
  //   CREATE OR REPLACE FUNCTION public.is_site_admin(p_user_id uuid)
  // The parameter name must match exactly. See migration 040_admin_console.sql.
  const { data, error } = await supabase.rpc('is_site_admin', { p_user_id: userId });

  // WHY fail-closed: A DB error, network timeout, or unexpected null MUST NOT
  // grant admin access. Return false for any non-true outcome.
  if (error) return false;

  return data === true;
}
