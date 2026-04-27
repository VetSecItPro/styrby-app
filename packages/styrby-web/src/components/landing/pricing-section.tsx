"use client"

import { useState } from "react"
import Link from "next/link"
import { Check, Users } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * Pricing data for the landing-page snapshot — Pro and Growth.
 *
 * Phase 6 update: collapsed from the legacy three-card (Free / Pro $24 /
 * Power $59) layout to the canonical two-tier ladder. Numbers are kept in
 * sync with `packages/styrby-web/src/lib/billing/polar-products.ts` —
 * the dedicated /pricing page is the source of truth for the live total
 * (sliders, annual math); this section is the marketing summary.
 *
 * WHY two cards (not three): retiring the Free tier from the public
 * surface (Decision #6 in `.audit/styrby-fulltest.md`) leaves Pro and
 * Growth as the only paid options. A two-card layout reads better on
 * mobile and removes decision fatigue.
 */
const plans = [
  {
    name: "Pro",
    tagline: "For developers who ship daily",
    monthly: 39,
    annual: 390,
    savings: 78,
    perSeatNote: null,
    popular: false,
    cta: "Start my Pro trial",
    href: "/signup?plan=pro",
    annualHref: "/signup?plan=pro&billing=annual",
    included: [
      "All 11 CLI agents",
      "Unlimited sessions, no per-message overage",
      "1 year of encrypted session history",
      "Token-level cost attribution across every model",
      "Budget caps that throttle or kill runaway sessions",
      "Session checkpoints, sharing, and replay",
      "OTEL export (Grafana, Datadog, Honeycomb)",
      "Push notifications and offline command queue",
    ],
  },
  {
    name: "Growth",
    tagline: "For teams that need to govern spend and access",
    monthly: 99,
    annual: 990,
    savings: 198,
    perSeatNote: "Includes 3 seats. +$19/seat/month after.",
    popular: true,
    cta: "Start my Growth trial",
    href: "/signup?plan=growth",
    annualHref: "/signup?plan=growth&billing=annual",
    included: [
      "Everything in Pro, plus:",
      "Team workspace with role-based access",
      "Per-developer cost rollup with shared dashboards",
      "Approval chains: require sign-off on risky CLI commands",
      "Full audit trail export (SOC2 / ISO 27001 evidence)",
      "Invite flow with email verification and seat-cap enforcement",
      "Priority email support, response within one business day",
      "DPA available on request",
    ],
  },
]

/**
 * Pricing section for the landing page.
 *
 * Mirrors the dedicated /pricing page at a glance: two paid tiers, an
 * annual / monthly toggle, a single "compare full pricing" link to deep
 * dive on /pricing for the seat-count slider and ROI estimator.
 *
 * @returns The full landing-page pricing section.
 */
export function PricingSection() {
  const [annual, setAnnual] = useState(false)

  return (
    <section id="pricing" className="py-24">
      <div className="mx-auto max-w-7xl px-6">

        {/* Section header */}
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-500/70">
            Pricing
          </p>
          <h2 className="mt-3 text-balance text-3xl font-bold tracking-tight text-foreground md:text-4xl">
            One price for solos. One for teams. No surprises.
          </h2>
          <p className="mt-4 text-muted-foreground leading-relaxed">
            Pro covers a single developer end-to-end. Growth covers your team. Your AI provider bills are yours to manage.
          </p>
        </div>

        {/* Annual / monthly toggle */}
        <div className="mt-10 flex items-center justify-center gap-4">
          <span
            className={cn(
              "text-sm transition-colors",
              !annual ? "font-medium text-foreground" : "text-muted-foreground"
            )}
          >
            Monthly
          </span>
          <button
            type="button"
            onClick={() => setAnnual(!annual)}
            className={cn(
              "relative h-6 w-11 rounded-full transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
              annual ? "bg-amber-500" : "bg-zinc-700"
            )}
            role="switch"
            aria-checked={annual}
            aria-label="Toggle annual billing"
          >
            <span
              className={cn(
                "absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform duration-200",
                annual && "translate-x-5"
              )}
            />
          </button>
          <span
            className={cn(
              "text-sm transition-colors",
              annual ? "font-medium text-foreground" : "text-muted-foreground"
            )}
          >
            Annual{" "}
            <span className="ml-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.15em] text-amber-400 border border-amber-500/20">
              Save 17%
            </span>
          </span>
        </div>

        {/* Cards — Growth is highlighted as the recommended choice */}
        <div className="mx-auto mt-12 grid max-w-4xl gap-6 md:grid-cols-2 md:items-stretch">
          {plans.map((plan) => (
            <PricingCard key={plan.name} plan={plan} annual={annual} />
          ))}
        </div>

        {/* Trust footnote + deep link */}
        <p className="mt-8 text-center text-xs text-muted-foreground/60">
          14-day free trial on Pro and Growth. No credit card required. Cancel anytime.{" "}
          <Link
            href="/pricing"
            className="text-amber-400/80 underline-offset-4 hover:text-amber-400 hover:underline"
          >
            Compare full pricing
          </Link>
        </p>
      </div>
    </section>
  )
}

/**
 * Individual pricing card.
 *
 * @param plan - The plan data to render.
 * @param annual - Whether annual billing is selected.
 */
function PricingCard({
  plan,
  annual,
}: {
  plan: (typeof plans)[number]
  annual: boolean
}) {
  // WHY: the annual product price already bakes in the ~17% discount.
  // Showing the monthly equivalent (annual / 12) keeps the visible price
  // consistent across both toggle states.
  const displayPrice =
    annual && plan.annual > 0 ? Math.round(plan.annual / 12) : plan.monthly

  const href = annual ? plan.annualHref : plan.href

  return (
    <div
      className={cn(
        "relative flex flex-col rounded-2xl px-8 py-6 transition-all duration-300",
        plan.popular
          ? // Growth: amber border, subtle amber bloom behind the card.
            "border border-amber-500/40 bg-zinc-950 amber-glow z-10"
          : // Pro: zinc border, inner glow on hover.
            "border border-zinc-800/80 bg-zinc-950/60 hover:border-zinc-700/80 hover:bg-zinc-950/80"
      )}
    >
      {/* Ambient radial glow behind the recommended card */}
      {plan.popular && (
        <div
          className="pointer-events-none absolute inset-0 rounded-2xl"
          style={{
            background:
              "radial-gradient(ellipse 60% 40% at 50% 0%, rgba(245,158,11,0.07) 0%, transparent 70%)",
          }}
          aria-hidden="true"
        />
      )}

      {/* Most Popular eyebrow badge */}
      {plan.popular && (
        <div className="mb-5 flex justify-center">
          <span className="rounded-full border border-amber-500/20 bg-amber-500/10 px-3 py-1 text-[10px] font-medium uppercase tracking-[0.2em] text-amber-400">
            Most Popular
          </span>
        </div>
      )}

      {/* Plan name + tagline */}
      <div className="text-center">
        <div className="flex items-center justify-center gap-2">
          {plan.popular && (
            <Users className="h-5 w-5 text-amber-400" aria-hidden="true" />
          )}
          <h3 className="text-2xl font-bold tracking-tight text-foreground">
            {plan.name}
          </h3>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">{plan.tagline}</p>
      </div>

      {/* Price */}
      <div className="mt-6 flex items-baseline gap-1 justify-center">
        <span className="text-5xl font-bold tracking-tight text-foreground">
          ${displayPrice}
        </span>
        <span className="text-sm font-normal text-muted-foreground">/mo</span>
      </div>

      {/* Annual savings + per-seat note — fixed height to avoid layout shift */}
      <div className="mt-1 h-4 text-center">
        {annual && plan.savings ? (
          <p className="text-xs text-amber-500/80">
            ${plan.annual}/year (save ${plan.savings})
          </p>
        ) : plan.perSeatNote ? (
          <p className="text-xs text-muted-foreground/50">{plan.perSeatNote}</p>
        ) : null}
      </div>

      {/* Divider */}
      <div
        className={cn(
          "mt-6 h-px",
          plan.popular ? "bg-amber-500/20" : "bg-zinc-800"
        )}
      />

      {/* Feature list */}
      <ul className="mt-6 flex-1 space-y-3">
        {plan.included.map((feature) => (
          <li
            key={feature}
            className={cn(
              "flex items-start gap-3 text-sm",
              feature.endsWith("plus:")
                ? "font-semibold text-zinc-200 pb-1 border-b border-zinc-800/60"
                : "text-zinc-300"
            )}
          >
            {!feature.endsWith("plus:") && (
              <Check
                className={cn(
                  "mt-0.5 h-4 w-4 shrink-0",
                  plan.popular ? "text-amber-400" : "text-amber-500/70"
                )}
              />
            )}
            {feature}
          </li>
        ))}
      </ul>

      {/* CTA button */}
      <div className="mt-8 flex justify-center">
        {plan.popular ? (
          <Button
            asChild
            className="rounded-full px-6 bg-amber-500 font-semibold text-zinc-950 hover:bg-amber-400 active:bg-amber-600 transition-colors"
          >
            <Link href={href}>{plan.cta}</Link>
          </Button>
        ) : (
          <Button
            variant="outline"
            asChild
            className="rounded-full px-6 border-zinc-700 bg-transparent font-medium text-zinc-300 hover:border-zinc-500 hover:text-foreground transition-colors"
          >
            <Link href={href}>{plan.cta}</Link>
          </Button>
        )}
      </div>
    </div>
  )
}
