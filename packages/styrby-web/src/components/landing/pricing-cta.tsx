import Link from "next/link"
import { ArrowRight } from "lucide-react"
import { Button } from "@/components/ui/button"

export function PricingCTA() {
  return (
    <section className="py-24">
      <div className="mx-auto max-w-7xl px-6">
        <div className="relative overflow-hidden rounded-2xl border border-border/60 bg-card/40 px-8 py-16 text-center">
          <div className="absolute inset-0 bg-gradient-to-br from-amber-500/5 via-transparent to-amber-500/5" />
          <div className="relative">
            <h2 className="text-balance text-3xl font-bold tracking-tight text-foreground md:text-4xl">
              Simple, transparent pricing
            </h2>
            <p className="mx-auto mt-4 max-w-md text-muted-foreground leading-relaxed">
              Start free, scale as you grow. No surprises, no hidden fees.
            </p>
            <div className="mt-8">
              <Button
                asChild
                size="lg"
                className="bg-amber-500 px-8 text-background hover:bg-amber-600 font-semibold text-base h-12"
              >
                <Link href="/pricing">
                  View Pricing
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
