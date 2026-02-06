import { BarChart3, Shield, LayoutDashboard, History, Bell, AlertTriangle } from "lucide-react"

const features = [
  {
    icon: BarChart3,
    title: "Real-Time Cost Tracking",
    description:
      "See exactly what you're spending per agent, per session, per project. Set budget alerts before you blow through your API credits.",
    accent: true,
  },
  {
    icon: Shield,
    title: "Permission Control",
    description:
      "Approve or deny agent actions from your phone. Risk-level badges (Low/Medium/High/Critical) so you know what matters.",
    accent: false,
  },
  {
    icon: LayoutDashboard,
    title: "Multi-Agent Dashboard",
    description:
      "Claude Code, Codex, Gemini CLI, OpenCode, and Aider in one unified view. Color-coded status cards with live heartbeat indicators.",
    accent: false,
  },
  {
    icon: History,
    title: "Session History",
    description:
      "Full searchable history of every agent session. Filter by agent, project, date, or cost. Bookmark important sessions.",
    accent: false,
  },
  {
    icon: Bell,
    title: "Smart Notifications",
    description:
      "Push notifications for permission requests, budget alerts, and errors. Quiet hours so you're not pinged at 2 AM.",
    accent: false,
  },
  {
    icon: AlertTriangle,
    title: "Error Attribution",
    description:
      "Color-coded error sources: Orange for Styrby, Red for agent, Blue for build tools, Yellow for network. Find the root cause without digging through logs.",
    accent: false,
  },
]

export function FeaturesSection() {
  return (
    <section id="features" className="relative py-24">
      <div className="absolute inset-0 dot-grid opacity-50" />
      <div className="relative mx-auto max-w-7xl px-6">
        <h2 className="mx-auto max-w-3xl text-balance text-center text-3xl font-bold tracking-tight text-foreground md:text-4xl">
          Everything You Need to Tame Your AI Agents
        </h2>

        <div className="mt-16 grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {features.map((feature) => (
            <div
              key={feature.title}
              className="gradient-border group rounded-xl bg-card/60 p-8 transition-all duration-200 hover:bg-card hover:amber-glow"
            >
              <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-secondary">
                <feature.icon className={`h-6 w-6 ${feature.accent ? "text-amber-500" : "text-muted-foreground"}`} />
              </div>
              <h3 className="mb-2 text-lg font-semibold text-foreground">{feature.title}</h3>
              <p className="text-sm leading-relaxed text-muted-foreground">{feature.description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
