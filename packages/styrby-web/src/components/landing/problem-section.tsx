import { EyeOff, SmartphoneNfc, Layers } from "lucide-react"

const problems = [
  {
    icon: EyeOff,
    title: "Blind Spending",
    description:
      "AI agents burn through API credits with every session. Without visibility, costs add up before you notice.",
  },
  {
    icon: SmartphoneNfc,
    title: "No Remote Control",
    description:
      "Stuck at your desk waiting for permission prompts. Can't check progress from your phone.",
  },
  {
    icon: Layers,
    title: "Multi-Agent Chaos",
    description:
      "Running Claude, Codex, Gemini, OpenCode, and Aider across projects? Good luck keeping track.",
  },
]

export function ProblemSection() {
  return (
    <section className="py-24">
      <div className="mx-auto max-w-7xl px-6">
        <h2 className="mx-auto max-w-3xl text-balance text-center text-3xl font-bold tracking-tight text-foreground md:text-4xl">
          AI Agents Are Expensive. And You Can{"'"}t See What They{"'"}re Doing.
        </h2>

        <div className="mt-16 grid gap-6 md:grid-cols-3">
          {problems.map((problem) => (
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
    </section>
  )
}
