import { Eye, ShieldAlert, BarChart3 } from "lucide-react"

const valueProps = [
  {
    icon: Eye,
    title: "See every dollar",
    description:
      "Track spending per agent, per session, per project in real time. No more guessing what your AI tools cost at the end of the month.",
  },
  {
    icon: ShieldAlert,
    title: "Set budgets before you overspend",
    description:
      "Configure daily and monthly spend limits per agent. Get notified when you approach thresholds, and auto-pause agents that exceed them.",
  },
  {
    icon: BarChart3,
    title: "Understand where tokens go",
    description:
      "Break down input, output, and cache token usage across all five agents. Identify which sessions and projects consume the most resources.",
  },
]

export function CostSavings() {
  return (
    <section className="relative py-24">
      <div className="absolute inset-0 dot-grid opacity-50" />
      <div className="relative mx-auto max-w-7xl px-6">
        <h2 className="mx-auto max-w-2xl text-balance text-center text-3xl font-bold tracking-tight text-foreground md:text-4xl">
          Know exactly what your AI agents cost.{" "}
          <span className="text-amber-500">Set budgets before you overspend.</span>
        </h2>
        <p className="mx-auto mt-4 max-w-xl text-center text-muted-foreground leading-relaxed">
          AI coding agents can run up costs quickly. Styrby gives you the visibility and controls to stay on top of every token.
        </p>

        <div className="mx-auto mt-16 grid max-w-5xl gap-8 md:grid-cols-3">
          {valueProps.map((prop) => (
            <div
              key={prop.title}
              className="gradient-border rounded-xl bg-card/60 p-8 transition-all duration-200 hover:bg-card"
            >
              <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-secondary">
                <prop.icon className="h-6 w-6 text-amber-500" />
              </div>
              <h3 className="mb-2 text-lg font-semibold text-foreground">{prop.title}</h3>
              <p className="text-sm leading-relaxed text-muted-foreground">{prop.description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
