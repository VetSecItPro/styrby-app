'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  TIER_DEFINITIONS_CANONICAL,
  calculateMonthlyCostCents,
  calculateAnnualCostCents,
  formatCents,
} from '@/lib/billing/polar-products';

/**
 * Props for {@link ProTierCard}.
 */
interface ProTierCardProps {
  /** Whether annual billing is currently selected. */
  annual: boolean;
}

/**
 * Pricing card for the **Pro** tier — the individual-developer plan.
 *
 * Pro is a single-seat plan at $39/mo (or $390/year billed annually).
 * It bundles every paid feature an individual developer needs: all 11 CLI
 * agents, unlimited sessions, BYOK + provider subscription pass-through,
 * 1-year encrypted session history, the mobile companion, and OTEL export.
 *
 * Replaces the legacy Solo/Power tier card as part of the Phase 5/6 tier
 * reconciliation (`.audit/styrby-fulltest.md` Decision #2).
 *
 * WHY a dedicated component (not a generic card with props): the visual
 * language for each tier is subtly distinct (Pro is calm, Growth is the
 * recommended-amber variant). Two small components are easier to reason
 * about than one parameterised template, and they keep the orchestrator
 * page file (`app/pricing/page.tsx`) under the 400-line ceiling that
 * `CLAUDE.md`'s component-first architecture mandates.
 *
 * @param props - {@link ProTierCardProps}
 * @returns The Pro tier pricing card.
 *
 * @example
 * ```tsx
 * <ProTierCard annual={isAnnualBillingToggleOn} />
 * ```
 */
export function ProTierCard({ annual }: ProTierCardProps) {
  const tier = TIER_DEFINITIONS_CANONICAL.pro;

  // WHY useMemo with empty deps: Pro pricing has no per-render inputs (it is
  // a single-seat fixed plan), so these values are effectively constants for
  // the lifetime of the component. Memoising once at mount avoids three
  // billing-helper calls on every parent re-render (e.g. when the annual
  // toggle on the parent flips — the only meaningful trigger here).
  //
  // WHY integer cents: avoids float drift in displayed prices. The shared
  // billing module returns USD cents and we format only at the edge.
  // WHY a single calculateAnnualCostCents call: previously this also called
  // `calculateAnnualMonthlyEquivalentCents`, which internally calls
  // `calculateAnnualCostCents` again — so the same value was computed twice.
  // We now derive `annualMonthlyEquiv` inline using the same `Math.floor(/12)`
  // formula the helper uses, eliminating the redundant evaluation.
  const { monthlyCents, annualCents, annualMonthlyEquiv } = useMemo(() => {
    const annual = calculateAnnualCostCents('pro', 1);
    return {
      monthlyCents: calculateMonthlyCostCents('pro', 1),
      annualCents: annual,
      annualMonthlyEquiv: Math.floor(annual / 12),
    };
  }, []);

  const displayMonthlyCents = annual ? annualMonthlyEquiv : monthlyCents;
  const annualSavingsCents = annual ? monthlyCents * 12 - annualCents : 0;

  // WHY two URLs (not query-string mutation): keeps the rendered href
  // attribute stable for testing — the test asserts an exact href value.
  const checkoutUrl = annual ? '/signup?plan=pro&billing=annual' : '/signup?plan=pro';

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
          {formatCents(displayMonthlyCents)}
        </span>
        <span className="text-sm font-normal text-muted-foreground">/mo</span>
      </div>

      {/* Reserved-height savings line keeps both cards vertically aligned
          regardless of whether the annual toggle is on. */}
      <div className="mt-1 h-4 text-center">
        {annual && annualSavingsCents > 0 ? (
          <p className="text-xs text-amber-500/80">
            {formatCents(annualCents)}/year (save {formatCents(annualSavingsCents)})
          </p>
        ) : (
          <p className="text-xs text-transparent select-none">-</p>
        )}
      </div>

      <div className="mt-6 h-px bg-zinc-800" />

      <ul className="mt-6 flex-1 space-y-3">
        {tier.highlights.map((feature) => (
          <li key={feature} className="flex items-start gap-3 text-sm text-zinc-300">
            <Check className="mt-0.5 h-4 w-4 shrink-0 text-amber-500/70" aria-hidden="true" />
            {feature}
          </li>
        ))}
      </ul>

      <div className="mt-8 flex justify-center">
        <Button
          asChild
          variant="outline"
          className="rounded-full px-6 border-zinc-700 bg-transparent font-medium text-zinc-300 hover:border-zinc-500 hover:text-foreground transition-colors"
        >
          <Link href={checkoutUrl}>{tier.cta}</Link>
        </Button>
      </div>

      <p className="mt-3 text-center text-[11px] text-muted-foreground/50">
        14-day free trial. No credit card required.
      </p>
    </div>
  );
}
