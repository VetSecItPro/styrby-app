/**
 * SubscriptionCard — Subscription tier and override details sub-card.
 *
 * Purpose:
 *   Displays the user's current subscription state from the `subscriptions`
 *   table: tier, override_source, override_expires_at, override_reason, and
 *   billing_cycle/current_period_end. Highlights manual overrides with an
 *   orange badge so ops staff immediately knows this user's tier will NOT be
 *   overwritten by the next Polar webhook.
 *
 * Auth model:
 *   Rendered inside `UserDossier` which is gated by the admin layout.
 *   Uses `createAdminClient()` (service role) to bypass RLS on the
 *   `subscriptions` table. SOC 2 CC6.1.
 *
 * Query shape:
 *   Single row from `subscriptions` WHERE user_id = userId:
 *   tier, override_source, override_expires_at, override_reason,
 *   billing_cycle, current_period_end, updated_at.
 *
 * WHY independent Suspense fetch:
 *   SubscriptionCard resolves as soon as the subscriptions query finishes,
 *   independent of SessionsCard or RecentAuditCard. Slow audit queries never
 *   block the admin from seeing the critical tier-override status.
 *   See UserDossier.tsx for the full Suspense parallelism rationale.
 *
 * @param userId - UUID of the user being viewed.
 */

import { createAdminClient } from '@/lib/supabase/server';
import { CreditCard, AlertTriangle } from 'lucide-react';
import { fmtDate } from './formatters';

/** Maps subscription tier strings to Tailwind badge classes. */
const TIER_COLORS: Record<string, string> = {
  free: 'bg-zinc-700/50 text-zinc-400',
  pro: 'bg-blue-500/10 text-blue-400',
  power: 'bg-amber-500/10 text-amber-400',
  team: 'bg-purple-500/10 text-purple-400',
  business: 'bg-green-500/10 text-green-400',
  enterprise: 'bg-red-500/10 text-red-400',
};

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Server Component: fetches and renders the subscription state for a user.
 *
 * @param userId - UUID of the user being viewed.
 */
export async function SubscriptionCard({ userId }: { userId: string }) {
  // WHY createAdminClient: subscriptions are owned by the target user.
  // The user-scoped client (anon key + RLS) would only return the calling
  // admin's own subscription row — not the target user's. Service role is
  // required. SOC 2 CC6.1.
  const adminDb = createAdminClient();

  const { data: sub, error } = await adminDb
    .from('subscriptions')
    .select(
      'tier, override_source, override_expires_at, override_reason, billing_cycle, current_period_end, updated_at'
    )
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    // WHY not throw: a DB error on a single card should not crash the entire
    // dossier. Render an explicit error state; the rest of the dossier stays live.
    // An admin MUST be able to distinguish "query failed" from "no subscription row"
    // — silently falling through to the null render path hides ops-critical failures.
    console.error('[SubscriptionCard] failed to load data', error);
    return (
      <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-4" data-testid="subscription-card-error">
        <div className="flex items-center gap-2 text-sm text-red-400">
          <AlertTriangle size={16} aria-hidden="true" />
          <span>Failed to load subscription data. Check audit logs or DB health.</span>
        </div>
      </div>
    );
  }

  const tierLabel = sub?.tier ?? 'none';
  const tierBadgeClass = TIER_COLORS[tierLabel] ?? 'bg-zinc-700/50 text-zinc-400';

  // WHY manual override detection logic: when override_source = 'manual',
  // the Polar webhook is suppressed (see spec §4). This is critical ops info —
  // an admin debugging unexpected tier state MUST see this immediately.
  const isManualOverride = sub?.override_source === 'manual';
  const overrideExpired =
    isManualOverride &&
    sub?.override_expires_at != null &&
    new Date(sub.override_expires_at) <= new Date();

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5" data-testid="subscription-card">
      {/* Card header */}
      <div className="mb-4 flex items-center gap-2">
        <CreditCard className="h-4 w-4 text-zinc-400" aria-hidden="true" />
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">
          Subscription
        </h2>

        {isManualOverride && !overrideExpired && (
          /* WHY warning: manual override means Polar webhooks are silently
             ignored for this user. If the admin doesn't see this badge, they
             may be confused why Polar's subscription change has no effect.
             The AlertTriangle icon escalates visual salience. Spec §4. */
          <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-orange-500/10 px-2 py-0.5 text-xs font-medium text-orange-400" data-testid="manual-override-badge">
            <AlertTriangle className="h-3 w-3" aria-hidden="true" />
            Manual override active
          </span>
        )}

        {isManualOverride && overrideExpired && (
          <span className="ml-auto inline-flex items-center rounded-full bg-zinc-700/50 px-2 py-0.5 text-xs font-medium text-zinc-500" data-testid="manual-override-expired-badge">
            Override expired
          </span>
        )}
      </div>

      {sub ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="text-zinc-500">Tier</dt>
          <dd>
            <span
              className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${tierBadgeClass}`}
              data-testid="subscription-tier"
            >
              {tierLabel}
            </span>
          </dd>

          <dt className="text-zinc-500">Override source</dt>
          <dd className="font-mono text-xs text-zinc-300" data-testid="override-source">
            {sub.override_source ?? '—'}
          </dd>

          {isManualOverride && (
            <>
              <dt className="text-zinc-500">Override expires</dt>
              <dd
                className="text-zinc-300"
                data-testid="override-expires-at"
                title={sub.override_expires_at ?? ''}
              >
                {sub.override_expires_at ? fmtDate(sub.override_expires_at) : 'Never (permanent)'}
              </dd>

              {sub.override_reason && (
                <>
                  <dt className="text-zinc-500">Override reason</dt>
                  <dd
                    className="text-zinc-300"
                    data-testid="override-reason"
                  >
                    {/* WHY JSX text: React escapes this automatically.
                        override_reason is admin-supplied free text from the
                        T6 form — rendered safely via JSX, no dangerouslySetInnerHTML. */}
                    {sub.override_reason}
                  </dd>
                </>
              )}
            </>
          )}

          <dt className="text-zinc-500">Billing cycle</dt>
          <dd className="text-zinc-300" data-testid="billing-cycle">
            {sub.billing_cycle ?? '—'}
          </dd>

          <dt className="text-zinc-500">Period end</dt>
          <dd className="text-zinc-300" title={sub.current_period_end ?? ''}>
            {fmtDate(sub.current_period_end)}
          </dd>

          <dt className="text-zinc-500">Updated</dt>
          <dd className="text-zinc-500 text-xs" title={sub.updated_at ?? ''}>
            {fmtDate(sub.updated_at)}
          </dd>
        </dl>
      ) : (
        <p className="text-sm text-zinc-500" data-testid="no-subscription">
          No subscription record found.
        </p>
      )}
    </div>
  );
}
