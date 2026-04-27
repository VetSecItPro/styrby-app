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
}

/**
 * Checkout button for upgrading to a paid tier.
 *
 * Calls the /api/billing/checkout endpoint and redirects to Polar's checkout page.
 * Shows inline error feedback if checkout fails instead of silently logging.
 */
export function UpgradeButton({ tierId, billingCycle, isPopular }: UpgradeButtonProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleUpgrade = async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tierId, billingCycle }),
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
  // (Pro / Power) inside the button is the standard pricing-page conversion
  // pattern and complies with the project copy ban on generic CTAs.
  const tierLabels: Record<TierId, string> = {
    free: 'Start Free',
    pro: 'Upgrade to Pro',
    // WHY (Phase 5 rename): pre-rename `'power'` collapsed into Growth.
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
            ? 'bg-orange-500 text-white hover:bg-orange-600'
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
