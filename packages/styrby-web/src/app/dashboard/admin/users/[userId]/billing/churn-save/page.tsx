/**
 * Send Churn-Save Offer Page — `/dashboard/admin/users/[userId]/billing/churn-save`
 *
 * @route GET /dashboard/admin/users/[userId]/billing/churn-save
 * @auth Required — site admin only, enforced by:
 *   1. `src/middleware.ts` — 404 for non-site-admins
 *   2. `src/app/dashboard/admin/layout.tsx` — redirects non-site-admins
 *   3. `admin_send_churn_save_offer` RPC — SECURITY DEFINER enforces is_site_admin()
 * SOC 2 CC6.1.
 *
 * Purpose:
 *   Server Component that fetches target user context (email, subscription tier)
 *   and renders SendChurnSaveOfferForm with a bound server action stub (real
 *   action implemented in T5). Also warns if the user already has an active
 *   churn-save offer (the RPC will reject a duplicate, but surfacing it here
 *   saves the admin a round-trip).
 *
 * WHY early duplicate offer warning:
 *   The admin_send_churn_save_offer RPC has a partial unique index check
 *   preventing duplicate active offers. If we detect an existing active offer
 *   here (server component, before the form renders), we surface a contextual
 *   warning — the admin can decide to revoke the existing one first via the
 *   billing dossier. This is UX, not a security gate (the gate is in the RPC).
 *
 * WHY createAdminClient:
 *   Profiles, subscriptions, and churn_save_offers are RLS-scoped or service-role
 *   only. Service role is required. SOC 2 CC6.1.
 */

import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, AlertTriangle } from 'lucide-react';
import { createAdminClient } from '@/lib/supabase/server';
import { resolveAdminEmails } from '@/lib/admin/resolveEmails';
import { SendChurnSaveOfferForm } from '@/components/admin/SendChurnSaveOfferForm';
import { sendChurnSaveOfferAction } from '../actions';

// ─── UUID validation ──────────────────────────────────────────────────────────

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Types ────────────────────────────────────────────────────────────────────

interface ChurnSavePageProps {
  params: Promise<{ userId: string }>;
}

// ─── Page ─────────────────────────────────────────────────────────────────────

/**
 * Send Churn-Save Offer page.
 *
 * Validates userId, fetches user context and active offer status, renders form.
 * Surfaces a contextual warning if an active offer already exists.
 *
 * @param params - Next.js 15 async route params.
 */
export default async function SendChurnSaveOfferPage({ params }: ChurnSavePageProps) {
  const { userId } = await params;

  if (!UUID_REGEX.test(userId)) {
    notFound();
  }

  // WHY createAdminClient: all tables need service role for cross-user reads.
  // SOC 2 CC6.1.
  const adminDb = createAdminClient();
  const now = new Date().toISOString();

  // WHY resolveAdminEmails: profiles has no email column — H27 drift fix.
  const [{ data: profileExists }, emailMap] = await Promise.all([
    adminDb.from('profiles').select('id').eq('id', userId).maybeSingle(),
    resolveAdminEmails(adminDb, [userId]),
  ]);

  if (!profileExists) {
    notFound();
  }

  const profile = { email: emailMap[userId] ?? null };

  // Check for an existing active offer — for UX warning only (not a gate).
  // WHY check here: saves the admin a wasted form submission + server round-trip
  // when an active offer already exists. The RPC still enforces the constraint.
  const { data: existingOffer } = await adminDb
    .from('churn_save_offers')
    .select('id, kind, expires_at')
    .eq('user_id', userId)
    .is('accepted_at', null)
    .is('revoked_at', null)
    .gt('expires_at', now)
    .maybeSingle();

  // Fetch subscription tier for context display.
  // WHY is_annual (not billing_cycle): subscriptions has no billing_cycle column. H27.
  const { data: sub } = await adminDb
    .from('subscriptions')
    .select('tier, is_annual')
    .eq('user_id', userId)
    .maybeSingle();

  // WHY bind pattern (Fix B from Phase 4.1): the action is bound with userId so
  // it receives the unforgeable URL param as its first argument. The action's
  // URL cross-check rejects any FormData.targetUserId that differs from this
  // bound value, preventing mutations on the wrong user. billing/actions.ts.
  const boundAction = sendChurnSaveOfferAction.bind(null, userId);

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

      <h1 className="mb-2 text-xl font-bold text-zinc-100">Send churn-save offer</h1>
      <p className="mb-1 text-sm text-zinc-500">
        For:{' '}
        <span className="font-mono text-zinc-300">{profile.email ?? userId}</span>
      </p>
      {sub && (
        <p className="mb-6 text-sm text-zinc-500">
          Current tier:{' '}
          <span className="font-medium text-zinc-300">
            {sub.tier ?? 'unknown'} / {sub.is_annual ? 'annual' : 'monthly'}
          </span>
        </p>
      )}

      {/* WHY contextual warning: if active offer exists, surfacing it here saves
          the admin a wasted form submission. The RPC enforces the constraint regardless.
          This is a convenience UI signal, not a security gate. */}
      {existingOffer && (
        <div
          className="mb-6 flex items-start gap-3 rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-sm text-amber-400"
          role="alert"
          data-testid="existing-offer-warning"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>
            This user already has an active{' '}
            <span className="font-mono text-xs">{existingOffer.kind}</span> offer (id:{' '}
            {existingOffer.id}). Sending a new offer will fail — revoke the existing one first
            via the billing dossier.
          </span>
        </div>
      )}

      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
        <SendChurnSaveOfferForm targetUserId={userId} action={boundAction} />
      </div>
    </div>
  );
}
