'use client';

import Link from 'next/link';
import { Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { TIER_DEFINITIONS, calculateAnnualMonthlyEquivalentCents, formatCents } from '@/lib/billing/polar-products';

interface SoloTierCardProps {
  /** Whether annual billing is currently selected. */
  annual: boolean;
}

/**
 * Pricing card for the Solo (Power) tier.
 *
 * Displays monthly or annual-equivalent price with savings callout.
 * Wires the CTA to /signup?plan=power which is the existing checkout entry point.
 *
 * WHY separate component: pricing page must stay under 400 lines (CLAUDE.md
 * component-first architecture). Each tier card is its own file.
 *
 * @param annual - Whether annual billing toggle is active.
 */
export function SoloTierCard({ annual }: SoloTierCardProps) {
  const tier = TIER_DEFINITIONS.solo;

  // WHY cents math: avoids float drift in displayed prices.
  const monthlyDisplay = annual
    ? calculateAnnualMonthlyEquivalentCents('solo', 1)
    : tier.pricePerSeatMonthlyUsdCents;

  const annualTotal = annual
    ? Math.floor((tier.pricePerSeatMonthlyUsdCents * 12 * 8300) / 10000)
    : null;

  const monthlySavings = annual
    ? tier.pricePerSeatMonthlyUsdCents - calculateAnnualMonthlyEquivalentCents('solo', 1)
    : null;

  return (
    <div
      className={cn(
        'relative flex flex-col rounded-2xl px-8 py-6 transition-all duration-300',
        'border border-zinc-800/80 bg-zinc-950/60 hover:border-zinc-700/80',
      )}
    >
      <div className="text-center">
        <h3 className="text-2xl font-bold tracking-tight text-foreground">{tier.name}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{tier.tagline}</p>
      </div>

      <div className="mt-6 flex items-baseline gap-1 justify-center">
        <span className="text-5xl font-bold tracking-tight text-foreground">
          {formatCents(monthlyDisplay)}
        </span>
        <span className="text-sm font-normal text-muted-foreground">/mo</span>
      </div>

      {/* Reserved height prevents layout shift */}
      <div className="mt-1 h-4 text-center">
        {annual && annualTotal !== null && monthlySavings !== null && monthlySavings > 0 ? (
          <p className="text-xs text-amber-500/80">
            {formatCents(annualTotal)}/year (save {formatCents(monthlySavings)}/mo)
          </p>
        ) : (
          <p className="text-xs text-transparent select-none">-</p>
        )}
      </div>

      <div className="mt-6 h-px bg-zinc-800" />

      <ul className="mt-6 flex-1 space-y-3">
        {tier.highlights.map((feature) => (
          <li key={feature} className="flex items-start gap-3 text-sm text-zinc-300">
            <Check className="mt-0.5 h-4 w-4 shrink-0 text-amber-500/70" />
            {feature}
          </li>
        ))}
      </ul>

      <div className="mt-8 flex justify-center">
        <Button
          asChild
          className="rounded-full px-6 bg-amber-500 font-semibold text-zinc-950 hover:bg-amber-400 active:bg-amber-600 transition-colors"
        >
          <Link href={annual ? '/signup?plan=power&billing=annual' : '/signup?plan=power'}>
            {tier.cta}
          </Link>
        </Button>
      </div>

      <p className="mt-3 text-center text-[11px] text-muted-foreground/50">
        14-day free trial. No credit card required.
      </p>
    </div>
  );
}
