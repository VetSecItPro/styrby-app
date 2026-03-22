/**
 * Mobile Showcase Section
 *
 * Shows two mobile screenshots in phone frames to prove the app
 * works on phones. Key differentiator vs. competitors.
 */

export function MobileShowcase() {
  return (
    <section className="py-8">
      <div className="mx-auto max-w-7xl px-6">
        <h2 className="text-center text-3xl font-semibold tracking-tighter text-foreground md:text-4xl">
          Control Your Agents From Anywhere
        </h2>
        <p className="mx-auto mt-3 max-w-lg text-center text-sm text-muted-foreground">
          Approve permissions, track costs, and monitor sessions from your phone. No laptop required.
        </p>

        <div className="mt-12 flex flex-col items-center justify-center gap-8 sm:flex-row sm:gap-12">
          {/* Phone frame: Dashboard */}
          <div className="relative">
            <div className="relative w-[280px] overflow-hidden rounded-[2rem] border-[6px] border-zinc-700 bg-zinc-900 shadow-2xl">
              {/* Notch */}
              <div className="absolute left-1/2 top-0 z-10 h-6 w-24 -translate-x-1/2 rounded-b-xl bg-zinc-700" />
              <img
                src="/screenshots/mobile-dashboard.png"
                alt="Styrby mobile dashboard showing today's spend, active sessions, and recent agent activity"
                className="w-full"
                width={390}
                height={844}
              />
            </div>
            <p className="mt-3 text-center text-xs text-muted-foreground">Dashboard</p>
          </div>

          {/* Phone frame: Cost Analytics */}
          <div className="relative">
            <div className="relative w-[280px] overflow-hidden rounded-[2rem] border-[6px] border-zinc-700 bg-zinc-900 shadow-2xl">
              {/* Notch */}
              <div className="absolute left-1/2 top-0 z-10 h-6 w-24 -translate-x-1/2 rounded-b-xl bg-zinc-700" />
              <img
                src="/screenshots/mobile-costs.png"
                alt="Styrby mobile cost analytics showing monthly total, per-agent breakdown, and spending chart"
                className="w-full"
                width={390}
                height={844}
              />
            </div>
            <p className="mt-3 text-center text-xs text-muted-foreground">Cost Analytics</p>
          </div>
        </div>
      </div>
    </section>
  )
}
