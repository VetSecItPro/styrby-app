"use client"

import { useState } from "react"
import Link from "next/link"
import { Check } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

const plans = [
  {
    name: "Free",
    monthly: 0,
    annual: 0,
    savings: null,
    popular: false,
    cta: "Get Started",
    ctaVariant: "outline" as const,
    features: [
      "1 connected machine",
      "1 AI agent",
      "7-day session history",
      "1,000 messages/month",
      "Basic cost view",
    ],
  },
  {
    name: "Pro",
    monthly: 19,
    annual: 190,
    savings: 38,
    popular: true,
    cta: "Start Free Trial",
    ctaVariant: "default" as const,
    features: [
      "5 connected machines",
      "All 5 AI agents",
      "90-day session history",
      "25,000 messages/month",
      "Full cost dashboard",
      "3 budget alerts",
      "Email support",
    ],
  },
  {
    name: "Power",
    monthly: 49,
    annual: 490,
    savings: 98,
    popular: false,
    cta: "Start Free Trial",
    ctaVariant: "default" as const,
    features: [
      "15 connected machines",
      "All 5 AI agents",
      "1-year session history",
      "100,000 messages/month",
      "Full cost dashboard",
      "10 budget alerts",
      "5 team members",
      "API access",
      "Priority support",
    ],
  },
]

export function PricingSection() {
  const [annual, setAnnual] = useState(false)

  return (
    <section id="pricing" className="py-24">
      <div className="mx-auto max-w-7xl px-6">
        <h2 className="text-balance text-center text-3xl font-bold tracking-tight text-foreground md:text-4xl">
          Simple, Transparent Pricing
        </h2>

        {/* Toggle */}
        <div className="mt-8 flex items-center justify-center gap-3">
          <span className={cn("text-sm", !annual ? "text-foreground" : "text-muted-foreground")}>Monthly</span>
          <button
            type="button"
            onClick={() => setAnnual(!annual)}
            className={cn(
              "relative h-6 w-11 rounded-full transition-colors duration-200",
              annual ? "bg-amber-500" : "bg-secondary"
            )}
            role="switch"
            aria-checked={annual}
            aria-label="Toggle annual billing"
          >
            <span
              className={cn(
                "absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-foreground transition-transform duration-200",
                annual && "translate-x-5"
              )}
            />
          </button>
          <span className={cn("text-sm", annual ? "text-foreground" : "text-muted-foreground")}>
            Annual <span className="text-xs text-amber-500">(Save up to $98)</span>
          </span>
        </div>

        <div className="mt-12 grid gap-6 md:grid-cols-3">
          {plans.map((plan) => (
            <div
              key={plan.name}
              className={cn(
                "relative rounded-xl bg-card/60 p-8 transition-all duration-200",
                plan.popular
                  ? "border-2 border-amber-500/50 amber-glow"
                  : "border border-border/60"
              )}
            >
              {plan.popular && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-amber-500 px-3 py-1 text-xs font-semibold text-background">
                  Most Popular
                </div>
              )}

              <h3 className="text-xl font-semibold text-foreground">{plan.name}</h3>
              <div className="mt-4 flex items-baseline gap-1">
                <span className="font-mono text-4xl font-bold text-foreground">
                  ${annual && plan.annual > 0 ? Math.round(plan.annual / 12) : plan.monthly}
                </span>
                {plan.monthly > 0 && <span className="text-sm text-muted-foreground">/month</span>}
              </div>
              {annual && plan.savings && (
                <p className="mt-1 text-xs text-amber-500">
                  ${plan.annual}/year — save ${plan.savings}
                </p>
              )}

              <ul className="mt-8 space-y-3">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex items-center gap-3 text-sm text-muted-foreground">
                    <Check className="h-4 w-4 shrink-0 text-amber-500" />
                    {feature}
                  </li>
                ))}
              </ul>

              <div className="mt-8">
                {plan.ctaVariant === "default" ? (
                  <Button asChild className="w-full bg-amber-500 text-background hover:bg-amber-600 font-medium">
                    <Link href="/signup">{plan.cta}</Link>
                  </Button>
                ) : (
                  <Button variant="outline" asChild className="w-full border-border/60 text-muted-foreground hover:text-foreground bg-transparent">
                    <Link href="/signup">{plan.cta}</Link>
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
