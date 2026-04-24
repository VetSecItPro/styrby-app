/**
 * Issue Refund Page — `/dashboard/admin/users/[userId]/billing/refund`
 *
 * @route GET /dashboard/admin/users/[userId]/billing/refund
 * @auth Required — site admin only, enforced by:
 *   1. `src/middleware.ts` — 404 for non-site-admins
 *   2. `src/app/dashboard/admin/layout.tsx` — redirects non-site-admins
 *   3. `admin_issue_refund` RPC — SECURITY DEFINER enforces is_site_admin()
 * SOC 2 CC6.1.
 *
 * Purpose:
 *   Server Component that fetches target user context (email, recent
 *   subscriptions) and renders IssueRefundForm with a bound server action.
 *
 * WHY fetch subscriptions here:
 *   The form's subscription select is populated from the user's subscription
 *   row (subscription_id is the only available Polar reference in our DB).
 *   This is a convenience — the actual refund requires an orderId resolved by
 *   the admin separately via Polar dashboard (see polar-refund.ts). The select
 *   here provides a human-readable subscription reference for the audit trail.
 *
 * WHY createAdminClient:
 *   subscriptions and profiles are RLS-scoped to auth.uid(). Service role is
 *   required to read any user's rows.
 */

import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { createAdminClient } from '@/lib/supabase/server';
import { IssueRefundForm, type SubscriptionOption } from '@/components/admin/IssueRefundForm';
import { issueRefundAction } from '../actions';

// ─── UUID validation ──────────────────────────────────────────────────────────

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Types ────────────────────────────────────────────────────────────────────

interface RefundPageProps {
  params: Promise<{ userId: string }>;
}

// ─── Page ─────────────────────────────────────────────────────────────────────

/**
 * Issue Refund page.
 *
 * Validates userId, fetches user context and subscriptions, renders form.
 *
 * @param params - Next.js 15 async route params.
 */
export default async function IssueRefundPage({ params }: RefundPageProps) {
  const { userId } = await params;

  if (!UUID_REGEX.test(userId)) {
    notFound();
  }

  // WHY createAdminClient: profiles + subscriptions RLS-scoped to auth.uid().
  // Service role needed to read any user's rows. SOC 2 CC6.1.
  const adminDb = createAdminClient();

  // Fetch profile for context display
  const { data: profile } = await adminDb
    .from('profiles')
    .select('email')
    .eq('id', userId)
    .maybeSingle();

  if (!profile) {
    notFound();
  }

  // Fetch user's subscriptions to populate the select
  // WHY select polar_subscription_id: this is the Polar-side reference the admin
  // will cross-reference in the Polar dashboard to get the orderId for refund.
  const { data: subRows } = await adminDb
    .from('subscriptions')
    .select('polar_subscription_id, tier, billing_cycle')
    .eq('user_id', userId);

  const subscriptionOptions: SubscriptionOption[] = (subRows ?? [])
    .filter((s): s is typeof s & { polar_subscription_id: string } =>
      typeof s.polar_subscription_id === 'string' && s.polar_subscription_id.length > 0
    )
    .map((s) => ({
      id: s.polar_subscription_id,
      label: `${s.tier ?? 'unknown'} — ${s.billing_cycle ?? 'unknown'} (${s.polar_subscription_id})`,
    }));

  // WHY bind userId server-side (Fix B pattern from Phase 4.1):
  // The bound action receives the unforgeable URL userId as its first argument.
  // FormData.targetUserId is cross-checked against this bound value in billing/actions.ts.
  const boundAction = issueRefundAction.bind(null, userId);

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

      <h1 className="mb-2 text-xl font-bold text-zinc-100">Issue refund</h1>
      <p className="mb-6 text-sm text-zinc-500">
        For:{' '}
        <span className="font-mono text-zinc-300">{profile.email ?? userId}</span>
      </p>

      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
        <IssueRefundForm
          targetUserId={userId}
          subscriptionOptions={subscriptionOptions}
          action={boundAction}
        />
      </div>
    </div>
  );
}
