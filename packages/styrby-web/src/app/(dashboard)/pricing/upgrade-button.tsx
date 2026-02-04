'use client';

import { useState } from 'react';
import { type TierId, type BillingCycle } from '@/lib/polar';

interface UpgradeButtonProps {
  tierId: TierId;
  billingCycle: BillingCycle;
  isPopular?: boolean;
}

export function UpgradeButton({ tierId, billingCycle, isPopular }: UpgradeButtonProps) {
  const [loading, setLoading] = useState(false);

  const handleUpgrade = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tierId, billingCycle }),
      });

      const data = await response.json();

      if (data.url) {
        window.location.href = data.url;
      } else {
        console.error('No checkout URL returned');
      }
    } catch (error) {
      console.error('Checkout error:', error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      onClick={handleUpgrade}
      disabled={loading}
      className={`w-full rounded-lg py-3 text-sm font-semibold transition-colors ${
        isPopular
          ? 'bg-orange-500 text-white hover:bg-orange-600'
          : 'bg-zinc-800 text-zinc-100 hover:bg-zinc-700'
      } ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
    >
      {loading ? 'Loading...' : 'Upgrade'}
    </button>
  );
}
