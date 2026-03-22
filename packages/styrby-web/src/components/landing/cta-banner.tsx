import Link from "next/link"
import { Button } from "@/components/ui/button"

export function CTABanner() {
  return (
    <section className="py-12">
      <div className="mx-auto max-w-7xl px-6">
        <div className="relative mx-auto overflow-hidden rounded-2xl border border-border/60 bg-card/40 px-8 py-12 text-center md:max-w-[70%]">
          <div className="absolute inset-0 bg-gradient-to-r from-amber-500/10 via-amber-500/5 to-transparent" />
          <div className="absolute inset-0 dot-grid opacity-30" />

          <div className="relative">
            <h2 className="mx-auto max-w-2xl text-balance text-3xl font-bold tracking-tight text-foreground md:text-4xl">
              Your agents are running right now. Do you know what they cost?
            </h2>
            <p className="mx-auto mt-4 max-w-md text-muted-foreground leading-relaxed">
              Install the CLI, scan the QR code, and find out in 90 seconds.
            </p>
            <div className="mt-8">
              <Button asChild size="lg" className="bg-amber-500 px-10 text-background hover:bg-amber-600 font-semibold text-base h-12">
                <Link href="/signup">Connect Your First Agent</Link>
              </Button>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
