import { redirect } from 'next/navigation';
import { createClient, createAdminClient } from '@/lib/supabase/server';
import { AdminMfaBanner } from '@/components/admin/AdminMfaBanner';

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

  // Fetch the admin's MFA grace window for the banner.
  //
  // WHY here (layout) not assertAdminMfa(): the layout must NOT call
  // assertAdminMfa() because that would block the passkey enrollment page
  // itself — a bootstrap paradox. The layout only reads mfa_grace_until for
  // the banner; the MFA enforcement happens per-action in each route handler.
  //
  // WHY createAdminClient() here: the service-role client is already used above
  // for the is_site_admin RPC. Reusing it (rather than adding a user-scoped
  // client) avoids an extra client instantiation and keeps the layout focused
  // on orchestration.
  //
  // WHY maybeSingle + null fallback: if the admin row has no mfa_grace_until
  // (new admin added after enforcement) or the query fails, graceUntil = null
  // and the banner is hidden. This is the correct fail-open for UI (the banner
  // is informational — suppressing it on error is safe).
  const { data: adminRow } = await adminDb
    .from('site_admins')
    .select('mfa_grace_until')
    .eq('user_id', user.id)
    .maybeSingle();

  const graceUntil = adminRow?.mfa_grace_until ?? null;

  return (
    <>
      {/* WHY AdminMfaBanner outside children: the banner is layout-level UI
          displayed above the admin page content, not injected by each page. */}
      <AdminMfaBanner graceUntil={graceUntil} />
      {children}
    </>
  );
}
