import Link from "next/link"
import { Button } from "@/components/ui/button"

export function CTABanner() {
  return (
    <section className="relative overflow-hidden py-24">
      <div className="absolute inset-0 bg-gradient-to-r from-amber-500/10 via-amber-500/5 to-transparent" />
      <div className="absolute inset-0 dot-grid opacity-30" />

      <div className="relative mx-auto max-w-7xl px-6 text-center">
        <h2 className="mx-auto max-w-2xl text-balance text-3xl font-bold tracking-tight text-foreground md:text-4xl">
          Stop guessing what your AI agents are costing you.
        </h2>
        <div className="mt-8">
          <Button asChild size="lg" className="bg-amber-500 px-10 text-background hover:bg-amber-600 font-semibold text-base h-12">
            <Link href="/signup">Start Free</Link>
          </Button>
        </div>
      </div>
    </section>
  )
}
