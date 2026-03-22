import Link from "next/link"
import { BarChart3, Shield, LayoutDashboard, ArrowRight } from "lucide-react"

/**
 * Features Section (Homepage)
 *
 * Shows the top 3 features only. Full list lives on /features.
 * Keeps the homepage scannable without overwhelming visitors.
 */

const features = [
  {
    icon: BarChart3,
    title: "Cost Tracking Across Every Agent",
    description:
      "Per-session, per-agent, and per-model breakdowns. Budget limits that enforce themselves. Tag sessions by client for invoicing.",
  },
  {
    icon: Shield,
    title: "Remote Permission Control",
    description:
      "Approve or deny risky actions from your phone. Risk badges tell you what needs attention and what does not.",
  },
  {
    icon: LayoutDashboard,
    title: "Five Agents, One Dashboard",
    description:
      "Claude Code, Codex, Gemini CLI, OpenCode, and Aider in a single view. Live status, session history, and error attribution.",
  },
]

export function FeaturesSection() {
  return (
    <section id="features" className="relative py-16">
      <div className="absolute inset-0 dot-grid opacity-50" />
      <div className="relative mx-auto max-w-7xl px-6">
        <h2 className="mx-auto max-w-3xl text-balance text-center text-3xl font-semibold tracking-tighter text-foreground md:text-4xl">
          Built for Developers Who Run AI Agents in Production
        </h2>

        <div className="mt-12 grid gap-6 md:grid-cols-3">
          {features.map((feature) => (
            <div
              key={feature.title}
              className="gradient-border group rounded-xl bg-card/60 p-7 transition-all duration-200 hover:bg-card"
            >
              <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-amber-500/10 border border-amber-500/20">
                <feature.icon className="h-5 w-5 text-amber-500" />
              </div>
              <h3 className="mb-1.5 text-base font-semibold text-foreground">{feature.title}</h3>
              <p className="text-sm leading-relaxed text-muted-foreground">{feature.description}</p>
            </div>
          ))}
        </div>

        <div className="mt-8 text-center">
          <Link
            href="/features"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-amber-500 hover:text-amber-400 transition-colors"
          >
            See all features
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </div>
    </section>
  )
}
