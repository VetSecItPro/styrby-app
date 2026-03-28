import Link from "next/link"
import { ChevronDown, Lock, Shield, Smartphone, Zap } from "lucide-react"
import { Button } from "@/components/ui/button"

function DashboardMockup() {
  return (
    <div className="relative mx-auto mt-16 max-w-5xl px-4">
      {/* Glow */}
      <div className="absolute inset-0 -z-10 rounded-xl bg-amber-500/10 blur-[80px]" />
      <img
        src="/screenshots/dashboard-overview.png"
        alt="Styrby dashboard showing real-time agent costs and session monitoring"
        className="w-full rounded-xl border border-border/60 shadow-2xl"
        width={1440}
        height={900}
      />
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
        {/* WHY this headline: Atlas strategy recommends leading with control + multi-agent.
             Anthropic launched Channels (Claude-only via Telegram) and Dispatch (Claude-only
             via their app). Our moat is 11 agents in one encrypted app. The headline must
             communicate that immediately. */}
        <h1 className="mx-auto max-w-4xl text-balance text-5xl font-semibold tracking-tighter text-foreground md:text-7xl">
          One Dashboard for{" "}
          <span className="text-amber-500">Every AI Agent You Run</span>
        </h1>

        <p className="mx-auto mt-6 max-w-2xl text-pretty text-lg leading-relaxed text-muted-foreground md:text-xl">
          See what your AI coding agents are costing you. Approve risky actions from your phone. Set budget limits that actually stop runaway spend. All end-to-end encrypted. Supports 11 CLI agents.
        </p>

        <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
          <Button asChild size="lg" className="bg-amber-500 px-8 text-background hover:bg-amber-600 font-semibold text-base h-12">
            <Link href="/signup">Connect Your First Agent</Link>
          </Button>
          <Button variant="ghost" size="lg" asChild className="gap-2 text-muted-foreground hover:text-foreground h-12">
            <a href="#how-it-works">
              See How It Works
              <ChevronDown className="h-4 w-4" />
            </a>
          </Button>
        </div>

        {/* Trust badges — WHY these 4: Each addresses a key buyer objection.
             E2E Encrypted = security concern. Zero Knowledge = privacy concern.
             5 Agents = multi-agent moat vs Anthropic's Claude-only tools.
             Free Tier = lowers barrier to trial. */}
        <div className="mt-8 flex flex-wrap items-center justify-center gap-6">
          {[
            { icon: Lock, text: "E2E Encrypted" },
            { icon: Shield, text: "Your Code Never Touches Our Servers" },
            { icon: Smartphone, text: "11 Agents, 1 Dashboard" },
            { icon: Zap, text: "Free Forever on 1 Machine" },
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
