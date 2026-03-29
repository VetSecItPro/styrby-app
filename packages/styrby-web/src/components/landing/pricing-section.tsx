"use client"

import { useState } from "react"
import Link from "next/link"
import { Check, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * Pricing data for all three tiers.
 *
 * WHY decoy layout: Pro is styled as "most popular" and highlighted with
 * amber - it looks like the obvious choice. Power is priced close enough
 * that informed buyers self-upgrade. Free anchors the low end so $24
 * feels reasonable.
 */
const plans = [
  {
    name: "Free",
    tagline: "For developers exploring",
    monthly: 0,
    annual: 0,
    savings: null,
    popular: false,
    cta: "Start Free",
    ctaVariant: "ghost" as const,
    included: [
      "1 connected machine",
      "3 agents: Claude Code, Codex, Gemini CLI",
      "7-day session history",
      "1,000 messages/month",
      "Cost dashboard",
      "1 budget alert",
      "E2E encryption",
      "Push notifications",
      "Offline queue",
    ],
    notIncluded: [
      "Per-message cost tracking",
      "Session checkpoints",
      "Team management",
      "Voice commands",
    ],
  },
  {
    name: "Pro",
    tagline: "For developers who ship daily",
    monthly: 24,
    annual: 240,
    savings: 48,
    popular: false,
    cta: "Connect 3 Machines",
    ctaVariant: "amber" as const,
    included: [
      "3 connected machines",
      "9 agents (+ OpenCode, Aider, Goose, Amp, Crush, Kilo)",
      "90-day session history",
      "25,000 messages/month",
      "Cost dashboard",
      "Export and import",
      "3 budget alerts",
      "Email support",
    ],
    notIncluded: [],
  },
  {
    name: "Power",
    tagline: "For teams and power users",
    monthly: 59,
    annual: 590,
    savings: 98,
    popular: false,
    cta: "Connect 9 Machines",
    ctaVariant: "outline" as const,
    included: [
      "Everything in Pro, plus:",
      "All 11 agents (+ Kiro and Droid)",
      "9 machines, 5 budget alerts",
      "Session checkpoints and sharing",
      "Per-message costs and context breakdown",
      "Voice commands and cloud monitoring",
      "Code review from mobile",
      "OTEL export (Grafana, Datadog, and more)",
      "Team management (3 members) and API access",
    ],
    notIncluded: [],
  },
]

/**
 * Pricing section for the landing page.
 *
 * Uses a decoy pricing layout: Pro is visually highlighted as the
 * recommended choice, but Power is close enough in price that informed
 * buyers self-select to it. This increases average revenue per user
 * without aggressive upselling.
 *
 * @returns The full pricing section with toggle and three-card layout
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
            One price. Everything included. No per-token fees.
          </h2>
          <p className="mt-4 text-muted-foreground leading-relaxed">
            Flat monthly pricing. Your AI API costs are yours to manage. We
            only charge for Styrby.
          </p>
        </div>

        {/* Annual/monthly toggle */}
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
              Save 2 months
            </span>
          </span>
        </div>

        {/* Cards - Pro is slightly elevated via scale and z-index */}
        <div className="mt-12 grid gap-4 md:grid-cols-3 md:items-stretch">
          {plans.map((plan) => (
            <PricingCard key={plan.name} plan={plan} annual={annual} />
          ))}
        </div>

        {/* Trust footnote */}
        <p className="mt-8 text-center text-xs text-muted-foreground/60">
          14-day free trial on Pro and Power. No credit card required. Cancel anytime.
        </p>
      </div>
    </section>
  )
}

/**
 * Individual pricing card.
 *
 * @param plan - The plan data to render
 * @param annual - Whether annual billing is selected
 */
function PricingCard({
  plan,
  annual,
}: {
  plan: (typeof plans)[number]
  annual: boolean
}) {
  const displayPrice =
    annual && plan.annual > 0 ? Math.round(plan.annual / 12) : plan.monthly

  return (
    <div
      className={cn(
        "relative flex flex-col rounded-2xl px-8 py-6 transition-all duration-300",
        plan.popular
          ? // Pro: amber border, subtle amber bloom behind the card, slightly taller via py
            "border border-amber-500/40 bg-zinc-950 amber-glow md:-my-4 md:py-12 z-10"
          : // Free and Power: true black with faint zinc border, inner glow on hover
            "border border-zinc-800/80 bg-zinc-950/60 hover:border-zinc-700/80 hover:bg-zinc-950/80"
      )}
    >
      {/* Ambient radial glow behind Pro card */}
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
        <h3 className="text-2xl font-bold tracking-tight text-foreground">
          {plan.name}
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">{plan.tagline}</p>
      </div>

      {/* Price */}
      <div className="mt-6 flex items-baseline gap-1">
        <span className="text-5xl font-bold tracking-tight text-foreground">
          ${displayPrice}
        </span>
        {plan.monthly > 0 && (
          <span className="text-sm font-normal text-muted-foreground">/mo</span>
        )}
        {plan.monthly === 0 && (
          <span className="text-sm font-normal text-muted-foreground">forever</span>
        )}
      </div>

      {/* Annual savings line - always reserve height to prevent layout shift */}
      <div className="mt-1 h-4">
        {annual && plan.savings ? (
          <p className="text-xs text-amber-500/80">
            ${plan.annual}/year (save ${plan.savings})
          </p>
        ) : null}
      </div>

      {/* Divider */}
      <div
        className={cn(
          "mt-6 h-px",
          plan.popular ? "bg-amber-500/20" : "bg-zinc-800"
        )}
      />

      {/* Feature list - included */}
      <ul className="mt-6 flex-1 space-y-3">
        {plan.included.map((feature, i) => (
          <li
            key={feature}
            className={cn(
              "flex items-start gap-3 text-sm",
              feature.endsWith("plus:") ? "font-semibold text-zinc-200 pb-1 border-b border-zinc-800/60" : "text-zinc-300"
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

        {/* Not included (Free only) */}
        {plan.notIncluded.length > 0 &&
          plan.notIncluded.map((feature) => (
            <li
              key={feature}
              className="flex items-start gap-3 text-sm text-zinc-500"
            >
              <X className="mt-0.5 h-4 w-4 shrink-0 text-zinc-700" />
              {feature}
            </li>
          ))}
      </ul>

      {/* CTA button */}
      <div className="mt-8 flex justify-center">
        {plan.ctaVariant === "ghost" ? (
          <Button
            variant="outline"
            asChild
            className="rounded-full px-6 border-zinc-700 bg-transparent font-medium text-zinc-300 hover:border-zinc-500 hover:text-foreground transition-colors"
          >
            <Link href="/signup">{plan.cta}</Link>
          </Button>
        ) : (
          <Button
            asChild
            className="rounded-full px-6 bg-amber-500 font-semibold text-zinc-950 hover:bg-amber-400 active:bg-amber-600 transition-colors"
          >
            <Link href={`/signup?plan=${plan.name.toLowerCase()}`}>
              {plan.cta}
            </Link>
          </Button>
        )}
      </div>
    </div>
  )
}
