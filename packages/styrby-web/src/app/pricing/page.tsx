'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Navbar } from '@/components/landing/navbar';
import { Footer } from '@/components/landing/footer';
import {
  SoloTierCard,
  TeamTierCard,
  BusinessTierCard,
  EnterpriseTierCard,
  ComparisonTable,
  PricingPageTracker,
  trackPricingEvent,
} from '@/components/pricing';
import { faqs } from '@/components/pricing/pricing-data';
import { TEAM_MIN_SEATS, BUSINESS_MIN_SEATS } from '@/lib/billing/polar-products';

/**
 * WHY dynamic import for ROICalculator:
 * The ROI calculator uses multiple Radix Slider instances and client state.
 * Dynamic import with ssr:false splits it into a separate JS chunk that is
 * fetched only when the user's browser has finished first paint, keeping
 * the pricing page first-load bundle within the 740 KB budget (CLAUDE.md).
 */
const ROICalculator = dynamic(
  () => import('@/components/pricing/ROICalculator').then((m) => m.ROICalculator),
  {
    ssr: false,
    loading: () => (
      <div className="rounded-2xl border border-zinc-800/80 bg-zinc-950/60 p-8 min-h-[400px] flex items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-zinc-700 border-t-amber-500" />
      </div>
    ),
  },
);

/**
 * Public pricing page (Phase 2.8 redesign).
 *
 * Orchestrates four tier columns: Solo, Team, Business, Enterprise.
 * - Solo: flat $49/mo, individual plan
 * - Team: $19/seat/mo, seat-count slider (3-100 seats)
 * - Business: $39/seat/mo, seat-count slider (10-100 seats)
 * - Enterprise: custom pricing + calendar booking CTA
 *
 * Architecture:
 * - State: billing toggle + seat-count sliders live here (orchestrator)
 * - Pricing math: lib/billing/polar-products.ts (integer cents + basis points)
 * - Tier cards: components/pricing/{Solo,Team,Business,Enterprise}TierCard.tsx
 * - Comparison table: components/pricing/ComparisonTable.tsx
 * - ROI calculator: dynamic-imported (bundle budget)
 * - FAQ data + comparison data: components/pricing/pricing-data.ts
 * - A/B tracking: components/pricing/PricingPageTracker.tsx
 *
 * WHY CTA slider events fire every 10 seats: captures high-intent slider
 * interactions without spamming analytics at every 1-seat move.
 */
export default function PricingPage() {
  const [annual, setAnnual] = useState(false);
  const [teamSeats, setTeamSeats] = useState(TEAM_MIN_SEATS);
  const [businessSeats, setBusinessSeats] = useState(BUSINESS_MIN_SEATS);
  const [activeFaq, setActiveFaq] = useState(0);

  return (
    <main className="min-h-[100dvh]">
      {/* A/B tracking - fires page_view once on mount, no DOM output */}
      <PricingPageTracker variant="v2" />

      <Navbar />

      {/* Hero */}
      <section className="pt-32 pb-16">
        <div className="mx-auto max-w-7xl px-6 text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-500/70">
            Pricing
          </p>
          <h1 className="mt-3 text-balance text-4xl font-bold tracking-tight text-foreground md:text-5xl">
            Pricing built for the way you actually run AI agents
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-lg text-muted-foreground leading-relaxed">
            From one machine on Solo to a fleet on Business. Annual billing saves about 17%. Cancel anytime, no seat fees on monthly.
          </p>
        </div>
      </section>

      {/* Annual/monthly toggle */}
      <section className="pb-4">
        <div className="mx-auto max-w-7xl px-6">
          <div className="flex items-center justify-center gap-4">
            <span className={cn('text-sm transition-colors', !annual ? 'font-medium text-foreground' : 'text-muted-foreground')}>
              Monthly
            </span>
            <button
              type="button"
              onClick={() => setAnnual(!annual)}
              className={cn(
                'relative h-6 w-11 rounded-full transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                annual ? 'bg-amber-500' : 'bg-zinc-700',
              )}
              role="switch"
              aria-checked={annual}
              aria-label="Toggle annual billing"
            >
              <span
                className={cn(
                  'absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform duration-200',
                  annual && 'translate-x-5',
                )}
              />
            </button>
            <span className={cn('text-sm transition-colors', annual ? 'font-medium text-foreground' : 'text-muted-foreground')}>
              Annual{' '}
              <span className="ml-1 rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.15em] text-amber-400">
                Save 17%
              </span>
            </span>
          </div>
        </div>
      </section>

      {/* Pricing cards - 4-column grid */}
      <section className="py-12">
        <div className="mx-auto max-w-7xl px-6">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4 md:items-stretch">
            <SoloTierCard annual={annual} />
            <TeamTierCard
              annual={annual}
              seatCount={teamSeats}
              onSeatCountChange={(n) => {
                setTeamSeats(n);
                if (n % 10 === 0) trackPricingEvent('team_slider_move', { seats: n, annual });
              }}
            />
            <BusinessTierCard
              annual={annual}
              seatCount={businessSeats}
              onSeatCountChange={(n) => {
                setBusinessSeats(n);
                if (n % 10 === 0) trackPricingEvent('business_slider_move', { seats: n, annual });
              }}
            />
            <EnterpriseTierCard />
          </div>
          <p className="mt-8 text-center text-xs text-muted-foreground/60">
            14-day free trial on Solo, Team, and Business. No credit card required. Cancel anytime.
          </p>
        </div>
      </section>

      {/* ROI Calculator - dynamic-imported chunk (740 KB budget) */}
      <section className="py-16 border-t border-zinc-800/40">
        <div className="mx-auto max-w-5xl px-6">
          <div className="mx-auto max-w-2xl text-center mb-10">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-500/70">
              ROI Estimator
            </p>
            <h2 className="mt-3 text-balance text-3xl font-bold tracking-tight text-foreground">
              Estimate your team&apos;s value recovered
            </h2>
            <p className="mx-auto mt-3 max-w-lg text-muted-foreground">
              Based on published research. Defaults to conservative 25% gain on repetitive tasks.
              Adjust the sliders to match your team.
            </p>
          </div>
          <ROICalculator />
        </div>
      </section>

      {/* Feature comparison table */}
      <section className="py-16 border-t border-zinc-800/40">
        <div className="mx-auto max-w-6xl px-6">
          <h2 className="text-balance text-center text-3xl font-bold tracking-tight text-foreground">
            Compare all features
          </h2>
          <p className="mx-auto mt-3 max-w-lg text-center text-muted-foreground">
            A detailed breakdown of what each plan includes.
          </p>
          <ComparisonTable />
        </div>
      </section>

      {/* FAQ - two-column interactive layout */}
      <section className="py-24 border-t border-zinc-800/40">
        <div className="mx-auto max-w-7xl px-6">
          <div className="mx-auto max-w-2xl text-center">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-500/70">
              FAQ
            </p>
            <h2 className="mt-3 text-balance text-3xl font-bold tracking-tight text-foreground">
              Frequently asked questions
            </h2>
          </div>

          <div className="mt-16 grid gap-6 lg:grid-cols-[1fr_1.4fr] lg:gap-12">
            {/* Left: question list */}
            <nav aria-label="FAQ questions" className="flex flex-col gap-1">
              {faqs.map((faq, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => setActiveFaq(i)}
                  className={cn(
                    'group flex w-full items-start gap-3 rounded-lg px-4 py-3.5 text-left transition-colors duration-150',
                    i === activeFaq
                      ? 'bg-zinc-900 text-foreground'
                      : 'text-muted-foreground hover:bg-zinc-900/50 hover:text-foreground',
                  )}
                >
                  <span
                    className={cn(
                      'mt-1.5 h-3 w-0.5 shrink-0 rounded-full transition-colors duration-150',
                      i === activeFaq ? 'bg-amber-500' : 'bg-transparent',
                    )}
                    aria-hidden="true"
                  />
                  <span className="text-sm font-medium leading-snug">{faq.q}</span>
                </button>
              ))}
            </nav>

            {/* Right: answer panel */}
            <div className="lg:sticky lg:top-24">
              <div className="rounded-2xl border border-zinc-800/80 bg-zinc-950/60 p-8 lg:p-10">
                <h3 className="text-lg font-semibold leading-snug text-foreground">
                  {faqs[activeFaq].q}
                </h3>
                <div className="mt-4 h-px w-12 bg-amber-500/40" />
                <p className="mt-5 text-base leading-relaxed text-muted-foreground">
                  {faqs[activeFaq].a}
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className="relative overflow-hidden py-28 border-t border-zinc-800/40">
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              'radial-gradient(ellipse 80% 60% at 50% 50%, rgba(245,158,11,0.06) 0%, transparent 70%)',
          }}
          aria-hidden="true"
        />
        <div className="pointer-events-none absolute inset-0 dot-grid opacity-20" aria-hidden="true" />

        <div className="relative mx-auto max-w-3xl px-6 text-center">
          <h2 className="text-balance text-4xl font-bold tracking-tight text-foreground md:text-5xl">
            Start monitoring your agents in 90 seconds
          </h2>
          <div className="mt-10">
            <Button
              asChild
              size="lg"
              className="h-13 bg-amber-500 px-10 text-base font-semibold text-zinc-950 shadow-lg shadow-amber-500/20 hover:bg-amber-400 active:bg-amber-600 transition-colors"
              onClick={() => trackPricingEvent('cta_click', { location: 'bottom', variant: 'v2' })}
            >
              <Link href="/signup">
                Get Started Free
                <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
            </Button>
          </div>
          <p className="mt-4 text-sm text-muted-foreground/60">
            Free plan available. No credit card required.
          </p>
        </div>
      </section>

      <Footer />
    </main>
  );
}
