import { Layers, SmartphoneNfc, AlertTriangle } from "lucide-react"

/**
 * Problem Section - Hero + Supporting Pair Layout
 *
 * WHY 1+2 over equal 3-col: The primary pain point (fragmented multi-agent chaos)
 * is the emotional hook for developers running production workloads. Giving it a
 * full-width hero card with larger typography creates visual weight that matches
 * its importance. The two secondary problems sit below in a 2-column grid,
 * establishing visual hierarchy: "here is the BIG problem, and two more."
 *
 * WHY these three pain points: They map directly to the three product pillars.
 * No unified view -> Multi-Agent Dashboard. No remote control -> Mobile Remote.
 * Surprise costs -> Smart Cost Tracking. Each problem section primes the reader
 * for the corresponding features section below.
 */

const problems = [
  {
    icon: Layers,
    title: "Five terminals, zero unified view",
    description:
      "Claude Code in one window. Codex in another. Aider in a third. No single place shows what is active, what is stuck, or which session is burning tokens on a loop. You context-switch between terminals to answer 'what is happening right now.'",
    primary: true,
  },
  {
    icon: AlertTriangle,
    title: "Bills you find out about on the 1st",
    description:
      "A runaway loop overnight. A context window blown out at 3am. An unattended Aider session that recompiled its prompt 400 times. The API invoice arrives weeks later. Nothing on your dashboard could have stopped it.",
    primary: false,
  },
  {
    icon: SmartphoneNfc,
    title: "Approvals stuck behind a closed laptop",
    description:
      "Your agent pauses for permission. You are in a meeting, on a flight, walking the dog. The agent waits for hours, or you preemptively grant blanket approval and lose the safety net entirely.",
    primary: false,
  },
]

export function ProblemSection() {
  const primary = problems.find((p) => p.primary)!
  const secondary = problems.filter((p) => !p.primary)

  return (
    <section className="py-16">
      <div className="mx-auto max-w-7xl px-6">
        <h2 className="mx-auto max-w-3xl text-balance text-center text-3xl font-semibold tracking-tighter text-foreground md:text-4xl">
          Three problems the API dashboard{" "}
          <span className="text-amber-500">does not solve.</span>
        </h2>

        <div className="mx-auto mt-16 max-w-5xl space-y-6">
          {/* Primary problem - full width, larger treatment */}
          <div className="gradient-border group rounded-xl bg-card/60 p-8 transition-all duration-200 hover:bg-card md:p-10">
            <div className="flex flex-col gap-5 md:flex-row md:items-start md:gap-8">
              <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl border border-amber-500/20 bg-amber-500/10">
                <primary.icon className="h-7 w-7 text-amber-500" />
              </div>
              <div>
                <h3 className="mb-2 text-xl font-semibold text-foreground">{primary.title}</h3>
                <p className="max-w-xl text-base leading-relaxed text-muted-foreground">
                  {primary.description}
                </p>
              </div>
            </div>
          </div>

          {/* Secondary problems - 2-column grid */}
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            {secondary.map((problem) => (
              <div
                key={problem.title}
                className="gradient-border group rounded-xl bg-card/60 p-8 transition-all duration-200 hover:bg-card"
              >
                <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-secondary">
                  <problem.icon className="h-6 w-6 text-amber-500" />
                </div>
                <h3 className="mb-2 text-lg font-semibold text-foreground">{problem.title}</h3>
                <p className="text-sm leading-relaxed text-muted-foreground">{problem.description}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
