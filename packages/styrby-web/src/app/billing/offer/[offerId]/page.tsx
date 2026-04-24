/**
 * /billing/offer/[offerId] — User-facing churn-save offer acceptance page.
 *
 * Phase 4.3 — Billing Ops T6
 *
 * This Server Component is the entry point for the churn-save win-back flow:
 * when an admin sends a churn-save offer, the user receives a notification
 * linking to this page where they can accept the discounted offer.
 *
 * Rendering contract:
 *   - Active (not yet accepted, not revoked, not expired): show discount %, duration,
 *     expires_at, reason (200-char truncated), and "Accept offer" button.
 *   - Accepted: show accepted_at timestamp and polar_discount_code (if any).
 *   - Revoked: show revoked_at timestamp (terminal state).
 *   - Expired: show expires_at timestamp (terminal state).
 *   - Not found (0 rows from RLS) or invalid offerId → Next.js `notFound()`.
 *
 * Security:
 *   - Middleware gates /billing/offer/* — unauthenticated users are redirected
 *     to /login?redirect=/billing/offer/[offerId].
 *   - Supabase RLS policy `churn_save_offers_select_self` restricts SELECT
 *     to offers where user_id = auth.uid(). A user visiting another user's offer
 *     URL gets 0 rows → notFound() — indistinguishable from "not found".
 *   - The offerId is validated as a bigint (positive integer) before querying.
 *   - The accept action is bound server-side via `.bind(null, offerId)` so the
 *     offerId cannot be tampered through client-side FormData.
 *
 * Cache:
 *   Cache-Control: private, no-cache, no-store is set via next.config.ts headers()
 *   for /billing/offer/:path* — this page must never be served from cache as it
 *   contains personalized authenticated offer data.
 *
 * SOC 2 CC6.1: access requires authenticated session + RLS ownership check.
 * SOC 2 CC7.2: every acceptance is audited by SECURITY DEFINER RPCs.
 *
 * @module app/billing/offer/[offerId]/page
 */

import { notFound } from 'next/navigation';
import { Tag, CheckCircle, ShieldOff, Clock, AlertTriangle } from 'lucide-react';
import { createClient } from '@/lib/supabase/server';
import { acceptOfferAction } from './actions';
import { ChurnSaveOfferCard } from '@/components/billing/ChurnSaveOfferCard';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Valid churn offer kind values from the churn_offer_kind DB enum.
 *
 * WHY typed here: the DB enum is the source of truth, but typing it here
 * gives compile-time guarantees that the page handles all valid kinds.
 */
export type ChurnOfferKind = 'annual_3mo_25pct' | 'monthly_1mo_50pct';

/**
 * A churn_save_offers row fetched for the user-facing page.
 *
 * WHY these exact columns:
 *   - `sent_by` is excluded — admin identity must not be surfaced to users.
 *   - `user_id` is excluded — it matches auth.uid() by RLS; no need to display.
 *   - We include `polar_discount_code` so the accepted state can display it for
 *     manual application if the user wants to apply the code themselves.
 */
export interface OfferRow {
  id: number;
  kind: ChurnOfferKind;
  discount_pct: number;
  discount_duration_months: number;
  sent_at: string;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
  polar_discount_code: string | null;
  reason: string;
}

// ─── Route params type ────────────────────────────────────────────────────────

interface PageProps {
  params: Promise<{ offerId: string }>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Formats a date string for user-facing display.
 *
 * @param iso - ISO 8601 date string.
 * @returns Human-readable date + time string in the user's locale.
 */
function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

/**
 * Computes the offer status from the row data.
 *
 * WHY derived here rather than stored: `churn_save_offers` has no `status`
 * column (unlike `support_access_grants`). Status is derived from the nullable
 * timestamp fields and the expires_at comparison.
 *
 * @param offer - The offer row from Supabase.
 * @returns The derived status string.
 */
function deriveOfferStatus(offer: OfferRow): 'active' | 'accepted' | 'revoked' | 'expired' {
  if (offer.accepted_at !== null) return 'accepted';
  if (offer.revoked_at !== null) return 'revoked';
  // WHY <=: migration 051 admin_accept_churn_save_offer uses `expires_at <= now()`
  // (line 785) to gate acceptance, and migration 050 status comment documents
  // `expired: expires_at <= now()`. Using `<` here would show an offer as "active"
  // for the exact millisecond it expires, letting the user attempt to accept it
  // while the DB would reject with 22023. Match RPC semantics exactly.
  if (new Date(offer.expires_at) <= new Date()) return 'expired';
  return 'active';
}

/**
 * Builds a human-readable duration label from the discount_duration_months value.
 *
 * @param months - Number of discount months (1 or 3).
 * @returns Human-readable duration string.
 */
function formatDuration(months: number): string {
  return months === 1 ? '1 month' : `${months} months`;
}

// ─── State panels ─────────────────────────────────────────────────────────────

/**
 * Renders the accepted state panel with accepted_at and optional discount code.
 *
 * @param acceptedAt - ISO 8601 timestamp of acceptance.
 * @param discountCode - Polar discount code, if any.
 */
function AcceptedPanel({
  acceptedAt,
  discountCode,
}: {
  acceptedAt: string;
  discountCode: string | null;
}) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-green-500/20 bg-green-500/5 p-4">
      <CheckCircle className="mt-0.5 h-5 w-5 shrink-0 text-green-400" aria-hidden="true" />
      <div>
        <p className="text-sm font-medium text-green-300">Offer accepted</p>
        <p className="mt-1 text-sm text-green-300/70">
          You accepted this offer at {formatDate(acceptedAt)}.
        </p>
        {discountCode && (
          <p className="mt-2 text-sm text-green-300/70">
            Polar discount code:{' '}
            <code className="rounded bg-green-900/30 px-1.5 py-0.5 font-mono text-green-200">
              {discountCode}
            </code>{' '}
            if you want to apply it manually.
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Renders the revoked state panel.
 *
 * @param revokedAt - ISO 8601 timestamp of revocation.
 */
function RevokedPanel({ revokedAt }: { revokedAt: string }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-zinc-700 bg-zinc-800/50 p-4">
      <ShieldOff className="mt-0.5 h-5 w-5 shrink-0 text-zinc-400" aria-hidden="true" />
      <div>
        <p className="text-sm font-medium text-zinc-300">Offer revoked</p>
        <p className="mt-1 text-sm text-zinc-400">
          This offer was revoked at {formatDate(revokedAt)}.
        </p>
      </div>
    </div>
  );
}

/**
 * Renders the expired state panel.
 *
 * @param expiresAt - ISO 8601 timestamp of expiry.
 */
function ExpiredPanel({ expiresAt }: { expiresAt: string }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-zinc-700 bg-zinc-800/50 p-4">
      <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-zinc-400" aria-hidden="true" />
      <div>
        <p className="text-sm font-medium text-zinc-300">Offer expired</p>
        <p className="mt-1 text-sm text-zinc-400">
          This offer expired at {formatDate(expiresAt)}.
        </p>
      </div>
    </div>
  );
}

/**
 * Renders the active offer status panel (countdown reminder).
 *
 * @param expiresAt - ISO 8601 timestamp of expiry.
 */
function ActivePanel({ expiresAt }: { expiresAt: string }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-amber-500/20 bg-amber-500/5 p-4">
      <Clock className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" aria-hidden="true" />
      <div>
        <p className="text-sm font-medium text-amber-300">Limited-time offer</p>
        <p className="mt-1 text-sm text-amber-300/70">
          This offer expires {formatDate(expiresAt)}.
        </p>
      </div>
    </div>
  );
}

// ─── Offer detail ─────────────────────────────────────────────────────────────

/**
 * Renders the offer detail block (discount %, duration, reason).
 * Shown for all states so the user always has context on what the offer was.
 *
 * @param offer - The offer row from Supabase.
 */
function OfferDetails({ offer }: { offer: OfferRow }) {
  // WHY 200-char truncation with ellipsis: reason is admin-supplied text.
  // We show enough context for the user to understand the offer without
  // rendering an unbounded admin note in user-facing UI.
  const reason =
    offer.reason.length > 200 ? `${offer.reason.slice(0, 200)}…` : offer.reason;

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-5">
      <h2 className="mb-4 text-xs font-semibold uppercase tracking-wider text-zinc-500">
        Offer details
      </h2>

      <dl className="space-y-4">
        {/* Discount percentage — the primary incentive */}
        <div className="flex items-center gap-4">
          <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-indigo-500/10 ring-1 ring-indigo-500/20">
            <Tag className="h-6 w-6 text-indigo-400" aria-hidden="true" />
          </div>
          <div>
            <dt className="text-xs text-zinc-500">Discount</dt>
            <dd className="text-2xl font-bold text-zinc-100">{offer.discount_pct}% off</dd>
          </div>
        </div>

        {/* Duration */}
        <div>
          <dt className="text-xs text-zinc-500">Duration</dt>
          <dd className="mt-0.5 text-sm text-zinc-200">
            {formatDuration(offer.discount_duration_months)}
          </dd>
        </div>

        {/* Reason — why this offer was sent */}
        <div>
          <dt className="text-xs text-zinc-500">Why we&apos;re offering this</dt>
          <dd className="mt-0.5 text-sm leading-relaxed text-zinc-300">{reason}</dd>
        </div>

        {/* Expiry */}
        <div>
          <dt className="text-xs text-zinc-500">Offer expires</dt>
          <dd className="mt-0.5 text-sm text-zinc-300">{formatDate(offer.expires_at)}</dd>
        </div>
      </dl>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

/**
 * Server Component: renders the churn-save offer detail + acceptance UI.
 *
 * Data fetch:
 *   Uses the user-scoped Supabase client (createClient) so RLS enforces that
 *   only the offer recipient (user_id = auth.uid()) can SELECT this row. A user
 *   who navigates to an offer they don't own gets 0 rows → notFound().
 *
 * WHY we derive status rather than read it from a column:
 *   The churn_save_offers table has no `status` column — state is inferred from
 *   accepted_at, revoked_at, and expires_at timestamps. This mirrors the DB design
 *   where the partial index on (user_id, expires_at DESC) for active offers is
 *   the canonical "is active" check.
 *
 * @param params - Next.js dynamic route params (awaited for Next.js 15 async params).
 */
export default async function ChurnSaveOfferPage({ params }: PageProps) {
  // ── Await async params (Next.js 15 pattern) ────────────────────────────────
  const { offerId: offerIdParam } = await params;
  const offerId = parseInt(offerIdParam, 10);

  // WHY validate here: a non-numeric offerId (e.g. from a crafted URL) produces
  // NaN which Supabase would reject with a runtime error. We short-circuit to
  // notFound() for a cleaner, attack-surface-neutral response.
  // The spec calls this a "bigint check" — bigint PKs are positive integers only.
  if (!Number.isInteger(offerId) || offerId <= 0) {
    notFound();
  }

  // ── Fetch offer via user-scoped client (RLS enforced) ────────────────────
  // WHY createClient() (user-scoped): RLS policy `churn_save_offers_select_self`
  // enforces user_id = auth.uid(). A wrong user gets 0 rows → notFound().
  // The service-role client would bypass RLS and could expose any user's offer.
  const supabase = await createClient();

  const { data: offer, error } = await supabase
    .from('churn_save_offers')
    .select(
      `
      id,
      kind,
      discount_pct,
      discount_duration_months,
      sent_at,
      expires_at,
      accepted_at,
      revoked_at,
      polar_discount_code,
      reason
      `
    )
    .eq('id', offerId)
    .maybeSingle<OfferRow>();

  // WHY treat any error as notFound: a PGRST116 (no rows) is the expected 0-row
  // result for non-owned offers. Other errors (e.g., RLS policy error) should
  // not surface internal details to the user — notFound() is the safe response.
  if (error || !offer) {
    notFound();
  }

  // ── Derive offer status ────────────────────────────────────────────────────
  const status = deriveOfferStatus(offer);

  // ── Bind action server-side ────────────────────────────────────────────────
  // WHY .bind(null, offerId): the offerId flows from the URL, not from client
  // FormData. Binding server-side makes it unforgeable — the client component
  // receives a callable that already has the correct offerId embedded.
  const boundAccept = acceptOfferAction.bind(null, offerId);

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="mx-auto max-w-lg px-4 py-10 sm:px-6">
      {/* Page header */}
      <div className="mb-6">
        <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-zinc-500">
          Styrby
        </p>
        <h1 className="text-xl font-bold text-zinc-100">Special Offer</h1>
        <p className="mt-1 text-sm text-zinc-400">
          We&apos;d love to keep you on Styrby. Here&apos;s an exclusive discount offer just for you.
        </p>
      </div>

      {/* Status panel — varies by derived status */}
      <div className="mb-6">
        {status === 'active' && <ActivePanel expiresAt={offer.expires_at} />}
        {status === 'accepted' && offer.accepted_at && (
          <AcceptedPanel acceptedAt={offer.accepted_at} discountCode={offer.polar_discount_code} />
        )}
        {status === 'revoked' && offer.revoked_at && (
          <RevokedPanel revokedAt={offer.revoked_at} />
        )}
        {status === 'expired' && <ExpiredPanel expiresAt={offer.expires_at} />}
      </div>

      {/* Offer detail — shown for all states so the user always has context */}
      <div className="mb-6">
        <OfferDetails offer={offer} />
      </div>

      {/* Accept button — only for active (not yet accepted/revoked/expired) offers */}
      {status === 'active' && (
        <ChurnSaveOfferCard
          offerId={offer.id}
          discountPct={offer.discount_pct}
          durationMonths={offer.discount_duration_months}
          expiresAt={offer.expires_at}
          reason={offer.reason}
          acceptAction={boundAccept}
        />
      )}

      {/* Footer */}
      <p className="mt-8 text-center text-xs text-zinc-500">
        Offer ID {offerId} &middot; Questions?{' '}
        <a
          href="/dashboard/support"
          className="text-zinc-500 underline-offset-2 hover:text-zinc-400 hover:underline"
        >
          Contact support
        </a>
      </p>
    </div>
  );
}
