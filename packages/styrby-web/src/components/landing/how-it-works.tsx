/**
 * How It Works Section — Vertical Staggered Timeline Layout
 *
 * WHY staggered over equal 3-col: Equal columns force all three steps to
 * compete for attention simultaneously. A vertical timeline creates a natural
 * reading sequence: the user flows top-to-bottom, understanding causality
 * (step 1 enables step 2 which enables step 3). Alternating left/right
 * placement on desktop adds visual interest while preserving the narrative.
 *
 * WHY CSS-only illustrations: Avoids image load latency and CLS. The terminal
 * mockup, QR frame, and dashboard card are composed entirely of styled divs
 * and Tailwind utility classes — they render instantly, scale perfectly on
 * any DPR, and match the brand without a design asset pipeline.
 */

/** Individual step definition */
interface Step {
  number: string
  title: string
  description: string
  /** Which side the illustration appears on desktop */
  illustrationSide: "left" | "right"
  illustration: React.ReactNode
}

// ---------------------------------------------------------------------------
// CSS-only illustration components
// ---------------------------------------------------------------------------

/**
 * Terminal mockup showing the install command.
 * Mimics a macOS terminal window with a title bar and blinking cursor.
 */
function TerminalMockup() {
  return (
    <div className="w-full max-w-sm overflow-hidden rounded-xl border border-white/[0.08] bg-black shadow-[0_20px_60px_rgba(0,0,0,0.6)]">
      {/* Title bar */}
      <div className="flex items-center gap-2 border-b border-white/[0.06] bg-zinc-900/80 px-4 py-3">
        <span className="h-3 w-3 rounded-full bg-red-500/70" />
        <span className="h-3 w-3 rounded-full bg-yellow-500/70" />
        <span className="h-3 w-3 rounded-full bg-emerald-500/70" />
        <span className="ml-2 font-mono text-xs text-zinc-500">terminal</span>
      </div>
      {/* Body */}
      <div className="px-5 py-4">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-emerald-400">$</span>
          <span className="font-mono text-xs text-zinc-200">npm install -g @styrby/cli</span>
        </div>
        <div className="mt-2 font-mono text-xs text-zinc-500">
          added 1 package in 2.3s
        </div>
        <div className="mt-1 font-mono text-xs text-amber-400">
          Styrby CLI v1.0.0 installed
        </div>
        <div className="mt-3 flex items-center gap-2">
          <span className="font-mono text-xs text-emerald-400">$</span>
          <span className="font-mono text-xs text-zinc-200">styrby connect</span>
          {/* Blinking cursor */}
          <span className="h-3.5 w-px animate-pulse bg-zinc-400" />
        </div>
      </div>
    </div>
  )
}

/**
 * Phone-and-QR mockup showing the pairing step.
 * Uses nested rounded rectangles to suggest a phone frame and QR grid.
 */
function PairingMockup() {
  return (
    <div className="flex w-full max-w-sm items-center justify-center gap-8">
      {/* QR code frame */}
      <div className="rounded-xl border border-white/[0.08] bg-zinc-950 p-4 shadow-[0_20px_60px_rgba(0,0,0,0.5)]">
        <div className="mb-2 font-mono text-[10px] text-zinc-500">Scan to pair</div>
        {/* QR grid — 5×5 block pattern suggesting a QR code */}
        <div className="grid grid-cols-7 gap-0.5">
          {[
            1,1,1,1,1,1,1,
            1,0,0,0,0,0,1,
            1,0,1,0,1,0,1,
            1,0,0,1,0,0,1,
            1,0,1,0,1,0,1,
            1,0,0,0,0,0,1,
            1,1,1,1,1,1,1,
          ].map((filled, i) => (
            <div
              key={i}
              className={`h-3.5 w-3.5 rounded-sm ${filled ? "bg-amber-400" : "bg-zinc-800"}`}
            />
          ))}
        </div>
        <div className="mt-2 font-mono text-[10px] text-zinc-500">expires in 2:00</div>
      </div>

      {/* Phone outline */}
      <div className="flex h-28 w-14 flex-col items-center justify-center rounded-xl border-2 border-white/[0.12] bg-zinc-900/60">
        {/* Camera notch */}
        <div className="mb-1 h-1 w-5 rounded-full bg-zinc-700" />
        {/* Screen content suggestion */}
        <div className="flex h-16 w-10 flex-col items-center justify-center gap-1 rounded-lg bg-zinc-800/60 p-1">
          <div className="h-1.5 w-7 rounded-full bg-amber-500/40" />
          <div className="h-1.5 w-5 rounded-full bg-zinc-600" />
          <div className="h-1.5 w-6 rounded-full bg-zinc-600" />
        </div>
      </div>
    </div>
  )
}

/**
 * Dashboard card mockup showing the final connected state.
 * Shows an agent status card with health indicators.
 */
function DashboardMockup() {
  return (
    <div className="w-full max-w-sm overflow-hidden rounded-xl border border-white/[0.08] bg-zinc-950 shadow-[0_20px_60px_rgba(0,0,0,0.6)]">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-3">
        <span className="font-mono text-xs text-zinc-400">styrby dashboard</span>
        <span className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
          <span className="font-mono text-xs text-emerald-400">live</span>
        </span>
      </div>
      {/* Agent cards */}
      <div className="space-y-2 p-4">
        {[
          { name: "claude-code", model: "sonnet-4-5", cost: "$0.42", status: "running" },
          { name: "codex",       model: "o3-mini",    cost: "$0.18", status: "running" },
          { name: "aider",       model: "gpt-4o",     cost: "$0.07", status: "idle"    },
        ].map((agent) => (
          <div
            key={agent.name}
            className="flex items-center justify-between rounded-lg border border-white/[0.05] bg-white/[0.03] px-3 py-2"
          >
            <div className="flex items-center gap-2.5">
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                  agent.status === "running" ? "bg-emerald-400" : "bg-zinc-600"
                }`}
              />
              <div>
                <div className="font-mono text-xs text-zinc-300">{agent.name}</div>
                <div className="font-mono text-[10px] text-zinc-500">{agent.model}</div>
              </div>
            </div>
            <span className="font-mono text-xs text-amber-400">{agent.cost}</span>
          </div>
        ))}
      </div>
      {/* Footer summary */}
      <div className="flex items-center justify-between border-t border-white/[0.06] px-5 py-3">
        <span className="font-mono text-xs text-zinc-500">today</span>
        <span className="font-mono text-xs text-amber-400">$0.67 total</span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Steps data
// ---------------------------------------------------------------------------

const steps: Step[] = [
  {
    number: "01",
    title: "Install the CLI",
    description:
      "One command alongside your existing agent setup. Zero config changes required — Styrby wraps your agents without touching them.",
    illustrationSide: "right",
    illustration: <TerminalMockup />,
  },
  {
    number: "02",
    title: "Sign In and Pair Your Phone",
    description:
      "Sign in with GitHub or email, then scan the QR code to link your phone. The CLI walks you through the E2E key exchange in under 60 seconds.",
    illustrationSide: "left",
    illustration: <PairingMockup />,
  },
  {
    number: "03",
    title: "Control Everything From Anywhere",
    description:
      "Live agent status, real-time cost tracking, permission approvals, code review diffs — all encrypted and available from your phone or web dashboard.",
    illustrationSide: "right",
    illustration: <DashboardMockup />,
  },
]

export function HowItWorks() {
  return (
    <section id="how-it-works" className="scroll-mt-20 py-16 md:py-24">
      <div className="mx-auto max-w-7xl px-6">
        <h2 className="text-balance text-center text-3xl font-bold tracking-tight text-foreground md:text-4xl">
          Three Steps. Ninety Seconds. Done.
        </h2>
        <p className="mx-auto mt-4 max-w-lg text-center text-sm text-muted-foreground">
          Install once. Pair your phone. Your agents are under control from that moment forward.
        </p>

        {/* Vertical timeline */}
        <div className="relative mx-auto mt-20 max-w-5xl">
          {/* Vertical connector line — desktop only */}
          <div className="absolute left-1/2 top-0 hidden h-full w-px -translate-x-1/2 bg-gradient-to-b from-amber-500/20 via-amber-500/10 to-transparent md:block" />

          <div className="space-y-20">
            {steps.map((step) => {
              const isLeft = step.illustrationSide === "left"

              return (
                <div key={step.number} className="relative">
                  {/* Step number node on the timeline — desktop only */}
                  <div className="absolute left-1/2 top-0 hidden -translate-x-1/2 -translate-y-1/2 items-center justify-center md:flex">
                    <div className="flex h-9 w-9 items-center justify-center rounded-full border border-amber-500/30 bg-zinc-950 shadow-[0_0_0_4px_rgba(245,158,11,0.06)]">
                      <span className="font-mono text-xs font-bold text-amber-500">{step.number}</span>
                    </div>
                  </div>

                  {/*
                    Two-column layout on desktop.
                    isLeft: illustration left, text right.
                    !isLeft: text left, illustration right.
                  */}
                  <div
                    className={`flex flex-col gap-10 md:grid md:grid-cols-2 md:items-center md:gap-16 ${
                      isLeft ? "md:flex-row-reverse" : ""
                    }`}
                  >
                    {/* Text block */}
                    <div className={isLeft ? "md:order-2" : "md:order-1"}>
                      {/* Step number — mobile only */}
                      <span className="mb-3 block font-mono text-4xl font-bold text-amber-500/20 md:hidden">
                        {step.number}
                      </span>
                      <h3 className="text-xl font-semibold text-foreground md:text-2xl">
                        {step.title}
                      </h3>
                      <p className="mt-3 text-sm leading-relaxed text-muted-foreground md:text-base">
                        {step.description}
                      </p>
                    </div>

                    {/* Illustration block */}
                    <div
                      className={`flex justify-center ${
                        isLeft ? "md:order-1 md:justify-end" : "md:order-2 md:justify-start"
                      }`}
                    >
                      {step.illustration}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </section>
  )
}
