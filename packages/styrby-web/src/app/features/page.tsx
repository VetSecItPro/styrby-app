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
    description: 'Your code never leaves your machine in plaintext. Even if our database were stolen tonight.',
    features: [
      {
        icon: Lock,
        title: 'End-to-End Encryption',
        description:
          'Your prompts and your code get encrypted on your machine, with TweetNaCl, before anything leaves. Styrby only ever sees ciphertext. So your IP stays your IP, even when our servers are doing the relay.',
        detail: 'Public/private keypair generated locally. Keys never leave the device.',
      },
      {
        icon: Fingerprint,
        title: 'Zero-Knowledge Architecture',
        description:
          'Our servers process metadata only: timestamps, token counts, cost calculations, connection status. We genuinely cannot read your data, even if a court compelled us to. The architecture forecloses the question.',
        detail: 'Even if our database were stolen tonight, your code is unreadable ciphertext.',
      },
      {
        icon: KeyRound,
        title: 'API Key Hashing',
        description:
          'Your API keys are hashed with bcrypt at rest. We never store the plaintext credential. Rate limiting on every endpoint kills brute-force attempts before they get traction.',
        detail: 'Per-endpoint rate limits with graduated backoff.',
      },
      {
        icon: FileSearch,
        title: 'Audit Trail',
        description:
          'Every permission approval, budget change, team action, and security event lands in a tamper-evident log with timestamp and actor. Export it directly for internal compliance reviews or incident forensics.',
        detail: 'Tamper-evident logging with row-level security.',
      },
    ],
  },
  {
    name: 'Remote Agent Control',
    description: 'Approve commands, set guardrails, and revoke access from anywhere with cell signal.',
    features: [
      {
        icon: Shield,
        title: 'Permission Approval',
        description:
          'When the agent wants to write a file, run a shell command, or hit an API, it pauses and pings your phone. The push includes the diff, the command, and a risk badge (Low to Critical). One tap to approve or deny.',
        detail: 'Works from your phone, tablet, or any browser.',
      },
      {
        icon: MonitorSmartphone,
        title: 'Control From Anywhere',
        description:
          'Leave your desk for a meeting. Go to lunch. Walk the dog. Catch a flight. Your agents keep working, and the dashboard, the approvals, and the cost panel all follow you in your pocket.',
        detail: 'iOS app launching soon. Responsive web dashboard works on any browser today.',
      },
      {
        icon: Zap,
        title: 'Auto-Approve Rules',
        description:
          'Whitelist the low-risk actions you trust the agent to handle (read-only file ops, package installs, test runs). Keep the approval gate on the dangerous ones (file deletions, shell commands, network calls). Per-agent, per-tool.',
        detail: 'Per-agent, per-tool granularity.',
      },
      {
        icon: AlertTriangle,
        title: 'Blocked Tool Lists',
        description:
          'Explicitly forbid the agent from touching certain tools or commands. rm -rf, database drops, production deploys, anything. The agent gets a clear denial and moves on instead of finding a creative workaround.',
        detail: 'Configurable per agent type.',
      },
      {
        icon: WifiOff,
        title: 'Offline Command Queue',
        description:
          'Drop into a tunnel, board a plane, lose Wi-Fi at the cafe. Approvals and commands queue locally and sync the moment you reconnect. Nothing is lost. The agent does not silently miss your tap.',
        detail: 'Local queue with automatic sync on reconnection.',
      },
    ],
  },
  {
    name: 'Cost Management',
    description: 'See the rogue session before the invoice. Cap the spend before it lands.',
    features: [
      {
        icon: BarChart3,
        title: 'Cost Tracking Across Every Agent',
        description:
          'Spending broken down per agent, per session, per model, per tag. Tag a session by client or project and the dashboard rolls up totals automatically, ready to drop straight into an invoice. Daily trend charts surface the days you would otherwise have missed.',
        detail: 'Materialized views for sub-second dashboard loads. Cost by Tag section shows total spend and session count per tag.',
      },
      {
        icon: LineChart,
        title: 'Per-Message Cost Tracking',
        description:
          'Drill into a single session and see what each individual prompt cost. The expensive ones are now visible. Rewrite the prompt template, switch the model, or tighten the system message before the next thousand requests.',
        detail: 'Available on Power tier only.',
      },
      {
        icon: FileSearch,
        title: 'Per-File Context Breakdown',
        description:
          'See which files the agent loaded into context and how much each one contributed to the token bill. The 200-line file you forgot to .gitignore stops costing you $0.50 every prompt.',
        detail: 'Available on Power tier only.',
      },
      {
        icon: ActivitySquare,
        title: 'Activity Graph',
        description:
          'A GitHub-style heatmap of your agent activity. The pattern surfaces things you would not catch in a session list: the Friday afternoon spikes, the agent you only run on Tuesdays, the dead weeks where you forgot the tool exists.',
        detail: 'Available on Power tier only.',
      },
      {
        icon: Eye,
        title: 'Model-Level Breakdown',
        description:
          'Compare what you are spending on Claude Opus vs Sonnet vs Haiku, GPT-4o vs o3-mini, Gemini Pro vs Flash. Input, output, and cache token totals side by side. Decide which model to default to per agent based on your actual usage.',
        detail: 'Pricing reference table with last-verified dates.',
      },
      {
        icon: ShieldAlert,
        title: 'Budget Alerts',
        description:
          'Set a daily, weekly, or monthly cap. Choose the response: just notify you, throttle the agent, or kill the session outright. The choice is yours, but the runaway loop you forgot about no longer becomes a $400 invoice.',
        detail: 'Free: 1 alert. Solo: 5 alerts. Team and above: unlimited.',
      },
    ],
  },
  {
    name: 'Multi-Agent Dashboard',
    description: 'All 11 agents in one live view. No more grepping the API dashboard for which session broke.',
    features: [
      {
        icon: LayoutDashboard,
        title: 'Unified Agent View',
        description:
          'All eleven agents on one screen. Color-coded status cards (active, idle, stuck, failing) tell you at a glance which ones need attention and which ones are doing their job. No more terminal tab roulette.',
        detail: 'Real-time updates via Supabase Realtime subscriptions.',
      },
      {
        icon: AlertTriangle,
        title: 'Error Attribution',
        description:
          'When something breaks, the dashboard tells you whose fault it is. Color-coded by source: Styrby (orange), the agent itself (red), your build tools (blue), or the network (yellow). No more debugging the wrong layer.',
        detail: 'Drill into error details from the dashboard.',
      },
      {
        icon: Wifi,
        title: 'Live Connection Status',
        description:
          'Heartbeat monitoring for every connected machine, updated in real time. The moment a device drops offline or an agent stops responding, you see it. Reconnects happen automatically when the network comes back.',
        detail: 'WebSocket-based with automatic reconnection.',
      },
    ],
  },
  {
    name: 'Session History',
    description: 'Every prompt, every response, every tool call. Encrypted on your device. Searchable and resumable.',
    features: [
      {
        icon: History,
        title: 'Searchable History',
        description:
          'Filter your full session archive by agent, tag, date range, cost band, or full-text query against the metadata. Bookmark the sessions you want to come back to. Find the prompt that worked three weeks ago in seconds.',
        detail: 'Free: 7 days. Solo: 1 year. Team and above: unlimited.',
      },
      {
        icon: Smartphone,
        title: 'Session Replay',
        description:
          'Step through the conversation in chronological order. Every prompt, every response, every tool call, every permission request. Decryption happens on your device. Use it for debugging, code review, or training a teammate on a workflow.',
        detail: 'End-to-end encrypted. Decrypted only on your device.',
      },
      {
        icon: BookmarkCheck,
        title: 'Session Checkpoints',
        description:
          'Drop a named bookmark inside a long session. Come back to that exact moment later, compare two checkpoints to see what changed, or share the specific point in the conversation where things went sideways.',
        detail: 'Available on Power tier only.',
      },
      {
        icon: Share2,
        title: 'Session Sharing',
        description:
          'Generate a share link for any replay. The data stays end-to-end encrypted and the recipient needs a separate key that you give them out of band. Styrby itself never sees plaintext, even on shared sessions.',
        detail: 'Available on Power tier only.',
      },
      {
        icon: BarChart3,
        title: 'Per-Session Cost Breakdown',
        description:
          'Drill into any session and see the cost broken down by input tokens, output tokens, cache hits, and model. Export to CSV when finance asks for the receipts.',
        detail: 'CSV export available on Power tier.',
      },
    ],
  },
  {
    name: 'Notifications',
    description: 'Get the page when it matters. Stay quiet when it does not.',
    features: [
      {
        icon: Bell,
        title: 'Push Notifications',
        description:
          'Permission requests, budget alerts, errors, and session events land on your phone the moment they happen. Tap and respond in seconds. Beats refreshing a terminal every five minutes from the couch.',
        detail: 'APNs (iOS) and FCM (Android) supported.',
      },
      {
        icon: SlidersHorizontal,
        title: 'Quiet Hours',
        description:
          'Define when you do not want to be paged. Critical alerts (budget breached, agent stuck) can punch through the quiet window if you want them to. Configurable per notification type.',
        detail: 'Per-notification-type granularity.',
      },
      {
        icon: Globe,
        title: 'Weekly Summary Emails',
        description:
          'A Monday-morning digest of last week: total spend, active sessions, most-used agents, budget status. Read it in 60 seconds and know whether to be worried.',
        detail: 'Powered by Resend. Unsubscribe anytime.',
      },
    ],
  },
  {
    name: 'Power Features',
    badge: 'Power',
    description: 'What you wire in once your team depends on agents in production.',
    features: [
      {
        icon: Mic,
        title: 'Voice Commands',
        description:
          'Talk to the agent when your hands are on the wheel, holding the kid, or carrying groceries up three flights. Approve, deny, dictate a prompt, kill a session. Voice transcript is logged alongside the rest of the session.',
        detail: 'Available on Power tier only.',
      },
      {
        icon: Cloud,
        title: 'Cloud Monitoring',
        description:
          'Kick off a long-running cloud job from the dashboard, watch its progress live, and get pushed when it finishes or fails. Stop opening five tabs to check whether the build is done.',
        detail: 'Available on Power tier only.',
      },
      {
        icon: Code2,
        title: 'Code Review From Mobile',
        description:
          'Submit a review request, monitor it on your phone, leave inline comments, and get pushed the moment it finishes. The same review you would do at a desk, just without the desk.',
        detail: 'Available on Power tier only.',
      },
      {
        icon: Database,
        title: 'OTEL Export',
        description:
          'Stream session metrics, cost data, and trace events to whatever observability stack your platform team already runs: Grafana, Datadog, Honeycomb, New Relic. The agent activity becomes another service you can graph and alert on.',
        detail: 'Available on Power tier only.',
      },
      {
        icon: Zap,
        title: 'Rust Parser',
        description:
          'A Rust-backed parser for session data, faster than the default JS parser and with a much lower memory footprint. The win shows up on long sessions and high-token replays. Available everywhere.',
        detail: 'Available on all tiers.',
      },
    ],
  },
  {
    name: 'Team Collaboration',
    badge: 'Power',
    description: 'Engineering managers see the cost. Developers keep the autonomy.',
    features: [
      {
        icon: Users,
        title: 'Team Members',
        description:
          'Invite teammates by email. Each one gets their own login and role-based access: Owner, Admin, or Member. No shared credentials, no Slack-passed passwords, no audit gaps.',
        detail: 'Team plan: 3-seat minimum. Invite flow with email verification.',
      },
      {
        icon: LayoutDashboard,
        title: 'Shared Dashboards',
        description:
          'Everyone on the team sees the same cost analytics, session history, and live agent status, scoped to their role. Managers get the visibility they need. Developers keep the autonomy they want.',
        detail: 'Row-level security ensures data isolation between teams.',
      },
      {
        icon: Zap,
        title: 'REST API',
        description:
          'Programmatic access to your session and cost data. Pipe it into a custom internal dashboard, a Slack daily summary, a CI gate that fails when an agent runs over budget. Whatever you can write a script for.',
        detail: 'Authenticated with hashed API keys. Rate-limited.',
      },
    ],
  },
];

export default function FeaturesPage() {
  return (
    <main id="main-content" tabIndex={-1} className="min-h-screen">
      <Navbar />

      {/* Hero */}
      <section className="pt-32 pb-8">
        <div className="mx-auto max-w-7xl px-6 text-center">
          <h1 className="text-balance text-4xl font-semibold tracking-tighter text-foreground md:text-5xl">
            Every feature, mapped to a workflow you actually have.
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-lg text-muted-foreground leading-relaxed">
            End-to-end encrypted remote control across 11 CLI agents. Cost attribution that names the rogue session. Session memory that survives a closed laptop. Team governance for orgs that need it.
          </p>
          <div className="mt-8 flex items-center justify-center gap-3">
            <Button asChild size="sm" className="bg-amber-500 text-background hover:bg-amber-600 font-medium px-6">
              <Link href="/signup">
                Pair my first agent
                <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm" className="border-border/60 text-muted-foreground hover:text-foreground bg-transparent px-6">
              <Link href="/pricing">See pricing</Link>
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
                Pair your first agent in under a minute.
              </h2>
              <p className="mx-auto mt-3 max-w-md text-sm text-muted-foreground">
                Free on one machine. No credit card. No expiring trial.
              </p>
              <div className="mt-6 flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
                <Button asChild size="sm" className="bg-amber-500 text-background hover:bg-amber-600 font-medium px-6">
                  <Link href="/signup">
                    Pair my first agent
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </Link>
                </Button>
                <Button asChild variant="outline" size="sm" className="border-border/60 text-muted-foreground hover:text-foreground bg-transparent px-6">
                  <Link href="/pricing">Compare plans</Link>
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
