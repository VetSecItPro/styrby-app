import Link from "next/link"
import { ArrowRight } from "lucide-react"
import { Button } from "@/components/ui/button"

export function PricingCTA() {
  return (
    <section className="py-12">
      <div className="mx-auto max-w-7xl px-6">
        <div className="relative mx-auto overflow-hidden rounded-2xl border border-border/60 bg-card/40 px-8 py-12 text-center md:max-w-[75%]">
          <div className="absolute inset-0 bg-gradient-to-br from-amber-500/5 via-transparent to-amber-500/5" />
          <div className="relative">
            <h2 className="text-balance text-3xl font-bold tracking-tight text-foreground md:text-4xl">
              Pro when you ship solo. Growth when your team scales.
            </h2>
            <p className="mx-auto mt-4 max-w-md text-muted-foreground leading-relaxed">
              {/* WHY this phrasing: the Phase 6 tier reconciliation collapsed
                  the public ladder to Pro ($39/mo) + Growth ($99/mo, 3 seats
                  included). The CTA now frames the upgrade trigger
                  (team scaling) cleanly and stays in sync with /pricing. */}
              Start a 14-day Pro trial. No credit card. Move to Growth the moment a second developer joins.
            </p>
            <div className="mt-8">
              <Button
                asChild
                size="lg"
                className="bg-amber-500 px-8 text-background hover:bg-amber-600 font-semibold text-base h-12"
              >
                <Link href="/pricing">
                  See pricing
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
