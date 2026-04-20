import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import {
  BarChart3,
  Shield,
  LayoutDashboard,
  History,
  Bell,
  AlertTriangle,
  Lock,
  Smartphone,
  Wifi,
  Zap,
  Eye,
  ShieldAlert,
  Users,
  ArrowRight,
  KeyRound,
  Globe,
  FileSearch,
  Fingerprint,
  MonitorSmartphone,
  WifiOff,
  SlidersHorizontal,
  Mic,
  Cloud,
  Code2,
  Share2,
  BookmarkCheck,
  ActivitySquare,
  LineChart,
  Database,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Navbar } from '@/components/landing/navbar';
import { Footer } from '@/components/landing/footer';
import { SocialProof } from '@/components/landing/social-proof';

export const metadata: Metadata = {
  title: 'All Features',
  description:
    'E2E encrypted remote control for 11 CLI coding agents including Claude Code, Codex, Gemini CLI, OpenCode, Aider, Goose, Amp, Crush, Kilo, Kiro, and Droid. Cost tracking, permissions, session history, voice commands, cloud monitoring, and team tools.',
  openGraph: {
    title: 'Styrby Features',
    description:
      'E2E encrypted remote control for 11 CLI coding agents. Cost tracking, permissions, session history, voice commands, cloud monitoring, and team tools.',
    type: 'website',
    url: 'https://styrbyapp.com/features',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Styrby Features',
    description:
      'E2E encrypted remote control for 11 CLI coding agents. Cost tracking, permissions, session history, voice commands, cloud monitoring, and team tools.',
  },
};

/**
 * Feature categories ordered by what matters most to developers:
 * 1. Security first (trust must be established before anything else)
 * 2. Remote control (the core value prop)
 * 3. Cost management (the pain point that drives purchase)
 * 4. Monitoring (ongoing value)
 * 5. Sessions (historical value)
 * 6. Notifications (quality of life)
 * 7. Teams (expansion revenue)
 * 8. Integrations (power users)
 */
const featureCategories = [
  {
    name: 'Security and Encryption',
    description: 'Your code never touches our servers. Zero-knowledge by design.',
    features: [
      {
        icon: Lock,
        title: 'End-to-End Encryption',
        description:
          'Every session message is encrypted with TweetNaCl before it leaves your machine. Styrby relays ciphertext. We cannot read your prompts, responses, or code.',
        detail: 'Public/private keypair generated locally. Keys never leave the device.',
      },
      {
        icon: Fingerprint,
        title: 'Zero-Knowledge Architecture',
        description:
          'We process metadata only: timestamps, token counts, cost calculations, and connection status. Your intellectual property stays where it belongs.',
        detail: 'Even if our database were breached, your code is unreadable ciphertext.',
      },
      {
        icon: KeyRound,
        title: 'API Key Hashing',
        description:
          'API keys are hashed with bcrypt before storage. We never store plaintext credentials. Rate limiting on all endpoints prevents brute-force attempts.',
        detail: 'Per-endpoint rate limits with graduated backoff.',
      },
      {
        icon: FileSearch,
        title: 'Audit Trail',
        description:
          'Every permission approval, budget change, team action, and security event is logged with timestamp and actor. Exportable for compliance reviews.',
        detail: 'Tamper-evident logging with row-level security.',
      },
    ],
  },
  {
    name: 'Remote Agent Control',
    description: 'Approve, deny, and configure your AI agents from your phone or browser.',
    features: [
      {
        icon: Shield,
        title: 'Permission Approval',
        description:
          'Agents request permission before risky actions. You get a push notification with a risk badge (Low, Medium, High, Critical). Approve or deny in one tap.',
        detail: 'Works from your phone, tablet, or any browser.',
      },
      {
        icon: MonitorSmartphone,
        title: 'Control From Anywhere',
        description:
          'Leave your desk. Go to lunch. Walk the dog. Your AI agents keep working, and you stay in control from your phone. No more babysitting a terminal.',
        detail: 'Mobile app (iOS launching soon) plus responsive web dashboard.',
      },
      {
        icon: Zap,
        title: 'Auto-Approve Rules',
        description:
          'Configure rules for low-risk actions so agents proceed without waiting. Keep the approval gate on file deletions, shell commands, and network access.',
        detail: 'Per-agent, per-tool granularity.',
      },
      {
        icon: AlertTriangle,
        title: 'Blocked Tool Lists',
        description:
          'Explicitly block dangerous tools per agent. Prevent rm -rf, database drops, or any command you define. The agent gets a clear denial instead of access.',
        detail: 'Configurable per agent type.',
      },
      {
        icon: WifiOff,
        title: 'Offline Command Queue',
        description:
          'Lose connection? Commands queue locally and sync automatically when you reconnect. Your laptop can sleep. Styrby remembers.',
        detail: 'Local queue with automatic sync on reconnection.',
      },
    ],
  },
  {
    name: 'Cost Management',
    description: 'Know where every dollar goes. Set limits before you overspend.',
    features: [
      {
        icon: BarChart3,
        title: 'Cost Tracking Across Every Agent',
        description:
          'See spending per agent, per session, per model, and per tag. Daily trend charts, per-model breakdowns, and cost attribution across all eleven agents. Tag sessions by client or project to get a cost-by-tag breakdown for invoicing.',
        detail: 'Materialized views for sub-second dashboard loads. Cost by Tag section shows total spend and session count per tag.',
      },
      {
        icon: LineChart,
        title: 'Per-Message Cost Tracking',
        description:
          'See the cost of every individual message in a session, not just session totals. Know exactly which prompts drove your spend and optimize accordingly.',
        detail: 'Available on Power tier only.',
      },
      {
        icon: FileSearch,
        title: 'Per-File Context Breakdown',
        description:
          'See which files were included in the agent context window and their relative size contribution. Understand why a session cost more than expected.',
        detail: 'Available on Power tier only.',
      },
      {
        icon: ActivitySquare,
        title: 'Activity Graph',
        description:
          'GitHub-style contribution graph showing your daily agent activity over time. See usage patterns, identify heavy-use days, and track productivity trends.',
        detail: 'Available on Power tier only.',
      },
      {
        icon: Eye,
        title: 'Model-Level Breakdown',
        description:
          'Compare costs across Claude Opus, Sonnet, Haiku, GPT-4o, Gemini Pro, and every model your agents use. Input tokens, output tokens, cache hits.',
        detail: 'Pricing reference table with last-verified dates.',
      },
      {
        icon: ShieldAlert,
        title: 'Budget Alerts',
        description:
          'Set daily, weekly, or monthly spend limits. Choose what happens when a threshold is hit: get notified, slow the agent down, or stop it entirely.',
        detail: 'Free gets 1 alert. Pro gets 3 alerts. Power gets 5.',
      },
    ],
  },
  {
    name: 'Multi-Agent Dashboard',
    description: 'Claude Code, Codex, Gemini CLI, OpenCode, Aider, Goose, Amp, Crush, Kilo, Kiro, and Droid in one view.',
    features: [
      {
        icon: LayoutDashboard,
        title: 'Unified Agent View',
        description:
          'All eleven supported agents in a single dashboard. Color-coded status cards show active, idle, stuck, or failing states at a glance.',
        detail: 'Real-time updates via Supabase Realtime subscriptions.',
      },
      {
        icon: AlertTriangle,
        title: 'Error Attribution',
        description:
          'When something breaks, know exactly what caused it. Color-coded sources: Orange (Styrby), Red (agent), Blue (build tools), Yellow (network).',
        detail: 'Drill into error details from the dashboard.',
      },
      {
        icon: Wifi,
        title: 'Live Connection Status',
        description:
          'Real-time heartbeat monitoring for every connected machine. Know instantly when a device goes offline or an agent stops responding.',
        detail: 'WebSocket-based with automatic reconnection.',
      },
    ],
  },
  {
    name: 'Session History',
    description: 'Full record of every agent conversation and action.',
    features: [
      {
        icon: History,
        title: 'Searchable History',
        description:
          'Filter sessions by agent type, tags, date range, or cost. Full-text search across session metadata. Bookmark important sessions for quick access.',
        detail: 'Free: 7 days. Pro: 90 days. Power: 1 year.',
      },
      {
        icon: Smartphone,
        title: 'Session Replay',
        description:
          'Step through the full conversation between you and the agent. Every prompt, response, tool call, and permission request in chronological order.',
        detail: 'End-to-end encrypted. Decrypted only on your device.',
      },
      {
        icon: BookmarkCheck,
        title: 'Session Checkpoints',
        description:
          'Mark named save points within a long session. Return to a checkpoint later, compare progress between checkpoints, or share a specific moment in a conversation.',
        detail: 'Available on Power tier only.',
      },
      {
        icon: Share2,
        title: 'Session Sharing',
        description:
          'Generate a share link for any session replay. Session data stays end-to-end encrypted and recipients need a separate decryption key you provide. Styrby never has access to the plaintext content.',
        detail: 'Available on Power tier only.',
      },
      {
        icon: BarChart3,
        title: 'Per-Session Cost Breakdown',
        description:
          'See exactly how much each session cost. Input tokens, output tokens, cache utilization, and total cost broken down by model used.',
        detail: 'CSV export available on Power tier.',
      },
    ],
  },
  {
    name: 'Notifications',
    description: 'Stay informed without being overwhelmed.',
    features: [
      {
        icon: Bell,
        title: 'Push Notifications',
        description:
          'Permission requests, budget alerts, error notifications, and session events delivered to your phone. React in seconds from anywhere.',
        detail: 'APNs (iOS) and FCM (Android) supported.',
      },
      {
        icon: SlidersHorizontal,
        title: 'Quiet Hours',
        description:
          'Set time windows when notifications are silenced. Critical alerts like budget exceeded can optionally bypass quiet hours.',
        detail: 'Per-notification-type granularity.',
      },
      {
        icon: Globe,
        title: 'Weekly Summary Emails',
        description:
          'Digest of your agent usage: total spend, active sessions, most-used agents, and budget status. Delivered every Monday.',
        detail: 'Powered by Resend. Unsubscribe anytime.',
      },
    ],
  },
  {
    name: 'Power Features',
    badge: 'Power',
    description: 'Advanced capabilities for serious agent workflows.',
    features: [
      {
        icon: Mic,
        title: 'Voice Commands',
        description:
          'Dictate approvals, queries, or commands hands-free from your phone or browser. Approve a permission request while your hands are full.',
        detail: 'Available on Power tier only.',
      },
      {
        icon: Cloud,
        title: 'Cloud Monitoring',
        description:
          'Submit a cloud monitoring job, track its progress in real time, and receive a push notification when it finishes or encounters an error.',
        detail: 'Available on Power tier only.',
      },
      {
        icon: Code2,
        title: 'Code Review From Mobile',
        description:
          'Submit a code review request from your phone. Monitor progress, see inline comments, and get notified when the review completes.',
        detail: 'Available on Power tier only.',
      },
      {
        icon: Database,
        title: 'OTEL Export',
        description:
          'Send agent session metrics, cost data, and trace events to any OpenTelemetry-compatible observability platform: Grafana, Datadog, Honeycomb, and others.',
        detail: 'Available on Power tier only.',
      },
      {
        icon: Zap,
        title: 'Rust Parser',
        description:
          'High-performance Rust-based parser for session data processing. Handles large session files faster than the default parser with lower memory overhead.',
        detail: 'Available on all tiers.',
      },
    ],
  },
  {
    name: 'Team Collaboration',
    badge: 'Power',
    description: 'Share visibility across your engineering team.',
    features: [
      {
        icon: Users,
        title: 'Team Members',
        description:
          'Invite up to 3 team members via email. Each gets their own login with role-based access: Owner, Admin, or Member. No shared credentials.',
        detail: 'Available on Power tier only. Invite flow with email verification.',
      },
      {
        icon: LayoutDashboard,
        title: 'Shared Dashboards',
        description:
          'Team members see the same cost analytics, session history, and agent status. Engineering managers get visibility. Developers keep autonomy.',
        detail: 'Row-level security ensures data isolation between teams.',
      },
      {
        icon: Zap,
        title: 'REST API',
        description:
          'Programmatic access to your session and cost data. Build custom integrations, internal dashboards, or CI/CD automations.',
        detail: 'Authenticated with hashed API keys. Rate-limited.',
      },
    ],
  },
];

export default function FeaturesPage() {
  return (
    <main className="min-h-screen">
      <Navbar />

      {/* Hero */}
      <section className="pt-32 pb-8">
        <div className="mx-auto max-w-7xl px-6 text-center">
          <h1 className="text-balance text-4xl font-semibold tracking-tighter text-foreground md:text-5xl">
            Built for developers who ship with AI
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-lg text-muted-foreground leading-relaxed">
            End-to-end encrypted remote control for your AI coding agents.
            Cost tracking, permission approval, session history, and team collaboration.
          </p>
          <div className="mt-8 flex items-center justify-center gap-3">
            <Button asChild size="sm" className="bg-amber-500 text-background hover:bg-amber-600 font-medium px-6">
              <Link href="/signup">
                Get Started Free
                <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm" className="border-border/60 text-muted-foreground hover:text-foreground bg-transparent px-6">
              <Link href="/pricing">View Pricing</Link>
            </Button>
          </div>
        </div>
      </section>

      {/* Feature categories */}
      {featureCategories.map((category, catIndex) => (
        <section
          key={category.name}
          className={`py-12 ${catIndex % 2 === 1 ? 'bg-card/20' : ''}`}
        >
          <div className="mx-auto max-w-6xl px-6">
            {/* Category header */}
            <div className="mb-10 text-center">
              <div className="flex items-center justify-center gap-3">
                <h2 className="text-2xl font-semibold tracking-tight text-foreground">
                  {category.name}
                </h2>
                {category.badge && (
                  <span className="rounded-full bg-amber-500/10 border border-amber-500/20 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-500">
                    {category.badge}
                  </span>
                )}
              </div>
              <p className="mt-2 text-sm text-muted-foreground">{category.description}</p>
            </div>

            {/* Feature cards with detail line */}
            <div className="space-y-4">
              {category.features.map((feature, featureIndex) => {
                const isEven = featureIndex % 2 === 0;
                return (
                  <div
                    key={feature.title}
                    className={`rounded-xl border border-border/40 bg-card/60 p-6 transition-all duration-200 hover:border-amber-500/20 hover:bg-card md:max-w-[80%] ${
                      isEven ? '' : 'md:ml-auto'
                    }`}
                  >
                    <div className={`flex flex-col gap-4 md:flex-row md:items-start md:gap-5 ${
                      !isEven ? 'md:flex-row-reverse' : ''
                    }`}>
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-amber-500/10 border border-amber-500/20">
                        <feature.icon className="h-5 w-5 text-amber-500" />
                      </div>
                      <div>
                        <h3 className="mb-1.5 text-base font-semibold text-foreground">{feature.title}</h3>
                        <p className="text-sm leading-relaxed text-muted-foreground">{feature.description}</p>
                        {feature.detail && (
                          <p className="mt-2 text-xs text-muted-foreground/60">{feature.detail}</p>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Screenshots for key categories */}
            {category.name === 'Cost Management' && (
              <div className="mt-8">
                <Image
                  src="/screenshots/cost-analytics.webp"
                  alt="Cost analytics dashboard showing 30-day spending trend, per-agent breakdown, and budget alert"
                  className="w-full rounded-xl border border-border/40 shadow-lg"
                  width={1440}
                  height={900}
                  sizes="(max-width: 768px) 100vw, (max-width: 1200px) 80vw, 1200px"
                />
              </div>
            )}
            {category.name === 'Remote Agent Control' && (
              <div className="mt-8">
                <Image
                  src="/screenshots/session-view.webp"
                  alt="Session list showing active and completed sessions across multiple agents"
                  className="w-full rounded-xl border border-border/40 shadow-lg"
                  width={1440}
                  height={900}
                  sizes="(max-width: 768px) 100vw, (max-width: 1200px) 80vw, 1200px"
                />
              </div>
            )}
            {category.name === 'Multi-Agent Dashboard' && (
              <div className="mt-8">
                <Image
                  src="/screenshots/agents-page.webp"
                  alt="Agent dashboard showing all supported AI coding agents with status and daily costs"
                  className="w-full rounded-xl border border-border/40 shadow-lg"
                  width={1440}
                  height={900}
                  sizes="(max-width: 768px) 100vw, (max-width: 1200px) 80vw, 1200px"
                />
              </div>
            )}
          </div>
        </section>
      ))}

      {/* Supported agents strip - matches homepage social proof pattern */}
      <section className="py-12 border-t border-border/30">
        <div className="mx-auto max-w-7xl px-6 text-center">
          <h2 className="text-lg font-semibold text-foreground mb-6">Supported Agents</h2>
          <SocialProof />
        </div>
      </section>

      {/* Bottom CTA */}
      <section className="py-12">
        <div className="mx-auto max-w-7xl px-6">
          <div className="relative mx-auto overflow-hidden rounded-2xl border border-border/60 bg-card/40 px-8 py-12 text-center md:max-w-[65%]">
            <div className="absolute inset-0 bg-gradient-to-r from-amber-500/10 via-amber-500/5 to-transparent" />
            <div className="relative">
              <h2 className="text-2xl font-semibold tracking-tight text-foreground md:text-3xl">
                Ready to take control?
              </h2>
              <p className="mx-auto mt-3 max-w-md text-sm text-muted-foreground">
                Free tier available. No credit card required. Connect your first agent in under two minutes.
              </p>
              <div className="mt-6 flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
                <Button asChild size="sm" className="bg-amber-500 text-background hover:bg-amber-600 font-medium px-6">
                  <Link href="/signup">
                    Get Started Free
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </Link>
                </Button>
                <Button asChild variant="outline" size="sm" className="border-border/60 text-muted-foreground hover:text-foreground bg-transparent px-6">
                  <Link href="/pricing">Compare Plans</Link>
                </Button>
              </div>
            </div>
          </div>
        </div>
      </section>

      <Footer />
    </main>
  );
}
