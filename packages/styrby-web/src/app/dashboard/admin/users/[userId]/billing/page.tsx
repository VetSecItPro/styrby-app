/**
 * Billing Dossier Page — `/dashboard/admin/users/[userId]/billing`
 *
 * @route GET /dashboard/admin/users/[userId]/billing
 * @auth Required — site admin only, enforced by:
 *   1. `src/middleware.ts` — 404 for non-site-admins (route hiding)
 *   2. `src/app/dashboard/admin/layout.tsx` — redirects non-site-admins
 *   This page assumes both gates have already passed. SOC 2 CC6.1.
 *
 * Purpose:
 *   Server Component orchestrator for the billing dossier. Displays:
 *   - Current subscription summary
 *   - Last 10 refund events (polar_refund_events)
 *   - Active credits (billing_credits — unapplied + unrevoked)
 *   - Last 20 credits (all states)
 *   - Active churn-save offers (unexpired + unaccepted + unrevoked)
 *   - Last 10 churn-save offers (all states)
 *
 * WHY four separate Suspense boundaries:
 *   Each section has independent DB latency. Wrapping each in its own Suspense
 *   boundary means the subscription section renders as soon as its query resolves,
 *   independently of the slower churn-save or credit queries. This is the same
 *   "parallel card streaming" pattern used in UserDossier.tsx (Phase 4.1 T5).
 *
 * WHY createAdminClient() for all reads:
 *   polar_refund_events is service-role only (no RLS for authenticated).
 *   billing_credits and churn_save_offers have admin SELECT policies but using
 *   service role here is consistent and avoids session-cookie dependencies in
 *   Server Components. SOC 2 CC6.1.
 *
 * Action buttons link to sub-routes (forms implemented as separate pages):
 *   - /billing/refund — IssueRefundForm
 *   - /billing/credit — IssueCreditForm
 *   - /billing/churn-save — SendChurnSaveOfferForm
 */

import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Suspense } from 'react';
import { ArrowLeft, CreditCard, RotateCcw, Gift, TrendingDown, AlertTriangle } from 'lucide-react';
import { createAdminClient } from '@/lib/supabase/server';
import { fmtDate, fmtDateTime } from '@/components/admin/dossier/formatters';

// ─── UUID validation ──────────────────────────────────────────────────────────

/**
 * RFC 4122 UUID regex — rejects non-UUID userId params before any DB query.
 * Defense-in-depth: Postgres would also reject them, but we reject sooner.
 */
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Types ────────────────────────────────────────────────────────────────────

interface BillingDossierPageProps {
  params: Promise<{ userId: string }>;
}

// ─── Shared skeleton ──────────────────────────────────────────────────────────

/**
 * Pulse-skeleton used as the Suspense fallback for each section card.
 *
 * WHY role="status" + sr-only: screen readers need a live region to announce
 * pending content. WCAG 2.1 SC 4.1.3.
 */
function SectionSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading section"
      className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-5 animate-pulse"
      data-testid="section-skeleton"
    >
      <span className="sr-only">Loading…</span>
      <div aria-hidden="true" className="space-y-2">
        <div className="h-4 w-1/4 rounded bg-zinc-800" />
        <div className="h-3 w-2/3 rounded bg-zinc-800/60" />
        <div className="h-3 w-1/2 rounded bg-zinc-800/60" />
      </div>
    </div>
  );
}

// ─── Section: Subscription ────────────────────────────────────────────────────

/**
 * Fetches and renders the current subscription row for the target user.
 *
 * WHY separate async component: each section has independent DB latency.
 * Streaming via Suspense lets this section appear without waiting for refunds.
 *
 * @param userId - Validated UUID of the target user.
 */
async function SubscriptionSection({ userId }: { userId: string }) {
  const adminDb = createAdminClient();

  const { data: sub, error } = await adminDb
    .from('subscriptions')
    .select('tier, billing_cycle, current_period_end, override_source, updated_at')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    console.error('[BillingDossier] subscriptions query failed:', error.message);
    return (
      <div
        className="rounded-lg border border-red-500/20 bg-red-500/5 p-4"
        data-testid="subscription-section-error"
      >
        <div className="flex items-center gap-2 text-sm text-red-400">
          <AlertTriangle size={16} aria-hidden="true" />
          <span>Failed to load subscription data. Check DB health or Sentry.</span>
        </div>
      </div>
    );
  }

  return (
    <div
      className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5"
      data-testid="subscription-section"
    >
      <div className="mb-4 flex items-center gap-2">
        <CreditCard className="h-4 w-4 text-zinc-400" aria-hidden="true" />
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">
          Current Subscription
        </h2>
      </div>
      {sub ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="text-zinc-500">Tier</dt>
          <dd className="font-medium text-zinc-100" data-testid="subscription-tier">
            {sub.tier ?? '—'}
          </dd>
          <dt className="text-zinc-500">Billing cycle</dt>
          <dd className="text-zinc-300">{sub.billing_cycle ?? '—'}</dd>
          <dt className="text-zinc-500">Period end</dt>
          <dd className="text-zinc-300">{fmtDate(sub.current_period_end)}</dd>
          <dt className="text-zinc-500">Override source</dt>
          <dd className="font-mono text-xs text-zinc-300">{sub.override_source ?? '—'}</dd>
          <dt className="text-zinc-500">Updated</dt>
          <dd className="text-xs text-zinc-500">{fmtDateTime(sub.updated_at)}</dd>
        </dl>
      ) : (
        <p className="text-sm text-zinc-500" data-testid="no-subscription">
          No subscription record found.
        </p>
      )}
    </div>
  );
}

// ─── Section: Refunds ────────────────────────────────────────────────────────

/**
 * Fetches and renders the last 10 refund events for the target user.
 *
 * @param userId - Validated UUID of the target user.
 */
async function RefundsSection({ userId }: { userId: string }) {
  const adminDb = createAdminClient();

  const { data: refunds, error } = await adminDb
    .from('polar_refund_events')
    .select('event_id, refund_id, amount_cents, currency, reason, processed_at, actor_id')
    .eq('target_user_id', userId)
    .order('processed_at', { ascending: false })
    .limit(10);

  if (error) {
    console.error('[BillingDossier] polar_refund_events query failed:', error.message);
    return (
      <div
        className="rounded-lg border border-red-500/20 bg-red-500/5 p-4"
        data-testid="refunds-section-error"
      >
        <div className="flex items-center gap-2 text-sm text-red-400">
          <AlertTriangle size={16} aria-hidden="true" />
          <span>Failed to load refund data. Check DB health or Sentry.</span>
        </div>
      </div>
    );
  }

  return (
    <div
      className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5"
      data-testid="refunds-section"
    >
      <div className="mb-4 flex items-center gap-2">
        <RotateCcw className="h-4 w-4 text-zinc-400" aria-hidden="true" />
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">
          Recent Refunds
        </h2>
        <span className="ml-auto text-xs text-zinc-600">Last 10</span>
      </div>
      {refunds && refunds.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="refunds-table">
            <thead>
              <tr className="border-b border-zinc-800 text-left text-xs text-zinc-500">
                <th className="pb-2 pr-4 font-medium">Amount</th>
                <th className="pb-2 pr-4 font-medium">Reason</th>
                <th className="pb-2 pr-4 font-medium">Date</th>
                <th className="pb-2 font-medium">Refund ID</th>
              </tr>
            </thead>
            <tbody>
              {refunds.map((r) => (
                <tr
                  key={r.event_id}
                  className="border-b border-zinc-800/50 last:border-0"
                  data-testid="refund-row"
                >
                  <td className="py-2 pr-4 font-mono text-zinc-100">
                    ${((r.amount_cents ?? 0) / 100).toFixed(2)}
                  </td>
                  <td className="py-2 pr-4 text-zinc-300 max-w-[200px] truncate" title={r.reason}>
                    {r.reason}
                  </td>
                  <td className="py-2 pr-4 text-zinc-400 text-xs">
                    {fmtDateTime(r.processed_at)}
                  </td>
                  <td className="py-2 font-mono text-xs text-zinc-500 truncate max-w-[100px]">
                    {r.refund_id}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-zinc-500" data-testid="no-refunds">
          No refunds on record.
        </p>
      )}
    </div>
  );
}

// ─── Section: Credits ─────────────────────────────────────────────────────────

/**
 * Fetches and renders active credits and last 20 credits (all states).
 *
 * @param userId - Validated UUID of the target user.
 */
async function CreditsSection({ userId }: { userId: string }) {
  const adminDb = createAdminClient();

  const { data: credits, error } = await adminDb
    .from('billing_credits')
    .select(
      'id, amount_cents, currency, reason, granted_at, applied_at, expires_at, revoked_at, granted_by'
    )
    .eq('user_id', userId)
    .order('granted_at', { ascending: false })
    .limit(20);

  if (error) {
    console.error('[BillingDossier] billing_credits query failed:', error.message);
    return (
      <div
        className="rounded-lg border border-red-500/20 bg-red-500/5 p-4"
        data-testid="credits-section-error"
      >
        <div className="flex items-center gap-2 text-sm text-red-400">
          <AlertTriangle size={16} aria-hidden="true" />
          <span>Failed to load credits data. Check DB health or Sentry.</span>
        </div>
      </div>
    );
  }

  const activeCredits = (credits ?? []).filter(
    (c) => c.applied_at === null && c.revoked_at === null
  );

  return (
    <div
      className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5"
      data-testid="credits-section"
    >
      <div className="mb-4 flex items-center gap-2">
        <Gift className="h-4 w-4 text-zinc-400" aria-hidden="true" />
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">
          Account Credits
        </h2>
        {activeCredits.length > 0 && (
          <span
            className="ml-auto inline-flex items-center rounded-full bg-green-500/10 px-2 py-0.5 text-xs font-medium text-green-400"
            data-testid="active-credits-badge"
          >
            {activeCredits.length} active
          </span>
        )}
      </div>
      {credits && credits.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="credits-table">
            <thead>
              <tr className="border-b border-zinc-800 text-left text-xs text-zinc-500">
                <th className="pb-2 pr-4 font-medium">Amount</th>
                <th className="pb-2 pr-4 font-medium">State</th>
                <th className="pb-2 pr-4 font-medium">Reason</th>
                <th className="pb-2 font-medium">Granted</th>
              </tr>
            </thead>
            <tbody>
              {credits.map((c) => {
                const isActive = c.applied_at === null && c.revoked_at === null;
                const stateLabel = c.revoked_at
                  ? 'Revoked'
                  : c.applied_at
                  ? 'Applied'
                  : 'Active';
                const stateClass = c.revoked_at
                  ? 'text-zinc-500'
                  : c.applied_at
                  ? 'text-blue-400'
                  : 'text-green-400';

                return (
                  <tr
                    key={c.id}
                    className="border-b border-zinc-800/50 last:border-0"
                    data-testid="credit-row"
                  >
                    <td className="py-2 pr-4 font-mono text-zinc-100">
                      ${((c.amount_cents ?? 0) / 100).toFixed(2)}
                    </td>
                    <td className={`py-2 pr-4 text-xs font-medium ${stateClass}`}>
                      {stateLabel}
                    </td>
                    <td
                      className="py-2 pr-4 text-zinc-300 max-w-[200px] truncate"
                      title={c.reason}
                    >
                      {c.reason}
                    </td>
                    <td className="py-2 text-zinc-400 text-xs whitespace-nowrap">
                      {fmtDate(c.granted_at)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-zinc-500" data-testid="no-credits">
          No credits on record.
        </p>
      )}
    </div>
  );
}

// ─── Section: Churn-save offers ───────────────────────────────────────────────

/**
 * Fetches and renders active churn-save offers and last 10 (all states).
 *
 * @param userId - Validated UUID of the target user.
 */
async function ChurnSaveOffersSection({ userId }: { userId: string }) {
  const adminDb = createAdminClient();
  const now = new Date().toISOString();

  // Active offers: unaccepted + unrevoked + not expired
  const { data: activeOffers, error: activeErr } = await adminDb
    .from('churn_save_offers')
    .select('id, kind, discount_pct, discount_duration_months, sent_at, expires_at, polar_discount_code')
    .eq('user_id', userId)
    .is('accepted_at', null)
    .is('revoked_at', null)
    .gt('expires_at', now)
    .order('sent_at', { ascending: false });

  // Recent offers (all states, last 10)
  const { data: recentOffers, error: recentErr } = await adminDb
    .from('churn_save_offers')
    .select(
      'id, kind, discount_pct, discount_duration_months, sent_at, expires_at, accepted_at, revoked_at, reason'
    )
    .eq('user_id', userId)
    .order('sent_at', { ascending: false })
    .limit(10);

  if (activeErr || recentErr) {
    const errMsg = (activeErr ?? recentErr)?.message;
    console.error('[BillingDossier] churn_save_offers query failed:', errMsg);
    return (
      <div
        className="rounded-lg border border-red-500/20 bg-red-500/5 p-4"
        data-testid="churn-offers-section-error"
      >
        <div className="flex items-center gap-2 text-sm text-red-400">
          <AlertTriangle size={16} aria-hidden="true" />
          <span>Failed to load churn-save offer data. Check DB health or Sentry.</span>
        </div>
      </div>
    );
  }

  return (
    <div
      className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5"
      data-testid="churn-offers-section"
    >
      <div className="mb-4 flex items-center gap-2">
        <TrendingDown className="h-4 w-4 text-zinc-400" aria-hidden="true" />
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">
          Churn-Save Offers
        </h2>
        {activeOffers && activeOffers.length > 0 && (
          <span
            className="ml-auto inline-flex items-center rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-400"
            data-testid="active-offers-badge"
          >
            {activeOffers.length} active
          </span>
        )}
      </div>
      {recentOffers && recentOffers.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="churn-offers-table">
            <thead>
              <tr className="border-b border-zinc-800 text-left text-xs text-zinc-500">
                <th className="pb-2 pr-4 font-medium">Kind</th>
                <th className="pb-2 pr-4 font-medium">State</th>
                <th className="pb-2 pr-4 font-medium">Sent</th>
                <th className="pb-2 font-medium">Expires</th>
              </tr>
            </thead>
            <tbody>
              {recentOffers.map((o) => {
                const expired = new Date(o.expires_at) <= new Date();
                const stateLabel = o.revoked_at
                  ? 'Revoked'
                  : o.accepted_at
                  ? 'Accepted'
                  : expired
                  ? 'Expired'
                  : 'Active';
                const stateClass = o.revoked_at
                  ? 'text-zinc-500'
                  : o.accepted_at
                  ? 'text-green-400'
                  : expired
                  ? 'text-zinc-500'
                  : 'text-amber-400';

                return (
                  <tr
                    key={o.id}
                    className="border-b border-zinc-800/50 last:border-0"
                    data-testid="churn-offer-row"
                  >
                    <td className="py-2 pr-4 font-mono text-xs text-zinc-300">{o.kind}</td>
                    <td className={`py-2 pr-4 text-xs font-medium ${stateClass}`}>
                      {stateLabel}
                    </td>
                    <td className="py-2 pr-4 text-zinc-400 text-xs whitespace-nowrap">
                      {fmtDate(o.sent_at)}
                    </td>
                    <td className="py-2 text-zinc-400 text-xs whitespace-nowrap">
                      {fmtDate(o.expires_at)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-zinc-500" data-testid="no-churn-offers">
          No churn-save offers on record.
        </p>
      )}
    </div>
  );
}

// ─── Page Component ───────────────────────────────────────────────────────────

/**
 * Billing Dossier page.
 *
 * Validates userId UUID, confirms profile exists, then renders 4 Suspense-wrapped
 * sections (subscription, refunds, credits, churn-save offers) and 3 action buttons.
 *
 * @param params - Next.js 15 async route params.
 */
export default async function BillingDossierPage({ params }: BillingDossierPageProps) {
  const { userId } = await params;

  // ── 1. Validate UUID ──────────────────────────────────────────────────────

  if (!UUID_REGEX.test(userId)) {
    // WHY notFound: malformed UUID is a client error, not a server error.
    // 404 surface via the nearest not-found.tsx. SOC 2 CC6.1.
    notFound();
  }

  // ── 2. Confirm user exists ────────────────────────────────────────────────

  // WHY createAdminClient: profiles are RLS-scoped to auth.uid(). Service role
  // is required to look up any user's profile. SOC 2 CC6.1.
  const adminDb = createAdminClient();

  const { data: profile, error: profileErr } = await adminDb
    .from('profiles')
    .select('id, email')
    .eq('id', userId)
    .maybeSingle();

  if (profileErr) {
    console.error('[BillingDossierPage] profile lookup failed:', profileErr.message);
    notFound();
  }

  if (!profile) {
    notFound();
  }

  // ── 3. Render ─────────────────────────────────────────────────────────────

  return (
    <div>
      {/* Header */}
      <div className="mb-6">
        <Link
          href={`/dashboard/admin/users/${userId}`}
          className="mb-4 inline-flex items-center gap-2 text-sm text-zinc-400 transition-colors hover:text-zinc-100"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to user dossier
        </Link>

        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1
              className="text-2xl font-bold text-foreground"
              data-testid="billing-dossier-title"
            >
              Billing — {profile.email ?? userId}
            </h1>
            <p className="mt-0.5 font-mono text-xs text-zinc-400">{userId}</p>
          </div>

          {/* Action buttons — link to sub-route form pages */}
          <div className="flex flex-wrap gap-2" data-testid="action-buttons">
            <Link
              href={`/dashboard/admin/users/${userId}/billing/refund`}
              className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm font-medium text-zinc-300 transition-colors hover:border-zinc-500 hover:text-zinc-100"
              data-testid="action-issue-refund"
            >
              + Issue refund
            </Link>
            <Link
              href={`/dashboard/admin/users/${userId}/billing/credit`}
              className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm font-medium text-zinc-300 transition-colors hover:border-zinc-500 hover:text-zinc-100"
              data-testid="action-issue-credit"
            >
              + Issue credit
            </Link>
            <Link
              href={`/dashboard/admin/users/${userId}/billing/churn-save`}
              className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm font-medium text-zinc-300 transition-colors hover:border-zinc-500 hover:text-zinc-100"
              data-testid="action-send-churn-save"
            >
              + Send churn-save offer
            </Link>
          </div>
        </div>
      </div>

      {/* Sections — each has an independent Suspense boundary for parallel streaming */}
      <div className="flex flex-col gap-4">
        {/* WHY Suspense per section: if refunds query is slow (Polar data volume),
            the subscription section renders immediately. The admin sees critical tier
            info without waiting for all four queries to complete. Phase 4.1 T5 pattern. */}
        <Suspense fallback={<SectionSkeleton />}>
          <SubscriptionSection userId={userId} />
        </Suspense>

        <Suspense fallback={<SectionSkeleton />}>
          <RefundsSection userId={userId} />
        </Suspense>

        <Suspense fallback={<SectionSkeleton />}>
          <CreditsSection userId={userId} />
        </Suspense>

        <Suspense fallback={<SectionSkeleton />}>
          <ChurnSaveOffersSection userId={userId} />
        </Suspense>
      </div>
    </div>
  );
}
