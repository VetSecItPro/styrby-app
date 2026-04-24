/**
 * Reset Password Page — `/dashboard/admin/users/[userId]/reset-password`
 *
 * @route GET /dashboard/admin/users/[userId]/reset-password
 * @auth Required — site admin only, enforced by:
 *   1. `src/middleware.ts` — 404 for non-site-admins
 *   2. `src/app/dashboard/admin/layout.tsx` — redirects non-site-admins
 *   3. `admin_record_password_reset` RPC — SECURITY DEFINER enforces is_site_admin()
 * SOC 2 CC6.1.
 *
 * Purpose:
 *   Server Component that resolves the target user's email address, then renders
 *   `ResetPasswordForm` (client component) with the email for confirmation display.
 *
 * WHY fetch email here:
 *   The form must display the target email to prevent fat-fingering. The email
 *   is fetched server-side (service role) and passed as a prop to the client
 *   form component. The form also sends it as a hidden field so the server
 *   action can pass it to Supabase Auth admin.generateLink(). Validated again
 *   by Zod in the server action.
 */

import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { createAdminClient } from '@/lib/supabase/server';
import { ResetPasswordForm } from '@/components/admin/ResetPasswordForm';
import { resetPasswordAction } from '@/app/dashboard/admin/users/[userId]/actions';

// ─── UUID validation ──────────────────────────────────────────────────────────

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Types ────────────────────────────────────────────────────────────────────

interface ResetPasswordPageProps {
  params: Promise<{ userId: string }>;
}

// ─── Page ─────────────────────────────────────────────────────────────────────

/**
 * Reset Password confirmation page.
 *
 * Resolves the user's email from the profiles table, then renders the
 * ResetPasswordForm with the email for the admin to visually confirm before
 * triggering the magic-link send.
 *
 * @param params - Next.js 15 async route params.
 */
export default async function ResetPasswordPage({ params }: ResetPasswordPageProps) {
  const { userId } = await params;

  if (!UUID_REGEX.test(userId)) {
    notFound();
  }

  // WHY createAdminClient: profiles are RLS-scoped to auth.uid(). Service role
  // is required to read the target user's email. SOC 2 CC6.1.
  const adminDb = createAdminClient();

  const { data: profile } = await adminDb
    .from('profiles')
    .select('email')
    .eq('id', userId)
    .maybeSingle();

  if (!profile) {
    notFound();
  }

  // WHY not render the form without an email: Supabase auth.admin.generateLink()
  // requires a valid email. If the profile has no email (edge case for OAuth-only
  // accounts without email scope), we surface an error rather than rendering a
  // form the admin cannot use.
  if (!profile.email) {
    return (
      <div className="mx-auto max-w-lg">
        <Link
          href={`/dashboard/admin/users/${userId}`}
          className="mb-6 inline-flex items-center gap-2 text-sm text-zinc-400 transition-colors hover:text-zinc-100"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to dossier
        </Link>
        <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-5 text-sm text-red-400">
          This user has no email address on record. Password reset via magic link is not available.
        </div>
      </div>
    );
  }

  // WHY bind trustedUserId to the action (Fix B):
  //   Binds the URL userId server-side so the action can cross-check against
  //   FormData.targetUserId. Prevents forensic integrity issues where a tampered
  //   hidden field causes the action to operate on a different user than the URL.
  //   Threat review round 2, Fix B.
  const boundAction = resetPasswordAction.bind(null, userId);

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

      <h1 className="mb-2 text-xl font-bold text-zinc-100">Reset password</h1>
      <p className="mb-6 text-sm text-zinc-500">
        Sends a one-time password-reset magic link to the user.
      </p>

      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
        <ResetPasswordForm targetUserId={userId} targetEmail={profile.email} action={boundAction} />
      </div>
    </div>
  );
}
