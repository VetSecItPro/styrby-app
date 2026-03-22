import { EyeOff, SmartphoneNfc, Layers } from "lucide-react"

/**
 * Problem Section — Hero + Supporting Pair Layout
 *
 * WHY 1+2 over equal 3-col: The primary pain point (blind spending) is the
 * emotional hook. Giving it a full-width hero card with larger typography
 * creates visual weight that matches its importance. The two secondary
 * problems sit below in a 2-column grid, establishing visual hierarchy
 * that guides the user: "here's the BIG problem, and two more."
 */

const problems = [
  {
    icon: EyeOff,
    title: "Blind Spending",
    description:
      "Most developers have no idea what their AI agents cost per session. By the time the invoice arrives, the damage is done.",
    primary: true,
  },
  {
    icon: SmartphoneNfc,
    title: "No Remote Control",
    description:
      "Your agent needs approval, but you stepped away. Now it sits idle until you walk back to your laptop.",
    primary: false,
  },
  {
    icon: Layers,
    title: "Multi-Agent Chaos",
    description:
      "Five agents across three projects on two machines. Which ones are active? Which are stuck? Which are burning tokens on a loop? You have no idea.",
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
          You{"'"}re Running AI Agents Blind.{" "}
          <span className="text-amber-500">That Gets Expensive Fast.</span>
        </h2>

        <div className="mx-auto mt-16 max-w-5xl space-y-6">
          {/* Primary problem — full width, larger treatment */}
          <div className="gradient-border group rounded-xl bg-card/60 p-8 transition-all duration-200 hover:bg-card md:p-10">
            <div className="flex flex-col gap-5 md:flex-row md:items-start md:gap-8">
              <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-amber-500/10 border border-amber-500/20">
                <primary.icon className="h-7 w-7 text-amber-500" />
              </div>
              <div>
                <h3 className="mb-2 text-xl font-semibold text-foreground">{primary.title}</h3>
                <p className="max-w-xl text-base leading-relaxed text-muted-foreground">{primary.description}</p>
              </div>
            </div>
          </div>

          {/* Secondary problems — 2-column grid */}
          <div className="grid gap-6 md:grid-cols-2">
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
