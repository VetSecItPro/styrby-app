'use client';

import Link from 'next/link';
import { Check, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  TIER_DEFINITIONS,
  TEAM_MIN_SEATS,
  TEAM_MAX_SEATS,
  calculateMonthlyCostCents,
  calculateAnnualCostCents,
  calculateAnnualMonthlyEquivalentCents,
  formatCents,
} from '@/lib/billing/polar-products';
import { SeatCountSlider } from './SeatCountSlider';

interface TeamTierCardProps {
  /** Whether annual billing is currently selected. */
  annual: boolean;
  /** Current seat count for this tier (controlled by parent). */
  seatCount: number;
  /** Called when the slider value changes. */
  onSeatCountChange: (count: number) => void;
}

/**
 * Pricing card for the Team tier with embedded seat-count slider.
 *
 * Displays live-updating monthly total and per-seat cost as the slider moves.
 * Wires the CTA to /signup?plan=team&seats=N which is the team checkout entry.
 *
 * WHY seat slider is embedded in the card (not shared): Team and Business
 * have different min/max bounds and labels. Separate slider instances with
 * different props are cleaner than a single slider with conditional config.
 *
 * @param annual - Annual billing toggle state.
 * @param seatCount - Current seat count value (3-100).
 * @param onSeatCountChange - Callback when slider moves.
 */
export function TeamTierCard({ annual, seatCount, onSeatCountChange }: TeamTierCardProps) {
  const tier = TIER_DEFINITIONS.team;

  // WHY integer cents: float multiplication drifts on large seat counts.
  const monthlyCents = calculateMonthlyCostCents('team', seatCount);
  const annualCents = calculateAnnualCostCents('team', seatCount);
  const annualMonthlyEquiv = calculateAnnualMonthlyEquivalentCents('team', seatCount);
  const annualSavingsCents = monthlyCents * 12 - annualCents;

  const displayMonthlyCents = annual ? annualMonthlyEquiv : monthlyCents;
  const perSeatCents = annual
    ? calculateAnnualMonthlyEquivalentCents('team', 1)
    : tier.pricePerSeatMonthlyUsdCents;

  const checkoutUrl = annual
    ? `/signup?plan=team&seats=${seatCount}&billing=annual`
    : `/signup?plan=team&seats=${seatCount}`;

  return (
    <div
      className={cn(
        'relative flex flex-col rounded-2xl px-8 py-6 transition-all duration-300',
        'border border-amber-500/40 bg-zinc-950 z-10',
      )}
    >
      {/* Ambient glow - recommended tier */}
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
          min={TEAM_MIN_SEATS}
          max={TEAM_MAX_SEATS}
          value={seatCount}
          onChange={onSeatCountChange}
          label="Team size"
        />
      </div>

      {/* Live price display */}
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
            {formatCents(perSeatCents)}/seat/mo
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
              feature.endsWith('plus:') ? 'font-semibold text-zinc-200 pb-1 border-b border-zinc-800/60' : 'text-zinc-300',
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
        14-day free trial. Minimum {TEAM_MIN_SEATS} seats.
      </p>
    </div>
  );
}
