import Link from "next/link"
import {
  LayoutDashboard,
  Smartphone,
  FolderOpen,
  BarChart3,
  GitBranch,
  Bell,
  Activity,
  Code2,
  ArrowRight,
} from "lucide-react"

/**
 * Features Section (Homepage) - Bento Grid Layout
 *
 * WHY bento over equal-column grid: The multi-agent dashboard is the primary
 * differentiator and deserves visual dominance. A 2-col spanning hero card
 * establishes hierarchy - visitors immediately understand the core value prop
 * before reading secondary features. The asymmetric sizing also creates visual
 * interest that encourages scanning all eight cards.
 *
 * WHY remote control leads over cost tracking: Market research (and Happy Coder
 * gaps) shows the strongest emotional hook is the workflow disruption of being
 * tethered to a laptop. Cost tracking is a supporting benefit, not the story.
 *
 * Grid layout (3 cols):
 * Row 1: [Dashboard 2×2] [Remote Control 1×2]
 * Row 2: (Dashboard continues) [Session Management 1×1]
 * Row 3: [Cost Tracking] [Activity Graph] [Cloud Monitoring]
 * Row 4: [OTEL Export] [Code Review] (+ filler)
 */

interface BentoFeature {
  icon: React.ComponentType<{ className?: string }>
  title: string
  description: string
  /** CSS grid column span - applied on md+ only */
  colSpan?: "col-span-1" | "col-span-2"
  /** CSS grid row span - applied on md+ only */
  rowSpan?: "row-span-1" | "row-span-2"
}

const features: BentoFeature[] = [
  {
    icon: LayoutDashboard,
    title: "Multi-Agent Dashboard",
    description:
      "Monitor all 11 CLI coding agents from one place. Claude Code, Codex, Gemini CLI, OpenCode, Aider, Goose, Amp, Crush, Kilo, Kiro, and Droid. Live status, session history, error attribution, and per-agent metrics, all in a single encrypted view.",
    colSpan: "col-span-2",
    rowSpan: "row-span-2",
  },
  {
    icon: Smartphone,
    title: "Mobile Remote Control",
    description:
      "Approve permissions, review code diffs, and send voice commands from your phone. Your agents never sit idle waiting for you.",
    colSpan: "col-span-1",
    rowSpan: "row-span-1",
  },
  {
    icon: FolderOpen,
    title: "Session Management",
    description:
      "Checkpoints, sharing, export, and replay. All encrypted end-to-end with TweetNaCl.",
    colSpan: "col-span-1",
    rowSpan: "row-span-1",
  },
  {
    icon: BarChart3,
    title: "Smart Cost Tracking",
    description:
      "Per-message costs, dynamic pricing for 300+ models, and budget alerts that enforce themselves.",
    colSpan: "col-span-1",
    rowSpan: "row-span-1",
  },
  {
    icon: Activity,
    title: "Activity Graph",
    description:
      "GitHub-style contribution heatmap across all your agent sessions.",
    colSpan: "col-span-1",
    rowSpan: "row-span-1",
  },
  {
    icon: Bell,
    title: "Cloud Monitoring",
    description:
      "Async task tracking with push notifications. Know the moment a session completes or errors.",
    colSpan: "col-span-1",
    rowSpan: "row-span-1",
  },
  {
    icon: GitBranch,
    title: "OTEL Export",
    description:
      "Send traces to Grafana, Datadog, Honeycomb, or New Relic. Enterprise observability out of the box.",
    colSpan: "col-span-1",
    rowSpan: "row-span-1",
  },
  {
    icon: Code2,
    title: "Code Review",
    description:
      "Diff viewer with syntax highlighting. Review what your agent changed before it commits, from mobile.",
    colSpan: "col-span-1",
    rowSpan: "row-span-1",
  },
]

/**
 * Returns the combined className string for a bento card.
 *
 * @param feature - The feature definition containing span metadata
 * @param index - Card index, used to apply hero-card specific styling
 * @returns Tailwind className string for the card wrapper
 */
function cardClasses(feature: BentoFeature, index: number): string {
  const base =
    "group relative flex flex-col overflow-hidden rounded-xl md:rounded-2xl bg-zinc-950/80 border border-white/[0.06] shadow-[inset_0_1px_1px_rgba(255,255,255,0.06)] p-6 md:p-8 transition-all duration-200 hover:border-white/[0.10] hover:bg-zinc-900/80"

  const col = feature.colSpan === "col-span-2" ? "md:col-span-2" : ""
  const row = feature.rowSpan === "row-span-2" ? "md:row-span-2" : ""

  // Hero card gets taller minimum height on desktop
  const minH = index === 0 ? "md:min-h-[320px]" : ""

  return [base, col, row, minH].filter(Boolean).join(" ")
}

export function FeaturesSection() {
  const [heroFeature, ...restFeatures] = features

  return (
    <section id="features" className="relative py-16 md:py-24">
      <div className="absolute inset-0 dot-grid opacity-50" />
      <div className="relative mx-auto max-w-7xl px-6">
        <h2 className="mx-auto max-w-3xl text-balance text-center text-3xl font-semibold tracking-tighter text-foreground md:text-4xl">
          Everything You Need to Run Agents in Production
        </h2>
        <p className="mx-auto mt-4 max-w-xl text-center text-sm leading-relaxed text-muted-foreground">
          Remote control, session management, and full observability for all 11 agents at once.
        </p>

        {/*
          Bento grid: 3 equal columns on desktop, single column on mobile.
          The hero card (index 0) spans 2 cols × 2 rows via md: prefixed classes.
          All other cards are 1×1.
        */}
        <div className="mt-12 grid grid-cols-1 gap-4 md:grid-cols-3 md:grid-rows-[auto_auto_auto]">
          {/* Hero card - multi-agent dashboard */}
          <div className={cardClasses(heroFeature, 0)}>
            {/* Subtle amber radial glow in the background */}
            <div
              className="pointer-events-none absolute inset-0 opacity-[0.03]"
              style={{
                background:
                  "radial-gradient(ellipse 80% 60% at 30% 40%, rgb(245 158 11), transparent)",
              }}
            />

            <div className="relative z-10 flex h-full flex-col">
              {/* Icon */}
              <div className="mb-5 flex h-11 w-11 items-center justify-center rounded-xl bg-amber-500/10 border border-amber-500/20">
                <heroFeature.icon className="h-5 w-5 text-amber-500" />
              </div>

              {/* Text */}
              <h3 className="mb-3 text-xl font-semibold text-foreground md:text-2xl">
                {heroFeature.title}
              </h3>
              <p className="text-sm leading-relaxed text-muted-foreground md:text-base">
                {heroFeature.description}
              </p>

              {/* Agent pill list */}
              <div className="mt-6 flex flex-wrap gap-2">
                {[
                  "Claude Code",
                  "Codex",
                  "Gemini CLI",
                  "OpenCode",
                  "Aider",
                  "Goose",
                  "Amp",
                  "Crush",
                  "Kilo",
                  "Kiro",
                  "Droid",
                ].map((agent) => (
                  <span
                    key={agent}
                    className="rounded-md border border-white/[0.08] bg-white/[0.04] px-2.5 py-1 font-mono text-xs text-zinc-400"
                  >
                    {agent}
                  </span>
                ))}
              </div>

              {/* Live status mockup */}
              <div className="mt-auto pt-6">
                <div className="rounded-xl border border-white/[0.06] bg-black/40 p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <span className="font-mono text-xs text-zinc-500">live agents</span>
                    <span className="flex items-center gap-1.5">
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
                      <span className="font-mono text-xs text-emerald-400">3 active</span>
                    </span>
                  </div>
                  <div className="space-y-2">
                    {[
                      { name: "claude-code", status: "running", task: "Refactoring auth module" },
                      { name: "codex", status: "running", task: "Writing unit tests" },
                      { name: "aider", status: "idle", task: "Waiting for input" },
                    ].map((row) => (
                      <div key={row.name} className="flex items-center gap-3">
                        <span
                          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                            row.status === "running"
                              ? "bg-emerald-400"
                              : "bg-zinc-600"
                          }`}
                        />
                        <span className="w-24 shrink-0 font-mono text-xs text-zinc-400">
                          {row.name}
                        </span>
                        <span className="truncate font-mono text-xs text-zinc-500">
                          {row.task}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Remaining 7 cards */}
          {restFeatures.map((feature) => (
            <div key={feature.title} className={cardClasses(feature, 1)}>
              <div className="relative z-10 flex h-full flex-col">
                <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-amber-500/10 border border-amber-500/20">
                  <feature.icon className="h-5 w-5 text-amber-500" />
                </div>
                <h3 className="mb-2 text-base font-semibold text-foreground">{feature.title}</h3>
                <p className="text-sm leading-relaxed text-muted-foreground">{feature.description}</p>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-8 text-center">
          <Link
            href="/features"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-amber-500 transition-colors hover:text-amber-400"
          >
            See all features
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </div>
    </section>
  )
}
