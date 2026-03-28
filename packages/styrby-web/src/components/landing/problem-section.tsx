import { Layers, SmartphoneNfc, AlertTriangle } from "lucide-react"

/**
 * Problem Section — Hero + Supporting Pair Layout
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
    title: "No Unified View",
    description:
      "Running 5+ agents across projects with no single place to see what is active, what is stuck, and what is burning tokens on a loop. You are context-switching between terminals to figure out basic status.",
    primary: true,
  },
  {
    icon: AlertTriangle,
    title: "Surprise Bills",
    description:
      "Getting paged at 2am because an agent ran up $400 in tokens overnight. By the time the invoice arrives, the damage is done and there was no way to stop it remotely.",
    primary: false,
  },
  {
    icon: SmartphoneNfc,
    title: "Laptop-Tethered Approvals",
    description:
      "No way to approve risky permissions without being at your desk. Your agent sits idle for hours — or worse, proceeds without approval — while you are away from your machine.",
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
          Running AI Agents at Scale{" "}
          <span className="text-amber-500">Is Harder Than It Should Be.</span>
        </h2>

        <div className="mx-auto mt-16 max-w-5xl space-y-6">
          {/* Primary problem — full width, larger treatment */}
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

          {/* Secondary problems — 2-column grid */}
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
