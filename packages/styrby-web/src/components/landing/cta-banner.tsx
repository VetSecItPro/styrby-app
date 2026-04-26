import Link from "next/link"
import { ArrowRight } from "lucide-react"
import { Button } from "@/components/ui/button"

/**
 * CTA Banner - final conversion section before the footer.
 *
 * WHY minimal copy: visitors who scroll this far have already read the
 * feature list and pricing. A single bold statement and one button
 * removes friction. Extra copy at this stage adds noise, not value.
 */
export function CTABanner() {
  return (
    <section className="relative overflow-hidden py-28">
      {/* Ambient amber mesh gradient */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 80% 60% at 50% 50%, rgba(245,158,11,0.06) 0%, transparent 70%)",
        }}
        aria-hidden="true"
      />

      {/* Subtle dot grid texture */}
      <div className="pointer-events-none absolute inset-0 dot-grid opacity-20" aria-hidden="true" />

      {/* Top and bottom fade - blends into surrounding sections */}
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-24"
        style={{
          background: "linear-gradient(to bottom, hsl(240 6% 3.5%), transparent)",
        }}
        aria-hidden="true"
      />
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 h-24"
        style={{
          background: "linear-gradient(to top, hsl(240 6% 3.5%), transparent)",
        }}
        aria-hidden="true"
      />

      <div className="relative mx-auto max-w-3xl px-6 text-center">
        <h2 className="text-balance text-4xl font-bold tracking-tight text-foreground md:text-5xl">
          Start monitoring your agents in 90 seconds
        </h2>

        <div className="mt-10">
          <Button
            asChild
            size="lg"
            className="h-13 bg-amber-500 px-10 text-base font-semibold text-zinc-950 shadow-lg shadow-amber-500/20 hover:bg-amber-400 active:bg-amber-600 transition-colors"
          >
            <Link href="/signup">
              Pair my first agent
              <ArrowRight className="ml-2 h-4 w-4" />
            </Link>
          </Button>
        </div>

        <p className="mt-4 text-sm text-muted-foreground/60">
          Free on one machine. No credit card.
        </p>
      </div>
    </section>
  )
}
