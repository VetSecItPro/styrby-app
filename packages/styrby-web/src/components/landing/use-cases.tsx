import { Smartphone, DollarSign, LayoutDashboard, AlertTriangle, Clock } from 'lucide-react';

/**
 * Use-case section for the landing page.
 *
 * WHY: Atlas strategy identifies that use cases > testimonials for a pre-launch product.
 * Each block addresses a specific workflow pain point and shows the product solving it.
 * These are the 5 strongest emotional triggers: anxiety reduction, cost discipline,
 * control, convenience, and trust.
 *
 * Positioned between ProblemSection and FeaturesSection to bridge
 * "here's your pain" → "here's how we solve it" → "here's every feature."
 */

const useCases = [
  {
    icon: Smartphone,
    title: 'Approve risky actions from the couch',
    description:
      'Claude wants to delete a directory. Codex wants to run a shell command. You get a push notification with a risk badge (low, medium, high, critical). Approve or deny in one tap.',
    highlight: 'Walk away from your desk without killing productivity.',
  },
  {
    icon: DollarSign,
    title: 'Catch runaway costs before the invoice',
    description:
      'See per-agent and per-session costs on every page load. Tag sessions by client or project for filtering. Set budget thresholds that warn you, throttle the agent, or kill the session automatically.',
    highlight: 'No more surprise API bills.',
  },
  {
    icon: LayoutDashboard,
    title: 'See every agent on every machine at a glance',
    description:
      'Claude Code, Codex, Gemini CLI, OpenCode, Aider. Which are active, idle, stuck, or failing? Color-coded status cards with live heartbeat tell you instantly.',
    highlight: 'One dashboard replaces five terminal tabs.',
  },
  {
    icon: AlertTriangle,
    title: 'Know exactly why a session failed',
    description:
      'A session stalls. Color-coded error attribution shows you the root cause: agent error, build failure, network timeout, or Styrby issue. No log diving required.',
    highlight: 'Seconds to diagnosis, not minutes.',
  },
  {
    icon: Clock,
    title: 'Pick up where you left off, even days later',
    description:
      'Full session history with cost breakdowns, permission logs, and bookmarks. Filter by agent, tags, date, or cost. Every session is searchable and replayable.',
    highlight: 'Nothing falls through the cracks.',
  },
];

export function UseCases() {
  return (
    <section className="py-16 border-t border-border/30" id="use-cases">
      <div className="mx-auto max-w-7xl px-6">
        <h2 className="mx-auto max-w-3xl text-balance text-center text-3xl font-bold tracking-tight text-foreground md:text-4xl">
          Five Problems You Deal With Today, Solved
        </h2>
        <p className="mx-auto mt-4 max-w-xl text-center text-muted-foreground leading-relaxed">
          These are the workflows Styrby was built for.
        </p>

        <div className="mt-16 space-y-6">
          {useCases.map((useCase, index) => (
            <div
              key={useCase.title}
              className="group flex flex-col gap-6 rounded-xl border border-border/40 bg-card/40 p-8 transition-all duration-200 hover:border-amber-500/30 hover:bg-card/60 md:flex-row md:items-start md:gap-8"
            >
              {/* Icon + number */}
              <div className="flex shrink-0 items-center gap-4 md:w-16 md:flex-col md:items-center md:gap-2">
                <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-amber-500/10 transition-colors group-hover:bg-amber-500/20">
                  <useCase.icon className="h-6 w-6 text-amber-500" />
                </div>
                <span className="font-mono text-xs text-muted-foreground/40">0{index + 1}</span>
              </div>

              {/* Content */}
              <div className="flex-1">
                <h3 className="text-lg font-semibold text-foreground">{useCase.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  {useCase.description}
                </p>
                <p className="mt-3 text-sm font-medium text-amber-500">
                  {useCase.highlight}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
