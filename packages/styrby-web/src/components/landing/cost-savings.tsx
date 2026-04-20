import Image from "next/image"
import { Eye, ShieldAlert, BarChart3 } from "lucide-react"

/**
 * Cost Savings Section - Alternating Zig-Zag Layout
 *
 * WHY this comes AFTER features and mobile showcase: Cost tracking is a
 * supporting benefit, not the primary value proposition. The story is remote
 * control + session management first. Once the reader is sold on the core
 * product, this section adds "oh, and it tracks every dollar too" as a
 * bonus that seals the decision. Placing it here prevents leading with a
 * frugality pitch that undersells the broader product.
 *
 * WHY zig-zag over equal 3-col: Each value prop gets a full-width row with
 * icon on one side and text on the other, alternating sides. This creates
 * a natural reading rhythm that prevents the monotony of scanning three
 * identical cards. The zig-zag also works better on mobile - each prop
 * stacks as a single card instead of three cards fighting for width.
 */

const valueProps = [
  {
    icon: Eye,
    title: "Per-agent, per-session, per-message costs",
    description:
      "Spend tracking across all eleven agents, updated on every page load. Tag sessions by client or project. See exactly which session is eating your budget today, not at the end of the month.",
  },
  {
    icon: ShieldAlert,
    title: "Budget limits that enforce themselves",
    description:
      "Set daily or monthly caps per agent. Styrby warns you at your threshold, throttles the agent if you want, or kills the session automatically. No more 2am surprises on your invoice.",
  },
  {
    icon: BarChart3,
    title: "Dynamic pricing for 300+ models",
    description:
      "Token-level breakdowns with input, output, and cache costs. Model pricing updates automatically. Find the $40 session hiding in a $200 month, then set a budget alert so it never happens again.",
  },
]

export function CostSavings() {
  return (
    <section className="relative py-16">
      <div className="absolute inset-0 dot-grid opacity-50" />
      <div className="relative mx-auto max-w-7xl px-6">
        {/* Reframed heading - cost as a supporting benefit, not the lead */}
        <h2 className="mx-auto max-w-2xl text-balance text-center text-3xl font-semibold tracking-tighter text-foreground md:text-4xl">
          Oh, and It Tracks Every Dollar Too
        </h2>
        <p className="mx-auto mt-4 max-w-xl text-center leading-relaxed text-muted-foreground">
          Real-time cost visibility across all agents, with budget controls that actually work.
          Because knowing is only useful if you can act on it.
        </p>

        {/* Alternating zig-zag rows - varied widths, offset positions */}
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
                <div
                  className={`flex flex-col gap-4 md:flex-row md:items-start md:gap-6 ${
                    index % 2 === 1 ? "md:flex-row-reverse" : ""
                  }`}
                >
                  <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-amber-500/20 bg-amber-500/10">
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

        {/* Cost analytics screenshot - kept as reference for real screenshot later */}
        <div className="mx-auto mt-10 md:max-w-[85%]">
          <Image
            src="/screenshots/cost-analytics.webp"
            alt="Cost analytics showing 30-day spending trend across AI agents"
            className="w-full rounded-xl border border-border/40 shadow-lg"
            width={1440}
            height={900}
            sizes="(max-width: 768px) 100vw, (max-width: 1200px) 85vw, 1200px"
            priority
          />
        </div>
      </div>
    </section>
  )
}
