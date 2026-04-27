import type { Metadata } from 'next';
import Link from 'next/link';
import { Check, Minus, ArrowRight, Shield, Lock, Wifi, Eye, Server, Smartphone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Navbar } from '@/components/landing/navbar';
import { Footer } from '@/components/landing/footer';

export const metadata: Metadata = {
  title: 'Security Comparison: Styrby vs Claude Channels',
  description:
    'Compare Styrby, Claude Code Channels, and Dispatch on encryption, privacy, and agent support. Zero-knowledge vs server-readable session data.',
  openGraph: {
    title: 'Styrby vs Claude Channels vs Dispatch',
    description:
      'Compare Styrby, Claude Code Channels, and Dispatch on encryption, privacy, and agent support. Zero-knowledge vs server-readable session data.',
    type: 'website',
    url: 'https://styrbyapp.com/security/compare',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Styrby vs Claude Channels vs Dispatch',
    description:
      'Compare Styrby, Claude Code Channels, and Dispatch on encryption, privacy, and agent support. Zero-knowledge vs server-readable session data.',
  },
};

/**
 * Security comparison marketing page.
 *
 * WHY: Anthropic launched Claude Code Channels (routes session data through
 * Telegram/Discord) and Dispatch (remote desktop control via Claude mobile app)
 * in March 2026. This page positions Styrby's E2E encryption and zero-knowledge
 * architecture as the secure alternative for developers working on proprietary code.
 *
 * Target audience: Developers evaluating mobile remote control options for AI
 * coding agents, especially those concerned about code privacy.
 */

/* ── Comparison data ────────────────────────────────────────────────── */

interface ComparisonFeature {
  /** Feature name displayed in the table */
  name: string;
  /** Styrby's value (true = supported, false = not, string = detail) */
  styrby: boolean | string;
  /** Claude Code Channels (Telegram/Discord) value */
  channels: boolean | string;
  /** Claude Dispatch (Cowork remote control) value */
  dispatch: boolean | string;
}

interface ComparisonCategory {
  /** Category header displayed above feature group */
  name: string;
  /** Features within this category */
  features: ComparisonFeature[];
}

const comparisonCategories: ComparisonCategory[] = [
  {
    name: 'Encryption & Privacy',
    features: [
      { name: 'End-to-end encryption', styrby: true, channels: false, dispatch: false },
      { name: 'Zero-knowledge architecture', styrby: true, channels: false, dispatch: false },
      { name: 'Messages readable by provider', styrby: 'Never', channels: 'Telegram/Discord can read', dispatch: 'Anthropic can read' },
      { name: 'Per-session encryption keys', styrby: true, channels: false, dispatch: false },
      { name: 'Key derivation (HMAC-SHA512)', styrby: true, channels: false, dispatch: false },
      { name: 'Your code stays on your machine', styrby: true, channels: true, dispatch: true },
    ],
  },
  {
    name: 'Agent Support',
    features: [
      { name: 'Claude Code', styrby: true, channels: true, dispatch: false },
      { name: 'OpenAI Codex', styrby: true, channels: false, dispatch: false },
      { name: 'Google Gemini CLI', styrby: true, channels: false, dispatch: false },
      { name: 'OpenCode', styrby: true, channels: false, dispatch: false },
      { name: 'Aider', styrby: true, channels: false, dispatch: false },
      { name: 'Switch agents mid-session', styrby: true, channels: false, dispatch: false },
    ],
  },
  {
    name: 'Reliability & Connectivity',
    features: [
      { name: 'Works when laptop sleeps', styrby: 'Queues commands', channels: false, dispatch: false },
      { name: 'Offline command queue', styrby: true, channels: false, dispatch: false },
      { name: 'Auto-reconnect with session resume', styrby: true, channels: false, dispatch: false },
      { name: 'Push notifications on completion', styrby: true, channels: 'Via Telegram/Discord', dispatch: false },
      { name: 'Quiet hours / Do Not Disturb', styrby: true, channels: 'Via Telegram/Discord', dispatch: false },
      { name: 'Smart notification priority scoring', styrby: true, channels: false, dispatch: false },
    ],
  },
  {
    name: 'Cost & Budget Management',
    features: [
      { name: 'Real-time cost tracking', styrby: true, channels: false, dispatch: false },
      { name: 'Cross-agent cost comparison', styrby: true, channels: false, dispatch: false },
      { name: 'Budget alerts with auto-actions', styrby: true, channels: false, dispatch: false },
      { name: 'Daily cost aggregation dashboard', styrby: true, channels: false, dispatch: false },
      { name: 'Team cost attribution', styrby: true, channels: false, dispatch: false },
    ],
  },
  {
    name: 'Experience & Integration',
    features: [
      { name: 'Purpose-built mobile app', styrby: true, channels: false, dispatch: 'Claude app only' },
      { name: 'QR code pairing', styrby: true, channels: false, dispatch: true },
      { name: 'Session history & bookmarks', styrby: true, channels: false, dispatch: false },
      { name: 'Permission approval from phone', styrby: true, channels: true, dispatch: false },
      { name: 'Prompt templates', styrby: true, channels: false, dispatch: false },
      { name: 'Third-party dependency', styrby: 'None', channels: 'Telegram or Discord', dispatch: 'Claude Desktop' },
      { name: 'Requires account with', styrby: 'Styrby', channels: 'Telegram/Discord + Claude', dispatch: 'Claude' },
    ],
  },
];

const securityHighlights = [
  {
    icon: Lock,
    title: 'E2E Encrypted',
    description: 'XSalsa20-Poly1305 encryption via TweetNaCl. Per-session keys derived with HMAC-SHA512. We never see your code.',
  },
  {
    icon: Eye,
    title: 'Zero Knowledge',
    description: 'Session content is encrypted before it leaves your machine. Styrby servers relay ciphertext, never plaintext.',
  },
  {
    icon: Server,
    title: 'No Third Parties',
    description: 'Your data never touches Telegram, Discord, or any third-party messaging platform. Direct relay only.',
  },
  {
    icon: Shield,
    title: 'Audit Trail',
    description: 'Every security-relevant action is logged: logins, pairings, permission approvals, key operations.',
  },
  {
    icon: Wifi,
    title: 'Resilient Connection',
    description: 'Commands queue offline and sync when reconnected. Your laptop can sleep. Styrby remembers.',
  },
  {
    icon: Smartphone,
    title: '5 Agents, 1 App',
    description: 'Claude, Codex, Gemini, OpenCode, Aider. All from one secure mobile app. No vendor lock-in.',
  },
];

/* ── Components ─────────────────────────────────────────────────────── */

/**
 * Renders a cell value as a check icon, minus icon, or text string.
 * Matches the pricing page CellValue pattern for visual consistency.
 *
 * @param value - true renders amber check, false renders muted minus, string renders text
 * @param highlight - when true, applies amber styling (used for Styrby column)
 */
function CellValue({ value, highlight }: { value: boolean | string; highlight?: boolean }) {
  if (value === true) {
    return <Check className={cn('mx-auto h-4 w-4', highlight ? 'text-amber-500' : 'text-emerald-500/70')} />;
  }
  if (value === false) {
    return <Minus className="mx-auto h-4 w-4 text-muted-foreground/40" />;
  }
  return (
    <span className={cn('text-sm', highlight ? 'text-amber-500 font-medium' : 'text-muted-foreground')}>
      {value}
    </span>
  );
}

/**
 * Renders a comparison category header and its feature rows.
 * Extracted to avoid React Fragment key warnings in the table body.
 */
function ComparisonCategoryRows({ category }: { category: ComparisonCategory }) {
  return (
    <>
      <tr>
        <td
          colSpan={4}
          className="pt-8 pb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground"
        >
          {category.name}
        </td>
      </tr>
      {category.features.map((feature, idx) => (
        <tr
          key={feature.name}
          className={cn(
            'border-b border-border/20',
            idx === category.features.length - 1 && 'border-border/40',
          )}
        >
          <td className="py-3.5 text-sm text-foreground">{feature.name}</td>
          <td className="py-3.5 text-center">
            <CellValue value={feature.styrby} highlight />
          </td>
          <td className="py-3.5 text-center">
            <CellValue value={feature.channels} />
          </td>
          <td className="py-3.5 text-center">
            <CellValue value={feature.dispatch} />
          </td>
        </tr>
      ))}
    </>
  );
}

/* ── Page ────────────────────────────────────────────────────────────── */

export default function SecurityComparePage() {
  return (
    <main id="main-content" tabIndex={-1} className="min-h-[100dvh]">
      <Navbar />

      {/* Hero */}
      <section className="pt-32 pb-16">
        <div className="mx-auto max-w-7xl px-6 text-center">
          <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-amber-500/10 border border-amber-500/20">
            <Shield className="h-8 w-8 text-amber-500" />
          </div>
          <h1 className="text-balance text-4xl font-bold tracking-tight text-foreground md:text-5xl">
            Your Code Deserves Better Security
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-lg text-muted-foreground leading-relaxed">
            Claude Code Channels routes your sessions through Telegram and Discord.
            Dispatch sends them through Anthropic&apos;s servers.
            Styrby encrypts end-to-end. We never see your code.
          </p>
        </div>
      </section>

      {/* Security Highlights Grid */}
      <section className="pb-24">
        <div className="mx-auto max-w-7xl px-6">
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {securityHighlights.map((item) => (
              <div
                key={item.title}
                className="rounded-xl bg-card/60 border border-border/60 p-6 transition-colors hover:border-amber-500/30"
              >
                <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-amber-500/10">
                  <item.icon className="h-5 w-5 text-amber-500" />
                </div>
                <h3 className="font-semibold text-foreground">{item.title}</h3>
                <p className="mt-2 text-sm text-muted-foreground leading-relaxed">
                  {item.description}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Comparison Table */}
      <section className="py-24 border-t border-border/30">
        <div className="mx-auto max-w-5xl px-6">
          <h2 className="text-balance text-center text-3xl font-bold tracking-tight text-foreground">
            Feature-by-Feature Comparison
          </h2>
          <p className="mx-auto mt-3 max-w-lg text-center text-muted-foreground">
            See exactly how Styrby compares to Anthropic&apos;s built-in solutions.
          </p>

          <div className="mt-12 overflow-x-auto">
            <table className="w-full min-w-[700px]">
              <thead>
                <tr className="border-b border-border/60">
                  <th className="pb-4 text-left text-sm font-medium text-muted-foreground w-[34%]">
                    Feature
                  </th>
                  <th className="pb-4 text-center text-sm font-medium w-[22%]">
                    <span className="text-amber-500">Styrby</span>
                  </th>
                  <th className="pb-4 text-center text-sm font-medium text-muted-foreground w-[22%]">
                    <span className="block text-xs text-muted-foreground/60">Claude Code</span>
                    Channels
                  </th>
                  <th className="pb-4 text-center text-sm font-medium text-muted-foreground w-[22%]">
                    <span className="block text-xs text-muted-foreground/60">Claude</span>
                    Dispatch
                  </th>
                </tr>
              </thead>

              <tbody>
                {comparisonCategories.map((category) => (
                  <ComparisonCategoryRows key={category.name} category={category} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* How encryption works */}
      <section className="py-24 border-t border-border/30">
        <div className="mx-auto max-w-4xl px-6">
          <h2 className="text-balance text-center text-3xl font-bold tracking-tight text-foreground">
            How Styrby Encryption Works
          </h2>
          <p className="mx-auto mt-3 max-w-lg text-center text-muted-foreground">
            Your code never leaves your machine unencrypted.
          </p>

          <div className="mt-12 rounded-xl bg-card/60 border border-border/60 p-8 font-mono text-sm">
            <div className="space-y-6 text-muted-foreground">
              <div className="flex items-start gap-4">
                <span className="shrink-0 rounded-full bg-amber-500/10 px-2.5 py-1 text-xs font-semibold text-amber-500">1</span>
                <div>
                  <p className="text-foreground font-semibold font-sans">Key Generation</p>
                  <p className="mt-1 font-sans">Each session generates a unique keypair using <code className="text-amber-500/80">TweetNaCl.box.keyPair()</code>. Keys are derived via <code className="text-amber-500/80">HMAC-SHA512</code> from user + machine + session ID.</p>
                </div>
              </div>
              <div className="flex items-start gap-4">
                <span className="shrink-0 rounded-full bg-amber-500/10 px-2.5 py-1 text-xs font-semibold text-amber-500">2</span>
                <div>
                  <p className="text-foreground font-semibold font-sans">Message Encryption</p>
                  <p className="mt-1 font-sans">Every message is encrypted with <code className="text-amber-500/80">XSalsa20-Poly1305</code> before leaving your machine. A random nonce ensures no two ciphertexts are identical.</p>
                </div>
              </div>
              <div className="flex items-start gap-4">
                <span className="shrink-0 rounded-full bg-amber-500/10 px-2.5 py-1 text-xs font-semibold text-amber-500">3</span>
                <div>
                  <p className="text-foreground font-semibold font-sans">Relay (Zero Knowledge)</p>
                  <p className="mt-1 font-sans">Styrby&apos;s relay server forwards ciphertext only. It cannot decrypt your messages. Only your paired devices hold the private keys.</p>
                </div>
              </div>
              <div className="flex items-start gap-4">
                <span className="shrink-0 rounded-full bg-amber-500/10 px-2.5 py-1 text-xs font-semibold text-amber-500">4</span>
                <div>
                  <p className="text-foreground font-semibold font-sans">Mobile Decryption</p>
                  <p className="mt-1 font-sans">Your phone decrypts messages locally using the shared secret established during QR code pairing. Code is visible only on your devices.</p>
                </div>
              </div>
            </div>
          </div>

          {/* Contrast with alternatives */}
          <div className="mt-8 grid gap-4 md:grid-cols-2">
            <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-6">
              <h3 className="font-semibold text-red-400">Claude Code Channels</h3>
              <p className="mt-2 text-sm text-muted-foreground leading-relaxed">
                Your session messages are sent as plaintext through Telegram or Discord servers.
                These third-party platforms can read, log, and index your code.
                Your prompts, file paths, and agent responses traverse infrastructure you don&apos;t control.
              </p>
            </div>
            <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-6">
              <h3 className="font-semibold text-amber-500">Styrby</h3>
              <p className="mt-2 text-sm text-muted-foreground leading-relaxed">
                Messages are encrypted on your machine before transmission.
                Styrby&apos;s relay sees only ciphertext. No third-party messaging platforms are involved.
                Only your paired devices can decrypt session content.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="relative overflow-hidden py-24">
        <div className="absolute inset-0 bg-gradient-to-r from-amber-500/10 via-amber-500/5 to-transparent" />
        <div className="absolute inset-0 dot-grid opacity-30" />

        <div className="relative mx-auto max-w-7xl px-6 text-center">
          <h2 className="mx-auto max-w-2xl text-balance text-3xl font-bold tracking-tight text-foreground md:text-4xl">
            Control Your AI Agents Without Compromising Security
          </h2>
          <p className="mx-auto mt-4 max-w-md text-muted-foreground leading-relaxed">
            E2E encrypted. Multi-agent. Purpose-built for developers.
          </p>
          <div className="mt-8 flex items-center justify-center gap-4">
            <Button
              asChild
              size="lg"
              className="bg-amber-500 px-10 text-background hover:bg-amber-600 font-semibold text-base h-12"
            >
              <Link href="/signup">
                Get Started Free
                <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
            </Button>
            <Button
              variant="outline"
              asChild
              size="lg"
              className="border-border/60 text-muted-foreground hover:text-foreground bg-transparent h-12"
            >
              <Link href="/security">
                Security Details
              </Link>
            </Button>
          </div>
        </div>
      </section>

      <Footer />
    </main>
  );
}
