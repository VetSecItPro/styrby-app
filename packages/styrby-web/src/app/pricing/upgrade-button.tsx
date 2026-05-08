'use client';

import { useState } from 'react';
// PERF-BUNDLE-001: type-only imports are erased at compile time, but pointing
// this client component at the SDK-free tier-config keeps the import surface
// consistent with pricing-cards.tsx and prevents an accidental value import
// from drifting back to @/lib/polar.
import { type TierId, type BillingCycle } from '@/lib/billing/tier-config';

interface UpgradeButtonProps {
  tierId: TierId;
  billingCycle: BillingCycle;
  isPopular?: boolean;
  /**
   * Seat count for the Growth tier. Ignored for Pro (single-seat plan).
   * Defaults to GROWTH_BASE_SEATS (3) at the API layer when omitted.
   */
  seatCount?: number;
}

/**
 * Checkout button for upgrading to a paid tier.
 *
 * Calls the /api/billing/checkout endpoint and redirects to Polar's checkout page.
 * Shows inline error feedback if checkout fails instead of silently logging.
 */
export function UpgradeButton({ tierId, billingCycle, isPopular, seatCount }: UpgradeButtonProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleUpgrade = async () => {
    setLoading(true);
    setError(null);

    try {
      // WHY only include seats for growth: Pro is a single-seat plan and the
      // API's z.enum schema rejects unknown fields cleanly, but omitting the
      // field entirely keeps the payload precise to the tier semantics.
      const body =
        tierId === 'growth' && typeof seatCount === 'number'
          ? { tierId, billingCycle, seats: seatCount }
          : { tierId, billingCycle };

      const response = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.error || 'Checkout failed. Please try again.');
        return;
      }

      if (data.url) {
        window.location.href = data.url;
      } else {
        setError('Unable to start checkout. Please try again.');
      }
    } catch {
      setError('Network error. Check your connection and try again.');
    } finally {
      setLoading(false);
    }
  };

  // WHY tier-specific copy: generic "Upgrade" forces the user to look back at
  // the card title to confirm what they're buying. Naming the destination tier
  // inside the button is the standard pricing-page conversion pattern.
  const tierLabels: Record<TierId, string> = {
    free: 'Sign up',
    pro: 'Upgrade to Pro',
    growth: 'Upgrade to Growth',
  };
  const ctaLabel = tierLabels[tierId] ?? 'Upgrade to Pro';

  return (
    <div>
      <button
        onClick={handleUpgrade}
        disabled={loading}
        className={`w-full rounded-lg py-3 text-sm font-semibold transition-colors ${
          isPopular
            ? 'bg-orange-700 text-white hover:bg-orange-800'
            : 'bg-zinc-800 text-zinc-100 hover:bg-zinc-700'
        } ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
      >
        {loading ? 'Loading...' : ctaLabel}
      </button>
      {error && (
        <p className="mt-2 text-sm text-red-400 text-center">{error}</p>
      )}
    </div>
  );
}
