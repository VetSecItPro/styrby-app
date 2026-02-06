import Link from "next/link"
import { ChevronDown, Shield, Zap } from "lucide-react"
import { Button } from "@/components/ui/button"

function DashboardMockup() {
  return (
    <div className="relative mx-auto mt-16 max-w-5xl">
      {/* Glow */}
      <div className="absolute inset-0 -z-10 rounded-xl bg-amber-500/10 blur-[80px]" />

      <div
        className="rounded-xl border border-border/60 bg-card/80 p-4 shadow-2xl"
        style={{ transform: "perspective(1200px) rotateX(4deg)" }}
      >
        {/* Title bar */}
        <div className="mb-4 flex items-center gap-2">
          <div className="h-3 w-3 rounded-full bg-destructive/60" />
          <div className="h-3 w-3 rounded-full bg-amber-500/60" />
          <div className="h-3 w-3 rounded-full bg-codex/60" />
          <span className="ml-3 text-xs text-muted-foreground">Styrby Dashboard</span>
        </div>

        {/* Stat cards */}
        <div className="mb-4 grid grid-cols-4 gap-3">
          {[
            { label: "Today's Spend", value: "$12.47", color: "text-amber-400" },
            { label: "Active Sessions", value: "3", color: "text-codex" },
            { label: "Machines", value: "2 / 5", color: "text-foreground" },
            { label: "Messages", value: "847", color: "text-foreground" },
          ].map((stat) => (
            <div key={stat.label} className="rounded-lg bg-secondary/60 p-3">
              <p className="text-[10px] text-muted-foreground">{stat.label}</p>
              <p className={`font-mono text-sm font-bold ${stat.color}`}>{stat.value}</p>
            </div>
          ))}
        </div>

        {/* Chart + agents */}
        <div className="grid grid-cols-5 gap-3">
          <div className="col-span-3 rounded-lg bg-secondary/60 p-3">
            <p className="mb-2 text-[10px] text-muted-foreground">Spending Trend</p>
            <div className="flex h-24 items-end gap-1">
              {[35, 42, 28, 55, 48, 62, 45, 70, 58, 80, 72, 65, 85, 78].map((h, i) => (
                <div
                  key={i}
                  className="flex-1 rounded-t bg-amber-500/70"
                  style={{ height: `${h}%` }}
                />
              ))}
            </div>
          </div>
          <div className="col-span-2 flex flex-col gap-2">
            {[
              { name: "Claude Code", color: "border-l-claude", status: "Active", cost: "$8.23" },
              { name: "Codex", color: "border-l-codex", status: "Idle", cost: "$0.00" },
              { name: "Gemini CLI", color: "border-l-gemini", status: "Active", cost: "$4.24" },
              { name: "OpenCode", color: "border-l-opencode", status: "Idle", cost: "$1.10" },
              { name: "Aider", color: "border-l-aider", status: "Active", cost: "$2.56" },
            ].map((agent) => (
              <div key={agent.name} className={`rounded-lg border-l-2 ${agent.color} bg-secondary/60 p-2`}>
                <p className="text-[10px] font-medium text-foreground">{agent.name}</p>
                <div className="flex items-center justify-between">
                  <span className="text-[9px] text-muted-foreground">{agent.status}</span>
                  <span className="font-mono text-[10px] text-amber-400">{agent.cost}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

export function Hero() {
  return (
    <section className="relative overflow-hidden pt-32 pb-20">
      {/* Background effects */}
      <div className="absolute inset-0 dot-grid" />
      <div className="absolute left-1/2 top-0 h-[500px] w-[800px] -translate-x-1/2 rounded-full bg-amber-500/5 blur-[120px]" />

      <div className="relative mx-auto max-w-7xl px-6 text-center">
        <h1 className="mx-auto max-w-4xl text-balance text-5xl font-bold tracking-tight text-foreground md:text-7xl">
          Your AI Agents{" "}
          <span className="text-amber-500">In Your Pocket</span>
        </h1>

        <p className="mx-auto mt-6 max-w-2xl text-pretty text-lg leading-relaxed text-muted-foreground md:text-xl">
          Monitor costs, approve permissions, and control Claude Code, Codex, Gemini CLI, OpenCode, and Aider — all from one dashboard.
        </p>

        <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
          <Button asChild size="lg" className="bg-amber-500 px-8 text-background hover:bg-amber-600 font-semibold text-base h-12">
            <Link href="/signup">Start Free</Link>
          </Button>
          <Button variant="ghost" size="lg" asChild className="gap-2 text-muted-foreground hover:text-foreground h-12">
            <a href="#how-it-works">
              See How It Works
              <ChevronDown className="h-4 w-4" />
            </a>
          </Button>
        </div>

        {/* Trust badges */}
        <div className="mt-8 flex flex-wrap items-center justify-center gap-6">
          {[
            { icon: Shield, text: "E2E Encrypted" },
            { icon: Zap, text: "Free Tier Available" },
          ].map(({ icon: Icon, text }) => (
            <div key={text} className="flex items-center gap-2 text-xs text-muted-foreground">
              <Icon className="h-3.5 w-3.5 text-amber-500/70" />
              {text}
            </div>
          ))}
        </div>

        <DashboardMockup />
      </div>
    </section>
  )
}
