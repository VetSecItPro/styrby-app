/**
 * Override Tier Page — `/dashboard/admin/users/[userId]/override-tier`
 *
 * @route GET /dashboard/admin/users/[userId]/override-tier
 * @auth Required — site admin only, enforced by:
 *   1. `src/middleware.ts` — 404 for non-site-admins (route hiding)
 *   2. `src/app/dashboard/admin/layout.tsx` — redirects non-site-admins to /dashboard
 *   3. `admin_override_tier` RPC — SECURITY DEFINER enforces is_site_admin() in Postgres
 * SOC 2 CC6.1.
 *
 * Purpose:
 *   Server Component that fetches the user's current tier, then renders
 *   `OverrideTierForm` (client component) pre-populated with the current value.
 *
 * WHY fetch current tier here (not in the form):
 *   The form is a Client Component and cannot call Supabase directly (no service
 *   role key on the client). The page is a Server Component — the correct place
 *   for any DB read. The current tier is a convenience prop, not a security check.
 */

import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { createAdminClient } from '@/lib/supabase/server';
import { resolveAdminEmails } from '@/lib/admin/resolveEmails';
import { OverrideTierForm } from '@/components/admin/OverrideTierForm';
import { overrideTierAction } from '@/app/dashboard/admin/users/[userId]/actions';

// ─── UUID validation ──────────────────────────────────────────────────────────

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Types ────────────────────────────────────────────────────────────────────

interface OverrideTierPageProps {
  params: Promise<{ userId: string }>;
}

// ─── Page ─────────────────────────────────────────────────────────────────────

/**
 * Override Tier page.
 *
 * Validates userId, fetches current subscription tier, renders form.
 *
 * @param params - Next.js 15 async route params.
 */
export default async function OverrideTierPage({ params }: OverrideTierPageProps) {
  const { userId } = await params;

  if (!UUID_REGEX.test(userId)) {
    notFound();
  }

  // Fetch current tier for pre-population. Service role needed to read any
  // user's subscription row (RLS scopes to auth.uid()). SOC 2 CC6.1.
  const adminDb = createAdminClient();

  const { data: sub } = await adminDb
    .from('subscriptions')
    .select('tier')
    .eq('user_id', userId)
    .maybeSingle();

  // WHY resolveAdminEmails (not profiles.select('email')): profiles has no email
  // column. Email lives in auth.users, accessible only via the
  // resolve_user_emails_for_admin RPC (migration 043). H27 drift fix.
  const emailMap = await resolveAdminEmails(adminDb, [userId]);
  const resolvedEmail = emailMap[userId] ?? null;

  // Confirm user exists via profiles table (RPC result alone doesn't guarantee
  // the profile row exists if auth.users was created but profile trigger failed).
  const { data: profileExists } = await adminDb
    .from('profiles')
    .select('id')
    .eq('id', userId)
    .maybeSingle();

  if (!profileExists) {
    // userId is a valid UUID but no profile exists.
    notFound();
  }
  // Provide email-like object for display purposes
  const profile = { email: resolvedEmail };

  // WHY bind trustedUserId to the action (Fix B):
  //   Next.js 15 Server Action binding passes the userId as the first argument
  //   server-side before FormData. This value is resolved from the URL param —
  //   it cannot be forged by a client tampered hidden field. The action then
  //   cross-checks FormData.targetUserId against this bound value and rejects
  //   on mismatch. Threat review round 2, Fix B.
  const boundAction = overrideTierAction.bind(null, userId);

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

      <h1 className="mb-2 text-xl font-bold text-zinc-100">Override tier</h1>
      <p className="mb-6 text-sm text-zinc-500">
        For:{' '}
        <span className="font-mono text-zinc-300">{profile.email ?? userId}</span>
      </p>

      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
        <OverrideTierForm
          targetUserId={userId}
          currentTier={sub?.tier ?? 'free'}
          action={boundAction}
        />
      </div>
    </div>
  );
}
