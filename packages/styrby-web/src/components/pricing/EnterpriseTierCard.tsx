'use client';

import { Calendar, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { TIER_DEFINITIONS } from '@/lib/billing/polar-products';

/**
 * Enterprise tier card with calendar booking embed trigger.
 *
 * WHY no price display: enterprise pricing is custom. Showing "$0" or "contact us"
 * inline would look broken. Instead the card emphasises the value proposition
 * and anchors on the "$15K+ annual" floor to qualify leads upfront.
 *
 * WHY calendar link (not inline embed): a Cal.com/Calendly inline embed adds
 * ~40KB+ to the page bundle. The enterprise card is the lowest-traffic CTA.
 * A link to a hosted calendar URL keeps the pricing page within the 740 KB
 * first-load budget.
 *
 * The calendar URL is configurable via NEXT_PUBLIC_ENTERPRISE_CALENDAR_URL.
 * Falls back to a mailto link if not set (local dev / pre-launch).
 */
export function EnterpriseTierCard() {
  const tier = TIER_DEFINITIONS.enterprise;

  /**
   * NEXT_PUBLIC_ENTERPRISE_CALENDAR_URL - Cal.com or Calendly booking URL.
   *
   * Source: Cal.com dashboard or Calendly account settings.
   * Format: "https://cal.com/yourteam/enterprise" or "https://calendly.com/yourteam/enterprise"
   * Required in: production (falls back to mailto for dev/preview)
   * Behavior when missing: shows a mailto fallback link.
   */
  const calendarUrl =
    process.env.NEXT_PUBLIC_ENTERPRISE_CALENDAR_URL ||
    'mailto:hello@styrbyapp.com?subject=Enterprise%20Inquiry';

  return (
    <div className="relative flex flex-col rounded-2xl border border-zinc-800/80 bg-zinc-950/60 px-8 py-6 transition-all duration-300 hover:border-zinc-700/80">
      <div className="text-center">
        <h3 className="text-2xl font-bold tracking-tight text-foreground">{tier.name}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{tier.tagline}</p>
      </div>

      {/* Custom pricing anchor */}
      <div className="mt-6 flex flex-col items-center">
        <p className="text-3xl font-bold tracking-tight text-foreground">Custom</p>
        <p className="mt-1 text-sm text-muted-foreground">From $15K/year</p>
      </div>

      {/* Reserved height matches other cards */}
      <div className="mt-1 h-4" />

      <div className="mt-6 h-px bg-zinc-800" />

      <ul className="mt-6 flex-1 space-y-3">
        {tier.highlights.map((feature) => (
          <li
            key={feature}
            className={
              feature.endsWith('plus:')
                ? 'text-sm font-semibold text-zinc-200 pb-1 border-b border-zinc-800/60'
                : 'flex items-start gap-3 text-sm text-zinc-300'
            }
          >
            {!feature.endsWith('plus:') && (
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-amber-500/70" aria-hidden="true" />
            )}
            {feature}
          </li>
        ))}
      </ul>

      <div className="mt-8 flex justify-center">
        <Button
          asChild
          variant="outline"
          className="rounded-full px-6 border-zinc-700 bg-transparent font-medium text-zinc-300 hover:border-amber-500/60 hover:text-foreground transition-colors"
        >
          <a href={calendarUrl} target="_blank" rel="noopener noreferrer">
            <Calendar className="mr-2 h-4 w-4" aria-hidden="true" />
            {tier.cta}
          </a>
        </Button>
      </div>

      <p className="mt-3 text-center text-[11px] text-muted-foreground/50">
        Custom contract. Volume discounts available.
      </p>
    </div>
  );
}
