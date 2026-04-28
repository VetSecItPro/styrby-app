/**
 * Toggle Consent Page — `/dashboard/admin/users/[userId]/toggle-consent`
 *
 * @route GET /dashboard/admin/users/[userId]/toggle-consent
 * @auth Required — site admin only, enforced by:
 *   1. `src/middleware.ts` — 404 for non-site-admins
 *   2. `src/app/dashboard/admin/layout.tsx` — redirects non-site-admins
 *   3. `admin_toggle_consent` RPC — SECURITY DEFINER enforces is_site_admin()
 * SOC 2 CC6.1.
 *
 * Purpose:
 *   Server Component that fetches the user's current consent flags, then renders
 *   `ToggleConsentForm` (client component) with the current state pre-populated.
 *
 * WHY fetch current consent state here:
 *   The form shows the current state prominently so the admin does not
 *   accidentally set the flag to its existing value. Server-side fetch avoids
 *   exposing consent data via a client-side API call from a client component.
 */

import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { createAdminClient } from '@/lib/supabase/server';
import { resolveAdminEmails } from '@/lib/admin/resolveEmails';
import { ToggleConsentForm } from '@/components/admin/ToggleConsentForm';
import { toggleConsentAction } from '@/app/dashboard/admin/users/[userId]/actions';

// ─── UUID validation ──────────────────────────────────────────────────────────

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Types ────────────────────────────────────────────────────────────────────

interface ToggleConsentPageProps {
  params: Promise<{ userId: string }>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Derives the human-readable consent state from a consent_flags row.
 *
 * Logic (mirrors the Phase 4.2 consumer convention):
 *   - If granted_at is set AND (revoked_at is null OR revoked_at > granted_at) → 'granted'
 *   - If revoked_at is set AND revoked_at >= granted_at (or granted_at is null) → 'revoked'
 *   - Otherwise → 'not_set'
 *
 * @param flag - consent_flags row from Supabase, or null if no row exists.
 * @returns 'granted' | 'revoked' | 'not_set'
 */
function deriveConsentState(
  flag: { granted_at: string | null; revoked_at: string | null } | null
): 'granted' | 'revoked' | 'not_set' {
  if (!flag) return 'not_set';
  const { granted_at, revoked_at } = flag;
  if (!granted_at && !revoked_at) return 'not_set';
  if (granted_at && !revoked_at) return 'granted';
  if (!granted_at && revoked_at) return 'revoked';
  // Both set — whichever is more recent wins.
  return new Date(granted_at!) >= new Date(revoked_at!) ? 'granted' : 'revoked';
}

// ─── Page ─────────────────────────────────────────────────────────────────────

/**
 * Toggle Consent page.
 *
 * Fetches the current 'support_read_metadata' consent flag for the user, then
 * renders the ToggleConsentForm with the current state.
 *
 * @param params - Next.js 15 async route params.
 */
export default async function ToggleConsentPage({ params }: ToggleConsentPageProps) {
  const { userId } = await params;

  if (!UUID_REGEX.test(userId)) {
    notFound();
  }

  // WHY createAdminClient: consent_flags are RLS-scoped to the user's own rows.
  // Service role is needed to read the target user's consent state. SOC 2 CC6.1.
  const adminDb = createAdminClient();

  // WHY resolveAdminEmails (not profiles.email): profiles has no email column.
  // Email lives in auth.users and is only accessible via the
  // resolve_user_emails_for_admin SECURITY DEFINER RPC (migration 043). H27.
  const [emailMap, { data: consentFlag }] = await Promise.all([
    resolveAdminEmails(adminDb, [userId]),
    adminDb
      .from('consent_flags')
      .select('granted_at, revoked_at')
      .eq('user_id', userId)
      .eq('purpose', 'support_read_metadata')
      .maybeSingle(),
  ]);

  // Confirm the user exists by checking if their email resolved (or fall back to userId)
  const resolvedEmail = emailMap[userId] ?? null;

  const currentState = deriveConsentState(consentFlag);
  // Provide a minimal profile-like object for the display below
  const profile = { email: resolvedEmail };

  // WHY bind trustedUserId to the action (Fix B):
  //   Binds the URL userId server-side so the action can cross-check against
  //   FormData.targetUserId. Prevents forensic integrity issues where a tampered
  //   hidden field causes the action to operate on a different user than the URL.
  //   Threat review round 2, Fix B.
  const boundAction = toggleConsentAction.bind(null, userId);

  return (
    <div className="mx-auto max-w-lg">
      {/* Back link */}
      <Link
        href={`/dashboard/admin/users/${userId}`}
        className="mb-6 inline-flex items-center gap-2 text-sm text-zinc-400 transition-colors hover:text-zinc-100"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to dossier
      </Link>

      <h1 className="mb-2 text-xl font-bold text-zinc-100">Toggle consent</h1>
      <p className="mb-6 text-sm text-zinc-500">
        For:{' '}
        <span className="font-mono text-zinc-300">{profile.email ?? userId}</span>
      </p>

      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
        <ToggleConsentForm
          targetUserId={userId}
          purpose="support_read_metadata"
          currentState={currentState}
          action={boundAction}
        />
      </div>
    </div>
  );
}
