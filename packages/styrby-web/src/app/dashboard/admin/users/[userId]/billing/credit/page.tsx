/**
 * Issue Credit Page — `/dashboard/admin/users/[userId]/billing/credit`
 *
 * @route GET /dashboard/admin/users/[userId]/billing/credit
 * @auth Required — site admin only, enforced by:
 *   1. `src/middleware.ts` — 404 for non-site-admins
 *   2. `src/app/dashboard/admin/layout.tsx` — redirects non-site-admins
 *   3. `admin_issue_credit` RPC — SECURITY DEFINER enforces is_site_admin()
 * SOC 2 CC6.1.
 *
 * Purpose:
 *   Server Component that fetches target user context (email) and renders
 *   IssueCreditForm with a bound server action stub (real action implemented in T5).
 *
 * WHY createAdminClient:
 *   Profiles are RLS-scoped to auth.uid(). Service role is required.
 */

import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { createAdminClient } from '@/lib/supabase/server';
import { resolveAdminEmails } from '@/lib/admin/resolveEmails';
import { IssueCreditForm } from '@/components/admin/IssueCreditForm';
import { issueCreditAction } from '../actions';

// ─── UUID validation ──────────────────────────────────────────────────────────

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Types ────────────────────────────────────────────────────────────────────

interface CreditPageProps {
  params: Promise<{ userId: string }>;
}

// ─── Page ─────────────────────────────────────────────────────────────────────

/**
 * Issue Credit page.
 *
 * Validates userId, fetches user email for display context, renders form.
 *
 * @param params - Next.js 15 async route params.
 */
export default async function IssueCreditPage({ params }: CreditPageProps) {
  const { userId } = await params;

  if (!UUID_REGEX.test(userId)) {
    notFound();
  }

  // WHY createAdminClient: profiles RLS-scoped to auth.uid(). SOC 2 CC6.1.
  const adminDb = createAdminClient();

  // WHY resolveAdminEmails: profiles has no email column. H27.
  const [{ data: profileExists }, emailMap] = await Promise.all([
    adminDb.from('profiles').select('id').eq('id', userId).maybeSingle(),
    resolveAdminEmails(adminDb, [userId]),
  ]);

  if (!profileExists) {
    notFound();
  }

  const profile = { email: emailMap[userId] ?? null };

  // WHY bind pattern (Fix B from Phase 4.1): the action is bound with userId so
  // it receives the unforgeable URL param as its first argument. The action's
  // URL cross-check rejects any FormData.targetUserId that differs from this
  // bound value, preventing mutations on the wrong user. billing/actions.ts.
  const boundAction = issueCreditAction.bind(null, userId);

  return (
    <div className="mx-auto max-w-lg">
      {/* Back link */}
      <Link
        href={`/dashboard/admin/users/${userId}/billing`}
        className="mb-6 inline-flex items-center gap-2 text-sm text-zinc-400 transition-colors hover:text-zinc-100"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to billing dossier
      </Link>

      <h1 className="mb-2 text-xl font-bold text-zinc-100">Issue account credit</h1>
      <p className="mb-6 text-sm text-zinc-500">
        For:{' '}
        <span className="font-mono text-zinc-300">{profile.email ?? userId}</span>
      </p>

      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
        <IssueCreditForm targetUserId={userId} action={boundAction} />
      </div>
    </div>
  );
}
