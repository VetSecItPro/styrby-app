/**
 * ProfileCard — User profile + consent flags sub-card for the admin dossier.
 *
 * Purpose:
 *   Displays the core profile data for a user: email (from auth.users join),
 *   account creation date, site-admin badge (if the user is in site_admins),
 *   and all consent_flags rows keyed by purpose.
 *
 * Auth model:
 *   Called only from UserDossier, which is rendered inside
 *   `/dashboard/admin/layout.tsx` — that layout gates access via `is_site_admin()`.
 *   This card fetches cross-user data using `createAdminClient()` (service role),
 *   bypassing RLS intentionally. SOC 2 CC6.1.
 *
 * Query shape:
 *   - profiles row for userId (email, created_at, full_name)
 *   - site_admins membership check (boolean badge)
 *   - consent_flags rows for userId (purpose, granted_at, revoked_at)
 *
 * WHY independent fetch (Suspense parallel):
 *   Each dossier card owns its own query. React Suspense streams cards as
 *   individual async Server Components — ProfileCard resolves as soon as the
 *   profiles query completes, regardless of how long SessionsCard or
 *   RecentAuditCard take. This means a slow audit query never delays the
 *   most commonly-needed profile info. See UserDossier.tsx for the full
 *   Suspense parallelism explanation.
 *
 * @param userId - UUID of the target user (validated in the page before render)
 */

import { createAdminClient } from '@/lib/supabase/server';
import { Shield, User } from 'lucide-react';
import { fmtDate } from './formatters';

// ─── Types ────────────────────────────────────────────────────────────────────

/** A single consent flag row as returned by the Supabase query. */
interface ConsentFlag {
  purpose: string;
  granted_at: string | null;
  revoked_at: string | null;
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Server Component: fetches and renders the profile + consent block.
 *
 * @param userId - UUID of the user being viewed. Validated before this renders.
 */
export async function ProfileCard({ userId }: { userId: string }) {
  // WHY createAdminClient: querying cross-user profiles + consent_flags requires
  // bypassing RLS (which would filter to only auth.uid()'s rows). Service role
  // is the correct tool here; the admin gate in layout.tsx is the authorization
  // enforcement point. SOC 2 CC6.1 + NIST SP 800-53 AC-3.
  const adminDb = createAdminClient();

  // Parallel fetches: profile, admin membership, consent flags.
  // WHY Promise.all: three independent queries — no need to wait for one before
  // issuing the next. Reduces latency from 3-serial to max-of-3-parallel.
  const [profileResult, siteAdminResult, consentResult] = await Promise.all([
    adminDb
      .from('profiles')
      .select('id, email, full_name, created_at')
      .eq('id', userId)
      .maybeSingle(),

    adminDb
      .from('site_admins')
      .select('user_id')
      .eq('user_id', userId)
      .maybeSingle(),

    adminDb
      .from('consent_flags')
      .select('purpose, granted_at, revoked_at')
      .eq('user_id', userId)
      .order('purpose', { ascending: true }),
  ]);

  // WHY graceful degradation: if a sub-query errors, render what we can and
  // surface the error inline. We never want one data-layer error to blank the
  // entire card — the admin still needs to see as much info as possible.
  const profile = profileResult.data;
  const isSiteAdmin = Boolean(siteAdminResult.data);
  const consentFlags: ConsentFlag[] = consentResult.data ?? [];

  if (!profile) {
    // notFound() is called at the page level if profile truly doesn't exist.
    // If we reach here, it means the profile vanished between the page-level
    // check and this card rendering (extremely rare race). Surface a clear error.
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5" data-testid="profile-card-error">
        <p className="text-sm text-red-400">Profile data unavailable.</p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5" data-testid="profile-card">
      {/* Card header */}
      <div className="mb-4 flex items-center gap-2">
        <User className="h-4 w-4 text-zinc-400" aria-hidden="true" />
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">Profile</h2>
        {isSiteAdmin && (
          /* WHY: A site admin viewing another site admin's dossier should be
             immediately aware of elevated privileges. Without this badge, an
             admin might accidentally issue a password-reset on a peer admin
             without noticing. Defense-in-depth visibility. */
          <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-400">
            <Shield className="h-3 w-3" aria-hidden="true" />
            Site Admin
          </span>
        )}
      </div>

      {/* Profile fields */}
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
        <dt className="text-zinc-500">User ID</dt>
        <dd className="font-mono text-xs text-zinc-300 break-all" data-testid="profile-user-id">
          {profile.id}
        </dd>

        <dt className="text-zinc-500">Email</dt>
        <dd className="font-mono text-zinc-100" data-testid="profile-email">
          {/* WHY React JSX render: email from Supabase is rendered via JSX text
              nodes — React escapes all special characters automatically. We never
              use dangerouslySetInnerHTML here. Security note: XSS via stored email
              is mitigated at the React layer. */}
          {profile.email ?? '—'}
        </dd>

        {profile.full_name && (
          <>
            <dt className="text-zinc-500">Name</dt>
            <dd className="text-zinc-100">{profile.full_name}</dd>
          </>
        )}

        <dt className="text-zinc-500">Joined</dt>
        <dd className="text-zinc-300" title={profile.created_at ?? ''}>
          {fmtDate(profile.created_at)}
        </dd>
      </dl>

      {/* Consent flags */}
      {consentFlags.length > 0 && (
        <div className="mt-5 border-t border-zinc-800 pt-4">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-zinc-500">
            Consent Flags
          </h3>
          <table className="w-full text-xs" aria-label="Consent flags for this user">
            <thead>
              <tr className="border-b border-zinc-800">
                <th className="py-1.5 text-left font-medium text-zinc-400">Purpose</th>
                <th className="py-1.5 text-left font-medium text-zinc-400">Granted</th>
                <th className="py-1.5 text-left font-medium text-zinc-400">Revoked</th>
                <th className="py-1.5 text-left font-medium text-zinc-400">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/60">
              {consentFlags.map((flag) => {
                // WHY status logic: a flag is "granted" if granted_at is set AND
                // revoked_at is null. Once revoked, the row stays for audit trail
                // but the user's consent is no longer active.
                const isGranted = Boolean(flag.granted_at) && !flag.revoked_at;

                return (
                  <tr key={flag.purpose} data-testid="consent-flag-row">
                    <td className="py-1.5 font-mono text-zinc-300">{flag.purpose}</td>
                    <td className="py-1.5 text-zinc-500" title={flag.granted_at ?? ''}>
                      {fmtDate(flag.granted_at)}
                    </td>
                    <td className="py-1.5 text-zinc-500" title={flag.revoked_at ?? ''}>
                      {fmtDate(flag.revoked_at)}
                    </td>
                    <td className="py-1.5">
                      <span
                        className={`inline-flex rounded-full px-1.5 py-0.5 text-xs font-medium ${
                          isGranted
                            ? 'bg-green-500/10 text-green-400'
                            : 'bg-zinc-700/50 text-zinc-500'
                        }`}
                        data-testid={`consent-status-${flag.purpose}`}
                      >
                        {isGranted ? 'granted' : 'revoked'}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Empty consent state */}
      {consentFlags.length === 0 && (
        <div className="mt-5 border-t border-zinc-800 pt-4">
          <p className="text-xs text-zinc-600">No consent flags on record.</p>
        </div>
      )}
    </div>
  );
}
