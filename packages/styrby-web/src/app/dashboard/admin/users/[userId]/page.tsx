/**
 * User Dossier Page — `/dashboard/admin/users/[userId]`
 *
 * @route GET /dashboard/admin/users/[userId]
 * @auth Required — site admin only, enforced by:
 *   1. `src/middleware.ts` — returns 404 for non-site-admins (deny-by-obscurity)
 *   2. `src/app/dashboard/admin/layout.tsx` — redirects non-site-admins to /dashboard
 *   This page assumes both gates have already passed. SOC 2 CC6.1.
 *
 * Purpose:
 *   Server Component orchestrator for the user dossier. Validates the `userId`
 *   URL parameter, confirms the user exists, then delegates rendering to
 *   `UserDossier` (which manages the Suspense-wrapped sub-cards).
 *
 * WHY validation happens here (not in each card):
 *   The page is the single entry point for the route. Validating userId once
 *   at the page level means:
 *   1. Invalid UUIDs immediately 404 without any DB queries.
 *   2. Non-existent users 404 after a single fast profiles lookup.
 *   3. All 5 sub-cards can trust that userId is a valid UUID pointing to a
 *      real user — they skip their own existence checks.
 *
 * WHY createAdminClient() for the existence check:
 *   Profiles are RLS-scoped to auth.uid(). The service-role client is needed
 *   to query any user's profile row, not just the admin's own.
 *   SOC 2 CC6.1: admin client used only after the layout + middleware have
 *   confirmed the caller is a site admin.
 *
 * WHY userEmail is resolved at the page level:
 *   The page header in UserDossier needs the email for the title. Rather than
 *   having UserDossier issue its own profiles query just for the email (which
 *   ProfileCard will also issue), we resolve it here and pass it as a prop.
 *   ProfileCard re-fetches the full profile for its own rendering; this is
 *   acceptable duplication because the queries are near-instant and the benefit
 *   (simpler component interface) outweighs the minor overhead.
 */

import { notFound } from 'next/navigation';
import { createAdminClient } from '@/lib/supabase/server';
import { UserDossier } from '@/components/admin/UserDossier';

// ─── UUID validation ──────────────────────────────────────────────────────────

/**
 * RFC 4122 UUID v4 regex used to reject clearly invalid userId params before
 * issuing any DB query. This prevents malformed strings from causing DB errors
 * and closes a theoretical SQL/parameter injection path even with parameterized
 * queries (defense-in-depth).
 *
 * WHY regex not UUID library: no need for an import; the regex is exact enough
 * for our purposes. Supabase's Postgres will also reject non-UUID strings in the
 * `.eq('id', userId)` call, but we reject sooner for clarity.
 */
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Returns true if the given string is a valid UUID.
 *
 * @param s - String to validate
 */
function isValidUuid(s: string): boolean {
  return UUID_REGEX.test(s);
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface UserDossierPageProps {
  params: Promise<{ userId: string }>;
}

// ─── Page Component ───────────────────────────────────────────────────────────

/**
 * Async Server Component orchestrator for the user dossier.
 *
 * Validates `userId`, confirms the profile exists, and renders the dossier.
 * All card-level data fetching is deferred to the sub-card Server Components
 * inside UserDossier, each wrapped in their own Suspense boundary.
 *
 * @param params - Next.js dynamic route params (async in Next.js 15+).
 */
export default async function UserDossierPage({ params }: UserDossierPageProps) {
  const { userId } = await params;

  // ── 1. Validate UUID format ────────────────────────────────────────────────

  if (!isValidUuid(userId)) {
    // WHY notFound() not throw: invalid UUID is a client error (bad URL), not
    // a server error. Next.js notFound() renders the nearest not-found.tsx,
    // which returns 404. This also prevents DB errors from a malformed UUID.
    notFound();
  }

  // ── 2. Confirm user exists ────────────────────────────────────────────────

  // WHY createAdminClient: profiles are RLS-scoped to auth.uid(). We need the
  // service-role client to look up any user's profile.
  const adminDb = createAdminClient();

  const { data: profile, error } = await adminDb
    .from('profiles')
    .select('id, email')
    .eq('id', userId)
    .maybeSingle();

  if (error) {
    // WHY log + notFound (not throw): a DB error on the existence check should
    // surface as 404, not a 500 that leaks internal details. The Sentry global
    // handler captures the error. This is the same fail-safe pattern used in
    // the admin guard. SOC 2 CC6.1.
    console.error('[UserDossierPage] profile lookup error:', error.message);
    notFound();
  }

  if (!profile) {
    // userId is a valid UUID but no matching profile row exists. Return 404.
    notFound();
  }

  // ── 3. Render dossier ─────────────────────────────────────────────────────

  // WHY pass userEmail at this level: the dossier header needs the email for
  // the page title. We resolved it here as part of the existence check so we
  // don't need a second profiles query inside UserDossier.
  return (
    <UserDossier
      userId={profile.id}
      userEmail={profile.email ?? userId}
    />
  );
}
