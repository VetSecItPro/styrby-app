'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { Check, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  TIER_DEFINITIONS_CANONICAL,
  GROWTH_BASE_SEATS,
  GROWTH_MAX_SEATS,
  calculateMonthlyCostCents,
  calculateAnnualCostCents,
  calculateAnnualMonthlyEquivalentCents,
  formatCents,
} from '@/lib/billing/polar-products';
import { SeatCountSlider } from './SeatCountSlider';

/**
 * Props for {@link GrowthTierCard}.
 */
interface GrowthTierCardProps {
  /** Whether annual billing is currently selected. */
  annual: boolean;
  /** Current seat count for the Growth tier (controlled by parent). */
  seatCount: number;
  /** Called when the seat-count slider value changes. */
  onSeatCountChange: (count: number) => void;
}

/**
 * Pricing card for the **Growth** tier — the team plan.
 *
 * Growth uses the Path A "base + addon" pricing pattern (Decisions #1 / #3
 * / #4 in `.audit/styrby-fulltest.md`):
 *   - $99/mo base product covers {@link GROWTH_BASE_SEATS} (3) seats.
 *   - Each additional seat is $19/mo via the Polar seat add-on product.
 *   - Annual billing uses dedicated annual products (not monthly × 12).
 *
 * The card embeds the {@link SeatCountSlider} so visitors can land on the
 * exact monthly total before clicking through to checkout. The CTA carries
 * the chosen seat count via `?seats=N` so the dashboard checkout trigger
 * (`plan-checkout.tsx`) can forward it to the Polar checkout API.
 *
 * Replaces the legacy Team / Business / Enterprise cards as part of the
 * Phase 5/6 tier reconciliation (Decision #1).
 *
 * @param props - {@link GrowthTierCardProps}
 * @returns The Growth tier pricing card.
 *
 * @example
 * ```tsx
 * <GrowthTierCard
 *   annual={isAnnualBillingToggleOn}
 *   seatCount={seats}
 *   onSeatCountChange={setSeats}
 * />
 * ```
 */
export function GrowthTierCard({
  annual,
  seatCount,
  onSeatCountChange,
}: GrowthTierCardProps) {
  const tier = TIER_DEFINITIONS_CANONICAL.growth;

  // WHY useMemo: SeatCountSlider drags emit at up to 60fps. Memoising the
  // derived pricing values keeps each drag tick to a single recompute when
  // seatCount actually changes, and zero recomputes when only `annual` flips
  // (memo only depends on seatCount). Without this, every parent re-render
  // (annual toggle, neighbouring component change) recomputes the billing
  // helpers even though the inputs are unchanged.
  //
  // WHY integer cents math: avoids float drift on large seat counts. The
  // shared billing module owns the canonical formula (`base + seats × addon`)
  // so we never recalculate locally — that would risk drift between display
  // and checkout (SOC2 CC7.2 single-source-of-truth).
  const { monthlyCents, annualCents, annualMonthlyEquiv, annualSavingsCents } = useMemo(() => {
    const monthly = calculateMonthlyCostCents('growth', seatCount);
    const annual = calculateAnnualCostCents('growth', seatCount);
    const annualEquiv = calculateAnnualMonthlyEquivalentCents('growth', seatCount);
    return {
      monthlyCents: monthly,
      annualCents: annual,
      annualMonthlyEquiv: annualEquiv,
      annualSavingsCents: monthly * 12 - annual,
    };
  }, [seatCount]);

  const displayMonthlyCents = annual ? annualMonthlyEquiv : monthlyCents;

  // WHY URLs constructed inline: keeps the rendered href stable for testing
  // (matches a string equality assertion rather than a regex).
  const checkoutUrl = annual
    ? `/signup?plan=growth&seats=${seatCount}&billing=annual`
    : `/signup?plan=growth&seats=${seatCount}`;

  return (
    <div
      className={cn(
        'relative flex flex-col rounded-2xl px-8 py-6 transition-all duration-300',
        'border border-amber-500/40 bg-zinc-950 z-10',
      )}
    >
      {/* Ambient glow — visually flags Growth as the recommended choice. */}
      <div
        className="pointer-events-none absolute inset-0 rounded-2xl"
        style={{
          background:
            'radial-gradient(ellipse 60% 40% at 50% 0%, rgba(245,158,11,0.07) 0%, transparent 70%)',
        }}
        aria-hidden="true"
      />

      {/* Most Popular badge */}
      <div className="mb-5 flex justify-center">
        <span className="rounded-full border border-amber-500/20 bg-amber-500/10 px-3 py-1 text-[10px] font-medium uppercase tracking-[0.2em] text-amber-400">
          Most Popular
        </span>
      </div>

      <div className="text-center">
        <div className="flex items-center justify-center gap-2">
          <Users className="h-5 w-5 text-amber-400" aria-hidden="true" />
          <h3 className="text-2xl font-bold tracking-tight text-foreground">{tier.name}</h3>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">{tier.tagline}</p>
      </div>

      {/* Seat slider */}
      <div className="mt-6">
        <SeatCountSlider
          min={GROWTH_BASE_SEATS}
          max={GROWTH_MAX_SEATS}
          value={seatCount}
          onChange={onSeatCountChange}
          label="Team size"
        />
      </div>

      {/* Live monthly total */}
      <div className="mt-4 flex items-baseline gap-1 justify-center">
        <span className="text-5xl font-bold tracking-tight text-foreground">
          {formatCents(displayMonthlyCents)}
        </span>
        <span className="text-sm font-normal text-muted-foreground">/mo</span>
      </div>

      <div className="mt-1 h-4 text-center">
        {annual ? (
          <p className="text-xs text-amber-500/80">
            {formatCents(annualCents)}/year (save {formatCents(annualSavingsCents)})
          </p>
        ) : (
          <p className="text-xs text-muted-foreground/50">
            Includes {GROWTH_BASE_SEATS} seats. Add more for{' '}
            {formatCents(tier.seatPriceMonthlyUsdCents)}/seat/month.
          </p>
        )}
      </div>

      <div className="mt-6 h-px bg-amber-500/20" />

      <ul className="mt-6 flex-1 space-y-3">
        {tier.highlights.map((feature) => (
          <li
            key={feature}
            className={cn(
              'flex items-start gap-3 text-sm',
              feature.endsWith('plus:')
                ? 'font-semibold text-zinc-200 pb-1 border-b border-zinc-800/60'
                : 'text-zinc-300',
            )}
          >
            {!feature.endsWith('plus:') && (
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" aria-hidden="true" />
            )}
            {feature}
          </li>
        ))}
      </ul>

      <div className="mt-8 flex justify-center">
        <Button
          asChild
          className="rounded-full px-6 bg-amber-500 font-semibold text-zinc-950 hover:bg-amber-400 active:bg-amber-600 transition-colors"
        >
          <Link href={checkoutUrl}>{tier.cta}</Link>
        </Button>
      </div>

      <p className="mt-3 text-center text-[11px] text-muted-foreground/50">
        14-day free trial. {GROWTH_BASE_SEATS} seats included; up to {GROWTH_MAX_SEATS}.
      </p>
    </div>
  );
}
