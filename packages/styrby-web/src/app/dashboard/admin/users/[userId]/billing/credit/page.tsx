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
import { IssueCreditForm } from '@/components/admin/IssueCreditForm';
import type { AdminActionResult } from '@/app/dashboard/admin/users/[userId]/actions';

// ─── UUID validation ──────────────────────────────────────────────────────────

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Types ────────────────────────────────────────────────────────────────────

interface CreditPageProps {
  params: Promise<{ userId: string }>;
}

// ─── Stub action (T5 will replace) ───────────────────────────────────────────

/**
 * Placeholder server action stub — replaced by the real issueCreditAction in T5.
 *
 * WHY 'use server' pragma: Next.js 15 requires form actions to be server functions.
 * This stub satisfies the type contract; T5 binds the real admin_issue_credit RPC.
 */
async function _stubCreditAction(_formData: FormData): Promise<AdminActionResult> {
  'use server';
  return { ok: false, error: 'Credit action not yet implemented (T5 pending)' };
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

  const { data: profile } = await adminDb
    .from('profiles')
    .select('email')
    .eq('id', userId)
    .maybeSingle();

  if (!profile) {
    notFound();
  }

  // WHY bind pattern (Fix B from Phase 4.1): the real T5 action will be bound
  // with userId so the action receives the unforgeable URL param. The stub here
  // uses .bind(null) as a placeholder; T5 replaces with .bind(null, userId).
  const boundAction = _stubCreditAction.bind(null);

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
