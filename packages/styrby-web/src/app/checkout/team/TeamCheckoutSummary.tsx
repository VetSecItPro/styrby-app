/**
 * TeamCheckoutSummary
 *
 * Client component that renders the checkout summary UI and submits the
 * checkout initiation via a POST to /api/billing/checkout.
 *
 * WHY a separate Client Component:
 *   The parent page.tsx is a Server Component (handles auth + data fetching).
 *   The CTA button requires onClick / fetch interactivity — that needs a
 *   Client Component. Splitting at this boundary keeps the heavy auth/DB
 *   logic on the server and the minimal interactive surface on the client.
 *
 * WHY POST to /api/billing/checkout (not a form action):
 *   The API route validates all params server-side with the authenticated
 *   user's JWT context. A plain <form action="/api/billing/checkout"> would
 *   send query params in the body without the auth cookie — the route
 *   handler still reads the cookie, so it works, but an explicit fetch()
 *   lets us handle Polar API errors gracefully before redirect.
 *
 * WHY integer cents displayed as dollars:
 *   All money storage/transfer uses integer cents (no floating-point).
 *   Display conversion (divide by 100, toFixed(2)) is UI-layer only —
 *   it never feeds back into any billing calculation.
 *
 * Icons: CreditCard, Users, Check from lucide-react (not Sparkles — per
 * CLAUDE.md style prohibition).
 *
 * @module app/checkout/team/TeamCheckoutSummary
 */

'use client';

import { useState } from 'react';
import { CreditCard, Users, Check, AlertCircle } from 'lucide-react';
import type { BillableTier } from '@styrby/shared/billing';
import type { BillingCycle } from '@/lib/polar-env';

// ============================================================================
// Types
// ============================================================================

/**
 * Props for TeamCheckoutSummary.
 *
 * All monetary values are integer cents (never fractional).
 */
interface TeamCheckoutSummaryProps {
  /** The team UUID being upgraded */
  teamId: string;
  /** Display name of the team */
  teamName: string;
  /** Billing tier: 'team' or 'business' */
  tier: Extract<BillableTier, 'team' | 'business'>;
  /** Billing cycle: 'monthly' or 'annual' */
  cycle: BillingCycle;
  /** Number of seats being purchased */
  seats: number;
  /** Per-seat price in integer cents (e.g., 1900 for $19.00) */
  seatPriceCents: number;
  /** Total monthly cost in integer cents */
  monthlyCents: number;
  /** Total annual cost in integer cents */
  annualCents: number;
  /**
   * Annual savings in integer cents (0 when cycle === 'monthly').
   * Computed as (monthly × 12) - annual, always integer.
   */
  annualSavingsCents: number;
  /** Minimum seat count for this tier (enforced on server; shown for transparency) */
  minSeats: number;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Formats integer cents as a dollar string with two decimal places.
 *
 * WHY not toLocaleString('en-US', { style: 'currency' }): locale formatting
 * can produce non-breaking spaces and platform-specific quirks that cause
 * snapshot test flakiness. A simple template literal is deterministic.
 *
 * @param cents - Integer cents value (e.g., 1900)
 * @returns Formatted string (e.g., "$19.00")
 */
function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Human-readable tier label for display.
 *
 * WHY a plain record (not imported from shared): this is display-only copy;
 * the canonical tier identifiers are the source of truth, not these labels.
 *
 * @param tier - Billing tier identifier
 * @returns Display label string
 */
function tierLabel(tier: Extract<BillableTier, 'team' | 'business'>): string {
  return tier === 'team' ? 'Team' : 'Business';
}

// ============================================================================
// Component
// ============================================================================

/**
 * Checkout summary card with pricing breakdown and CTA.
 *
 * Displays:
 * - Team name and selected tier/cycle/seat count
 * - Per-seat price + total monthly or annual cost
 * - Annual savings callout when cycle === 'annual'
 * - Primary CTA that POSTs to /api/billing/checkout and redirects to Polar
 * - Error state for upstream failures (502 from /api/billing/checkout)
 *
 * @param props - See {@link TeamCheckoutSummaryProps}
 */
export function TeamCheckoutSummary({
  teamId,
  teamName,
  tier,
  cycle,
  seats,
  seatPriceCents,
  monthlyCents,
  annualCents,
  annualSavingsCents,
}: TeamCheckoutSummaryProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Initiates the Polar checkout session.
   *
   * WHY: POSTs all billing params to /api/billing/checkout, which
   * re-validates everything server-side (never trusts client state),
   * calls Polar to create the checkout, and returns the hosted URL.
   * We then redirect the browser to Polar's checkout page.
   *
   * WHY we redirect (not open a new tab): Polar's hosted checkout uses
   * browser session cookies to remember the checkout. A new tab would
   * lose the cookie context in some browsers (Safari ITP).
   */
  async function handleCheckout() {
    setLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // WHY: All params go in the POST body so the API route can validate
        // them server-side with the authenticated user's JWT context.
        body: JSON.stringify({ team_id: teamId, tier, cycle, seats }),
      });

      if (!res.ok) {
        // WHY parse the error body: the API route returns structured errors
        // with an `error` field. Surface the message to the user.
        const data = await res.json().catch(() => ({})) as { error?: string; message?: string };
        setError(
          data.message ?? data.error ?? 'Something went wrong. Please try again.',
        );
        return;
      }

      const data = await res.json() as { checkout_url?: string };

      if (!data.checkout_url) {
        setError('No checkout URL returned. Please try again.');
        return;
      }

      // Redirect to Polar hosted checkout page
      window.location.href = data.checkout_url;
    } catch {
      // WHY catch (not catch(e)): we do not log error details here because
      // they may contain internal routing info. Surface a generic message
      // and let Sentry capture the full error via the global error boundary.
      setError('Network error. Please check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }

  const displayCost = cycle === 'annual' ? annualCents : monthlyCents;
  const cycleLabel = cycle === 'annual' ? '/year' : '/month';

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="w-full max-w-lg">
        {/* Header */}
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-bold text-gray-900">Upgrade to {tierLabel(tier)}</h1>
          <p className="mt-2 text-gray-600">
            Subscribing for{' '}
            <span className="font-medium text-gray-900">{teamName}</span>
          </p>
        </div>

        {/* Summary card */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
          {/* Plan details */}
          <div className="p-6 border-b border-gray-100">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-sm font-medium text-gray-500 uppercase tracking-wide">
                  {tierLabel(tier)} Plan
                </p>
                <p className="mt-1 text-xl font-semibold text-gray-900">
                  {cycle === 'annual' ? 'Annual billing' : 'Monthly billing'}
                </p>
              </div>
              <span className="inline-flex items-center rounded-full bg-blue-50 px-3 py-1 text-sm font-medium text-blue-700">
                {cycle === 'annual' ? 'Annual' : 'Monthly'}
              </span>
            </div>
          </div>

          {/* Line items */}
          <div className="p-6 space-y-4">
            {/* Seats */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-gray-700">
                <Users className="h-4 w-4 text-gray-400" aria-hidden="true" />
                <span>{seats} {seats === 1 ? 'seat' : 'seats'}</span>
              </div>
              <span className="text-gray-900 font-medium">
                {formatCents(seatPriceCents)}/seat
              </span>
            </div>

            {/* Monthly subtotal (always shown for transparency) */}
            {cycle === 'annual' && (
              <div className="flex items-center justify-between text-sm text-gray-500">
                <span>Monthly value</span>
                <span>{formatCents(monthlyCents)}/mo</span>
              </div>
            )}

            {/* Annual savings callout */}
            {cycle === 'annual' && annualSavingsCents > 0 && (
              <div className="flex items-center justify-between rounded-lg bg-green-50 px-4 py-3">
                <div className="flex items-center gap-2 text-green-700">
                  <Check className="h-4 w-4" aria-hidden="true" />
                  <span className="text-sm font-medium">Annual savings</span>
                </div>
                <span className="text-sm font-semibold text-green-700">
                  {formatCents(annualSavingsCents)}/yr
                </span>
              </div>
            )}

            {/* Divider */}
            <div className="border-t border-gray-100 pt-4">
              <div className="flex items-center justify-between">
                <span className="text-base font-semibold text-gray-900">Total due today</span>
                <span className="text-2xl font-bold text-gray-900">
                  {formatCents(displayCost)}
                  <span className="text-sm font-normal text-gray-500">{cycleLabel}</span>
                </span>
              </div>
            </div>
          </div>

          {/* CTA */}
          <div className="px-6 pb-6">
            <button
              type="button"
              onClick={handleCheckout}
              disabled={loading}
              aria-busy={loading}
              className="w-full flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-6 py-3.5 text-base font-semibold text-white shadow-sm hover:bg-blue-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
            >
              <CreditCard className="h-5 w-5" aria-hidden="true" />
              {loading ? 'Redirecting to checkout...' : 'Continue to payment'}
            </button>

            {/* Error state */}
            {error && (
              <div
                role="alert"
                className="mt-4 flex items-start gap-2 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700"
              >
                <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" aria-hidden="true" />
                <span>{error}</span>
              </div>
            )}

            <p className="mt-4 text-center text-xs text-gray-500">
              You will be redirected to Polar's secure payment page.
              Billing is managed by Polar - cancel anytime.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
