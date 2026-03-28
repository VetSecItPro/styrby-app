import { Eye, ShieldAlert, BarChart3 } from "lucide-react"

/**
 * Cost Savings Section — Alternating Zig-Zag Layout
 *
 * WHY zig-zag over equal 3-col: Each value prop gets a full-width row with
 * icon on one side and text on the other, alternating sides. This creates
 * a natural reading rhythm that prevents the monotony of scanning three
 * identical cards. The zig-zag also works better on mobile — each prop
 * stacks as a single card instead of three cards fighting for width.
 */

const valueProps = [
  {
    icon: Eye,
    title: "Per-agent, per-session, per-model costs",
    description:
      "Spend tracking across all eleven agents, updated on every page load. Tag sessions by client or project. See exactly which session is eating your budget today, not at the end of the month.",
  },
  {
    icon: ShieldAlert,
    title: "Budget limits that enforce themselves",
    description:
      "Set daily or monthly caps per agent. Styrby warns you at your threshold, throttles the agent if you want, or kills the session automatically. Your call.",
  },
  {
    icon: BarChart3,
    title: "Token-level breakdowns",
    description:
      "Input tokens, output tokens, cache hits. See which sessions consume the most and filter by agent, model, or tags. Find the $40 session hiding in a $200 month.",
  },
]

export function CostSavings() {
  return (
    <section className="relative py-16">
      <div className="absolute inset-0 dot-grid opacity-50" />
      <div className="relative mx-auto max-w-7xl px-6">
        <h2 className="mx-auto max-w-2xl text-balance text-center text-3xl font-semibold tracking-tighter text-foreground md:text-4xl">
          Your AI Spend, Visible and{" "}
          <span className="text-amber-500">Under Control</span>
        </h2>
        <p className="mx-auto mt-4 max-w-xl text-center text-muted-foreground leading-relaxed">
          The average developer using AI agents has no idea what they spent last month. Styrby changes that.
        </p>

        {/* Alternating zig-zag rows — varied widths, offset positions */}
        <div className="mx-auto mt-16 max-w-5xl space-y-6">
          {valueProps.map((prop, index) => {
            // Alternate: left-aligned (75%), right-aligned (70%), left-aligned (65%)
            const widths = ["md:max-w-[75%]", "md:max-w-[70%]", "md:max-w-[65%]"]
            const alignment = index % 2 === 1 ? "md:ml-auto" : ""

            return (
              <div
                key={prop.title}
                className={`gradient-border group rounded-xl bg-card/60 p-7 transition-all duration-200 hover:bg-card ${widths[index]} ${alignment}`}
              >
                <div className={`flex flex-col gap-4 md:flex-row md:items-start md:gap-6 ${
                  index % 2 === 1 ? "md:flex-row-reverse" : ""
                }`}>
                  <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-amber-500/10 border border-amber-500/20">
                    <prop.icon className="h-6 w-6 text-amber-500" />
                  </div>
                  <div>
                    <h3 className="mb-1.5 text-lg font-semibold text-foreground">{prop.title}</h3>
                    <p className="text-sm leading-relaxed text-muted-foreground">{prop.description}</p>
                  </div>
                </div>
              </div>
            )
          })}
        </div>

        {/* Cost analytics screenshot */}
        <div className="mx-auto mt-10 md:max-w-[85%]">
          <img
            src="/screenshots/cost-analytics.png"
            alt="Cost analytics showing 30-day spending trend across AI agents"
            className="w-full rounded-xl border border-border/40 shadow-lg"
            width={1440}
            height={900}
          />
        </div>
      </div>
    </section>
  )
}
