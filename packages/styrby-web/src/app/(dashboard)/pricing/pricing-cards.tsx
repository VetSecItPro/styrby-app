'use client';

import { useState } from 'react';
import { TIERS, type TierId, type BillingCycle } from '@/lib/polar';
import { UpgradeButton } from './upgrade-button';

interface PricingCardsProps {
  currentTier: TierId;
}

export function PricingCards({ currentTier }: PricingCardsProps) {
  const [billingCycle, setBillingCycle] = useState<BillingCycle>('monthly');

  return (
    <>
      {/* Billing toggle */}
      <div className="flex items-center justify-center gap-4 mb-10">
        <span
          className={`text-sm font-medium ${
            billingCycle === 'monthly' ? 'text-zinc-100' : 'text-zinc-500'
          }`}
        >
          Monthly
        </span>
        <button
          onClick={() =>
            setBillingCycle(billingCycle === 'monthly' ? 'annual' : 'monthly')
          }
          className="relative inline-flex h-6 w-11 items-center rounded-full bg-zinc-700 transition-colors focus:outline-none focus:ring-2 focus:ring-orange-500 focus:ring-offset-2 focus:ring-offset-zinc-950"
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
              billingCycle === 'annual' ? 'translate-x-6' : 'translate-x-1'
            }`}
          />
        </button>
        <span
          className={`text-sm font-medium ${
            billingCycle === 'annual' ? 'text-zinc-100' : 'text-zinc-500'
          }`}
        >
          Annual
        </span>
        {billingCycle === 'annual' && (
          <span className="rounded-full bg-green-500/10 px-2 py-0.5 text-xs font-medium text-green-400">
            2 months free
          </span>
        )}
      </div>

      {/* Pricing cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {(Object.keys(TIERS) as TierId[]).map((tierId) => {
          const tier = TIERS[tierId];
          const isCurrentTier = currentTier === tierId;
          const isPopular = tierId === 'pro';
          const price =
            billingCycle === 'annual' ? tier.price.annual : tier.price.monthly;
          const period = billingCycle === 'annual' ? '/year' : '/month';

          return (
            <div
              key={tierId}
              className={`rounded-2xl p-6 relative ${
                isPopular
                  ? 'bg-gradient-to-b from-orange-500/10 to-zinc-900 border border-orange-500/20'
                  : 'bg-zinc-900 border border-zinc-800'
              }`}
            >
              {isPopular && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-orange-500 px-3 py-1 text-xs font-medium text-white">
                  Most Popular
                </div>
              )}

              {isCurrentTier && (
                <div className="absolute top-4 right-4">
                  <span className="inline-flex items-center rounded-full bg-green-500/10 px-2 py-1 text-xs font-medium text-green-400">
                    Current
                  </span>
                </div>
              )}

              <h3 className="text-xl font-semibold text-zinc-100">
                {tier.name}
              </h3>

              <div className="mt-4">
                <span className="text-4xl font-bold text-zinc-100">
                  ${price}
                </span>
                <span className="text-zinc-500">{period}</span>
                {billingCycle === 'annual' && tierId !== 'free' && (
                  <div className="text-sm text-zinc-500 mt-1">
                    ${(tier.price.annual / 12).toFixed(2)}/month
                  </div>
                )}
              </div>

              <ul className="mt-6 space-y-3">
                {tier.features.map((feature, index) => (
                  <li
                    key={index}
                    className="flex items-center gap-2 text-sm text-zinc-400"
                  >
                    <svg
                      className="h-5 w-5 text-green-500 flex-shrink-0"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M5 13l4 4L19 7"
                      />
                    </svg>
                    {feature}
                  </li>
                ))}
              </ul>

              <div className="mt-8">
                {isCurrentTier ? (
                  <button
                    disabled
                    className="w-full rounded-lg bg-zinc-800 py-3 text-sm font-semibold text-zinc-400 cursor-not-allowed"
                  >
                    Current Plan
                  </button>
                ) : tierId === 'free' ? (
                  <button
                    disabled
                    className="w-full rounded-lg bg-zinc-800 py-3 text-sm font-semibold text-zinc-400 cursor-not-allowed"
                  >
                    Free Forever
                  </button>
                ) : (
                  <UpgradeButton
                    tierId={tierId}
                    billingCycle={billingCycle}
                    isPopular={isPopular}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
