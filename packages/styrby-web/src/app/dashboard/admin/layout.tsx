import { redirect } from 'next/navigation';
import { createClient, createAdminClient } from '@/lib/supabase/server';

/**
 * Admin layout gate.
 *
 * WHY server-side: The admin API already returns 403 for non-admins, but
 * without a layout gate a non-admin user can still see the admin page skeleton
 * (empty table, filters, sidebar nav) before the first data fetch 403s. This
 * layout redirects unauthorized users to /dashboard before any admin UI renders.
 *
 * Phase 4.1 T3.5 cutover (PR #154): Previously queried `profiles.is_admin`
 * directly. That column is deprecated (migration 042). This layout now calls
 * the `is_site_admin` Postgres function via RPC — the canonical authorization
 * path going forward.
 *
 * WHY createAdminClient() for the RPC call: The service-role client is required
 * so the RPC executes with full DB privileges. is_site_admin() is SECURITY
 * DEFINER and performs its own access check — the caller does not need a
 * user-scoped client for this check.
 *
 * WHY fail-closed (redirect on error): If the RPC call errors or returns
 * anything other than `true`, we treat the user as non-admin and redirect.
 * An availability failure must not grant admin access. NIST SP 800-53 AC-3.
 *
 * SOC 2 CC6.1: Authorization checks must use the canonical access-control
 * mechanism (site_admins table / is_site_admin function), not a deprecated
 * column that could diverge from the authoritative allowlist.
 */
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();

  // Step 1: Confirm the user is authenticated.
  // WHY getUser() vs. session: getUser() performs a network round-trip to
  // validate the JWT with Supabase Auth, rather than trusting a locally
  // decoded cookie. This prevents JWT-forgery attacks.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }

  // Step 2: Confirm the user is a site admin via the is_site_admin() RPC.
  // WHY p_user_id: The function signature is is_site_admin(p_user_id uuid).
  // Parameter name must match exactly. See migration 040_admin_console.sql.
  //
  // WHY createAdminClient(): The service-role client ensures the RPC call
  // reaches the DB without RLS interference. is_site_admin is SECURITY
  // DEFINER and does its own access check internally.
  const adminDb = createAdminClient();
  const { data: isAdmin, error: rpcError } = await adminDb.rpc('is_site_admin', {
    p_user_id: user.id,
  });

  // Fail-closed: any error or non-true result → redirect to dashboard.
  // WHY redirect to /dashboard not /login: the user IS authenticated; they
  // just don't have admin access. Redirecting to login would be confusing.
  if (rpcError || isAdmin !== true) {
    redirect('/dashboard');
  }

  return <>{children}</>;
}
