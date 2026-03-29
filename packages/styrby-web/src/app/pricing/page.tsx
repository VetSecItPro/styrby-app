'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Check, X, Minus, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Navbar } from '@/components/landing/navbar';
import { Footer } from '@/components/landing/footer';

/**
 * Public pricing page with plan comparison, feature table, and FAQ.
 *
 * WHY public (no auth required): Moving pricing out from behind the auth wall
 * lets prospective users compare plans before signing up. This reduces friction
 * in the acquisition funnel - users can see exactly what they get before
 * creating an account.
 *
 * WHY decoy layout: Pro is visually highlighted as the recommended choice, but
 * Power is close enough in price that informed buyers self-select into it. Free
 * anchors the low end so $24/mo feels reasonable.
 */

const plans = [
  {
    name: 'Free',
    description: 'For individual developers getting started',
    monthly: 0,
    annual: 0,
    savings: null,
    popular: false,
    cta: 'Get Started',
    ctaVariant: 'ghost' as const,
    included: [
      '1 connected machine',
      '3 agents: Claude Code, Codex, Gemini CLI',
      '7-day session history',
      '1,000 messages/month',
      'Cost dashboard',
      '1 budget alert',
      'E2E encryption',
      'Push notifications',
      'Offline queue',
      'Device pairing',
    ],
    notIncluded: [
      'Per-message cost tracking',
      'Session checkpoints',
      'Team management',
      'Voice commands',
    ],
  },
  {
    name: 'Pro',
    description: 'For developers who ship daily with AI',
    monthly: 24,
    annual: 240,
    savings: 48,
    popular: false,
    cta: 'Sign Up for Pro',
    ctaVariant: 'amber' as const,
    included: [
      '3 connected machines',
      '9 agents (+ OpenCode, Aider, Goose, Amp, Crush, Kilo)',
      '90-day session history',
      '25,000 messages/month',
      'Cost dashboard',
      'Export and import',
      '3 budget alerts',
      'Email support',
    ],
    notIncluded: [],
  },
  {
    name: 'Power',
    description: 'For teams and power users',
    monthly: 59,
    annual: 590,
    savings: 98,
    popular: false,
    cta: 'Sign Up for Power',
    ctaVariant: 'outline' as const,
    included: [
      'Everything in Pro, plus:',
      'All 11 agents (+ Kiro and Droid)',
      '9 machines, 5 budget alerts',
      'Session checkpoints and sharing',
      'Per-message costs and context breakdown',
      'Voice commands and cloud monitoring',
      'Code review from mobile',
      'OTEL export (Grafana, Datadog, and more)',
      'Team management (3 members) and API access',
    ],
    notIncluded: [],
  },
];

const comparisonCategories = [
  {
    name: 'Usage & Limits',
    features: [
      { name: 'Connected machines', free: '1', pro: '3', power: '9' },
      { name: 'AI agents supported', free: '3 (Claude Code, Codex, Gemini CLI)', pro: '9 agents', power: 'All 11 agents' },
      { name: 'Messages per month', free: '1,000', pro: '25,000', power: '100,000' },
      { name: 'Session history retention', free: '7 days', pro: '90 days', power: '1 year' },
      { name: 'Session bookmarks', free: '5', pro: 'Unlimited', power: 'Unlimited' },
      { name: 'Prompt templates', free: '3', pro: '20', power: 'Unlimited' },
    ],
  },
  {
    name: 'Cost Management',
    features: [
      { name: 'Real-time cost tracking', free: 'Basic', pro: 'Full dashboard', power: 'Full dashboard' },
      { name: 'Cost breakdown by agent', free: false, pro: false, power: true },
      { name: 'Cost breakdown by model', free: false, pro: false, power: true },
      { name: 'Cost breakdown by project', free: false, pro: false, power: true },
      { name: 'Per-message cost tracking', free: false, pro: false, power: true },
      { name: 'Per-file context breakdown', free: false, pro: false, power: true },
      { name: 'Activity graph', free: false, pro: false, power: true },
      { name: 'Budget alerts', free: '1', pro: '3', power: '5' },
      { name: 'Auto-pause on budget exceeded', free: false, pro: false, power: true },
      { name: 'Daily cost summary view', free: false, pro: false, power: true },
      { name: 'Cost export (CSV)', free: false, pro: false, power: true },
    ],
  },
  {
    name: 'Sessions',
    features: [
      { name: 'Session replay', free: true, pro: true, power: true },
      { name: 'Session checkpoints', free: false, pro: false, power: true },
      { name: 'Session sharing', free: false, pro: false, power: true },
      { name: 'Export and import', free: false, pro: true, power: true },
    ],
  },
  {
    name: 'Agent Control',
    features: [
      { name: 'Real-time session feed', free: true, pro: true, power: true },
      { name: 'Permission approval from mobile', free: true, pro: true, power: true },
      { name: 'Risk-level badges', free: true, pro: true, power: true },
      { name: 'Agent-specific configuration', free: false, pro: true, power: true },
      { name: 'Auto-approve rules', free: false, pro: true, power: true },
      { name: 'Blocked tool lists', free: false, pro: true, power: true },
      { name: 'Offline command queue', free: true, pro: true, power: true },
      { name: 'Voice commands', free: false, pro: false, power: true },
      { name: 'Cloud monitoring', free: false, pro: false, power: true },
      { name: 'Code review from mobile', free: false, pro: false, power: true },
      { name: 'Rust parser', free: true, pro: true, power: true },
    ],
  },
  {
    name: 'Notifications',
    features: [
      { name: 'Push notifications', free: true, pro: true, power: true },
      { name: 'Permission request alerts', free: true, pro: true, power: true },
      { name: 'Budget threshold alerts', free: true, pro: true, power: true },
      { name: 'Error and failure alerts', free: false, pro: true, power: true },
      { name: 'Quiet hours', free: false, pro: true, power: true },
      { name: 'Weekly summary emails', free: false, pro: true, power: true },
    ],
  },
  {
    name: 'Security & Privacy',
    features: [
      { name: 'End-to-end encryption (TweetNaCl)', free: true, pro: true, power: true },
      { name: 'Zero-knowledge architecture', free: true, pro: true, power: true },
      { name: 'Permission approval audit log', free: true, pro: true, power: true },
      { name: 'API key hashing (bcrypt)', free: true, pro: true, power: true },
      { name: 'Rate limiting on all endpoints', free: true, pro: true, power: true },
      { name: 'Audit trail export', free: false, pro: false, power: true },
    ],
  },
  {
    name: 'Collaboration',
    features: [
      { name: 'Team members', free: false, pro: false, power: '3' },
      { name: 'Team invitations', free: false, pro: false, power: true },
      { name: 'Role-based access (owner/admin/member)', free: false, pro: false, power: true },
      { name: 'Shared cost dashboards', free: false, pro: false, power: true },
    ],
  },
  {
    name: 'Integrations',
    features: [
      { name: 'REST API access', free: false, pro: false, power: true },
      { name: 'Webhooks', free: false, pro: '3', power: '10' },
      { name: 'API key management', free: false, pro: false, power: true },
      { name: 'OTEL export (Grafana, Datadog, and more)', free: false, pro: false, power: true },
    ],
  },
  {
    name: 'Support',
    features: [
      { name: 'Email support', free: false, pro: true, power: true },
    ],
  },
];

const faqs = [
  {
    q: 'What agents does Styrby support?',
    a: 'Styrby supports eleven CLI coding agents: Claude Code (Anthropic), Codex (OpenAI), Gemini CLI (Google), OpenCode, Aider, Goose, Amp, Crush, Kilo, Kiro, and Droid. The Free plan includes the first three. Pro unlocks eight. Power unlocks all eleven.',
  },
  {
    q: 'Can I use my own API keys?',
    a: 'Yes. Droid supports BYOK (bring your own key), so you can connect your own API credentials directly. Keys are hashed with bcrypt before storage and never stored in plaintext.',
  },
  {
    q: 'Is my data encrypted?',
    a: 'Yes. All session data is end-to-end encrypted using TweetNaCl with a zero-knowledge architecture. We never see your code or prompts. Only metadata (costs, timestamps, status) is processed on our servers. Exported sessions remain encrypted, and shared session links require a separate key that you provide to recipients.',
  },
  {
    q: 'Can I use voice commands?',
    a: 'Yes. Voice commands are available on the Power tier. Dictate approvals, queries, or commands hands-free from your phone or browser.',
  },
  {
    q: 'Can I review code from my phone?',
    a: 'Yes. Code review from mobile is a Power tier feature. Submit a review request, monitor its progress, and receive a push notification when it completes.',
  },
  {
    q: 'What is OTEL export?',
    a: 'OpenTelemetry (OTEL) export lets you send agent session metrics, cost data, and trace events to any compatible observability platform such as Grafana, Datadog, or Honeycomb. Available on the Power tier.',
  },
  {
    q: 'Can I share session replays?',
    a: 'Yes, on the Power tier you can generate a share link for any session replay. Session data remains end-to-end encrypted and recipients need a separate decryption key you provide. Styrby never has access to the plaintext content.',
  },
  {
    q: 'What are session checkpoints?',
    a: 'Session checkpoints are named save points within a session. Mark a point in a long session to return to it later, compare progress, or share a specific moment in the conversation. Available on the Power tier.',
  },
  {
    q: 'How does cloud monitoring work?',
    a: 'Submit a cloud monitoring job from the dashboard or mobile app, track its progress in real time, and receive a push notification when it finishes or encounters an error. Available on the Power tier.',
  },
  {
    q: 'Does it work offline?',
    a: 'Yes. Commands queue locally and sync automatically when your connection is restored. You will never lose a permission approval or cost record.',
  },
  {
    q: 'Can I use it with my team?',
    a: 'Team management is available on the Power tier. Power supports up to 3 team members with shared dashboards and per-developer cost attribution, plus OTEL export for full observability. Pro is a single-user plan.',
  },
  {
    q: 'Can I switch plans at any time?',
    a: 'Yes. You can upgrade, downgrade, or cancel at any time. When upgrading, you will be prorated for the remainder of the billing cycle. When downgrading, the change takes effect at the next billing date.',
  },
  {
    q: 'Is there a free trial for paid plans?',
    a: 'Yes, both the Pro and Power plans include a 14-day free trial with full access to all features. No credit card required to start.',
  },
  {
    q: 'Is there a mobile app?',
    a: 'Our iOS app is launching soon. In the meantime, the web dashboard is fully responsive and works on mobile browsers. Android is on the roadmap.',
  },
];

/**
 * Renders a cell value for the comparison table.
 *
 * @param value - The feature value: true (included), false (not included), or a string
 * @returns The appropriate visual indicator
 */
function CellValue({ value }: { value: boolean | string }) {
  if (value === true) {
    return <Check className="mx-auto h-4 w-4 text-amber-500" />;
  }
  if (value === false) {
    return <Minus className="mx-auto h-4 w-4 text-zinc-700" />;
  }
  return <span className="text-sm text-foreground">{value}</span>;
}

/**
 * Renders a comparison category with its header row and feature rows.
 * Extracted to a separate component to avoid React Fragment key warnings in the table.
 *
 * @param category - The category data to render
 */
function ComparisonCategory({ category }: { category: typeof comparisonCategories[number] }) {
  return (
    <>
      <tr>
        <td
          colSpan={4}
          className="pt-8 pb-3 text-center text-[10px] font-semibold uppercase tracking-[0.2em] text-amber-500/60"
        >
          {category.name}
        </td>
      </tr>
      {category.features.map((feature, idx) => (
        <tr
          key={feature.name}
          className={cn(
            'border-b border-zinc-800/30',
            idx === category.features.length - 1 && 'border-zinc-800/60',
          )}
        >
          <td className="py-3.5 text-sm text-zinc-300">{feature.name}</td>
          <td className="py-3.5 text-center">
            <CellValue value={feature.free} />
          </td>
          <td className="py-3.5 text-center">
            <CellValue value={feature.pro} />
          </td>
          <td className="py-3.5 text-center">
            <CellValue value={feature.power} />
          </td>
        </tr>
      ))}
    </>
  );
}

/**
 * Individual pricing card for the pricing page.
 *
 * @param plan - The plan data to render
 * @param annual - Whether annual billing is active
 */
function PricingCard({
  plan,
  annual,
}: {
  plan: (typeof plans)[number];
  annual: boolean;
}) {
  const displayPrice =
    annual && plan.annual > 0 ? Math.round(plan.annual / 12) : plan.monthly;

  return (
    <div
      className={cn(
        'relative flex flex-col rounded-2xl px-8 py-6 transition-all duration-300',
        plan.popular
          ? 'border border-amber-500/40 bg-zinc-950 amber-glow z-10'
          : 'border border-zinc-800/80 bg-zinc-950/60 hover:border-zinc-700/80',
      )}
    >
      {/* Ambient glow for Pro */}
      {plan.popular && (
        <div
          className="pointer-events-none absolute inset-0 rounded-2xl"
          style={{
            background:
              'radial-gradient(ellipse 60% 40% at 50% 0%, rgba(245,158,11,0.07) 0%, transparent 70%)',
          }}
          aria-hidden="true"
        />
      )}

      {/* Most Popular badge */}
      {plan.popular && (
        <div className="mb-5 flex justify-center">
          <span className="rounded-full border border-amber-500/20 bg-amber-500/10 px-3 py-1 text-[10px] font-medium uppercase tracking-[0.2em] text-amber-400">
            Most Popular
          </span>
        </div>
      )}

      <div className="text-center">
        <h3
          className="text-2xl font-bold tracking-tight text-foreground"
        >
          {plan.name}
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">{plan.description}</p>
      </div>

      <div className="mt-6 flex items-baseline gap-1">
        <span className="text-5xl font-bold tracking-tight text-foreground">
          ${displayPrice}
        </span>
        {plan.monthly > 0 && (
          <span className="text-sm font-normal text-muted-foreground">/mo</span>
        )}
        {plan.monthly === 0 && (
          <span className="text-sm font-normal text-muted-foreground">forever</span>
        )}
      </div>

      {/* Annual savings - reserved height prevents layout shift */}
      <div className="mt-1 h-4">
        {annual && plan.savings ? (
          <p className="text-xs text-amber-500/80">
            ${plan.annual}/year (save ${plan.savings})
          </p>
        ) : null}
      </div>

      <div
        className={cn(
          'mt-6 h-px',
          plan.popular ? 'bg-amber-500/20' : 'bg-zinc-800',
        )}
      />

      <ul className="mt-6 flex-1 space-y-3">
        {plan.included.map((feature) => (
          <li
            key={feature}
            className={cn(
              'flex items-start gap-3 text-sm',
              feature.endsWith('plus:') ? 'font-semibold text-zinc-200 pb-1 border-b border-zinc-800/60' : 'text-zinc-300',
            )}
          >
            {!feature.endsWith('plus:') && (
              <Check
                className={cn(
                  'mt-0.5 h-4 w-4 shrink-0',
                  plan.popular ? 'text-amber-400' : 'text-amber-500/70',
                )}
              />
            )}
            {feature}
          </li>
        ))}
        {plan.notIncluded.map((feature) => (
          <li
            key={feature}
            className="flex items-start gap-3 text-sm text-zinc-500"
          >
            <X className="mt-0.5 h-4 w-4 shrink-0 text-zinc-700" />
            {feature}
          </li>
        ))}
      </ul>

      <div className="mt-8 flex justify-center">
        {plan.ctaVariant === 'ghost' ? (
          <Button
            variant="outline"
            asChild
            className="rounded-full px-6 border-zinc-700 bg-transparent font-medium text-zinc-300 hover:border-zinc-500 hover:text-foreground transition-colors"
          >
            <Link href="/signup">{plan.cta}</Link>
          </Button>
        ) : (
          <Button
            asChild
            className="rounded-full px-6 bg-amber-500 font-semibold text-zinc-950 hover:bg-amber-400 active:bg-amber-600 transition-colors"
          >
            <Link href={`/signup?plan=${plan.name.toLowerCase()}`}>{plan.cta}</Link>
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * Public pricing page.
 * Includes pricing cards, full feature comparison table, FAQ, and CTA.
 */
export default function PricingPage() {
  const [annual, setAnnual] = useState(false);
  const [activeFaq, setActiveFaq] = useState(0);

  return (
    <main className="min-h-screen">
      <Navbar />

      {/* Hero */}
      <section className="pt-32 pb-16">
        <div className="mx-auto max-w-7xl px-6 text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-500/70">
            Pricing
          </p>
          <h1 className="mt-3 text-balance text-4xl font-bold tracking-tight text-foreground md:text-5xl">
            Simple, transparent pricing
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-lg text-muted-foreground leading-relaxed">
            Start free, scale as you grow. No hidden fees, no surprises. Cancel anytime.
          </p>
        </div>
      </section>

      {/* Annual/monthly toggle */}
      <section className="pb-4">
        <div className="mx-auto max-w-7xl px-6">
          <div className="flex items-center justify-center gap-4">
            <span
              className={cn(
                'text-sm transition-colors',
                !annual ? 'font-medium text-foreground' : 'text-muted-foreground',
              )}
            >
              Monthly
            </span>
            <button
              type="button"
              onClick={() => setAnnual(!annual)}
              className={cn(
                'relative h-6 w-11 rounded-full transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                annual ? 'bg-amber-500' : 'bg-zinc-700',
              )}
              role="switch"
              aria-checked={annual}
              aria-label="Toggle annual billing"
            >
              <span
                className={cn(
                  'absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform duration-200',
                  annual && 'translate-x-5',
                )}
              />
            </button>
            <span
              className={cn(
                'text-sm transition-colors',
                annual ? 'font-medium text-foreground' : 'text-muted-foreground',
              )}
            >
              Annual{' '}
              <span className="ml-1 rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.15em] text-amber-400">
                Save 2 months
              </span>
              {/* WHY $118: Power plan saves $98/year ($59 x 12 = $708 vs $590 annual) */}
            </span>
          </div>
        </div>
      </section>

      {/* Pricing Cards */}
      <section className="py-12">
        <div className="mx-auto max-w-7xl px-6">
          <div className="grid gap-4 md:grid-cols-3 md:items-stretch">
            {plans.map((plan) => (
              <PricingCard key={plan.name} plan={plan} annual={annual} />
            ))}
          </div>
          <p className="mt-8 text-center text-xs text-muted-foreground/60">
            14-day free trial on Pro and Power. No credit card required. Cancel anytime.
          </p>
        </div>
      </section>

      {/* Feature Comparison Table */}
      <section className="py-16 border-t border-zinc-800/40">
        <div className="mx-auto max-w-5xl px-6">
          <h2 className="text-balance text-center text-3xl font-bold tracking-tight text-foreground">
            Compare all features
          </h2>
          <p className="mx-auto mt-3 max-w-lg text-center text-muted-foreground">
            A detailed breakdown of what each plan includes.
          </p>

          <div className="mt-12 overflow-x-auto">
            <table className="w-full min-w-[600px]">
              <thead>
                <tr className="border-b border-zinc-800/60">
                  <th className="pb-4 text-left text-sm font-medium text-muted-foreground w-[40%]">
                    Feature
                  </th>
                  <th className="pb-4 text-center text-sm font-medium text-muted-foreground w-[20%]">
                    Free
                  </th>
                  <th className="pb-4 text-center text-sm font-semibold w-[20%]">
                    <span className="text-amber-400">Pro</span>
                  </th>
                  <th className="pb-4 text-center text-sm font-medium text-muted-foreground w-[20%]">
                    Power
                  </th>
                </tr>
              </thead>
              <tbody>
                {comparisonCategories.map((category) => (
                  <ComparisonCategory key={category.name} category={category} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* FAQ - two-column interactive layout */}
      <section className="py-24 border-t border-zinc-800/40">
        <div className="mx-auto max-w-7xl px-6">
          <div className="mx-auto max-w-2xl text-center">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-500/70">
              FAQ
            </p>
            <h2 className="mt-3 text-balance text-3xl font-bold tracking-tight text-foreground">
              Frequently asked questions
            </h2>
          </div>

          <div className="mt-16 grid gap-6 lg:grid-cols-[1fr_1.4fr] lg:gap-12">
            {/* Left: question list */}
            <nav aria-label="FAQ questions" className="flex flex-col gap-1">
              {faqs.map((faq, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => setActiveFaq(i)}
                  className={cn(
                    'group flex w-full items-start gap-3 rounded-lg px-4 py-3.5 text-left transition-colors duration-150',
                    i === activeFaq
                      ? 'bg-zinc-900 text-foreground'
                      : 'text-muted-foreground hover:bg-zinc-900/50 hover:text-foreground',
                  )}
                >
                  <span
                    className={cn(
                      'mt-1.5 h-3 w-0.5 shrink-0 rounded-full transition-colors duration-150',
                      i === activeFaq ? 'bg-amber-500' : 'bg-transparent',
                    )}
                    aria-hidden="true"
                  />
                  <span className="text-sm font-medium leading-snug">{faq.q}</span>
                </button>
              ))}
            </nav>

            {/* Right: answer panel */}
            <div className="lg:sticky lg:top-24">
              <div className="rounded-2xl border border-zinc-800/80 bg-zinc-950/60 p-8 lg:p-10">
                <h3 className="text-lg font-semibold leading-snug text-foreground">
                  {faqs[activeFaq].q}
                </h3>
                <div className="mt-4 h-px w-12 bg-amber-500/40" />
                <p className="mt-5 text-base leading-relaxed text-muted-foreground">
                  {faqs[activeFaq].a}
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className="relative overflow-hidden py-28 border-t border-zinc-800/40">
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              'radial-gradient(ellipse 80% 60% at 50% 50%, rgba(245,158,11,0.06) 0%, transparent 70%)',
          }}
          aria-hidden="true"
        />
        <div className="pointer-events-none absolute inset-0 dot-grid opacity-20" aria-hidden="true" />

        <div className="relative mx-auto max-w-3xl px-6 text-center">
          <h2 className="text-balance text-4xl font-bold tracking-tight text-foreground md:text-5xl">
            Start monitoring your agents in 90 seconds
          </h2>
          <div className="mt-10">
            <Button
              asChild
              size="lg"
              className="h-13 bg-amber-500 px-10 text-base font-semibold text-zinc-950 shadow-lg shadow-amber-500/20 hover:bg-amber-400 active:bg-amber-600 transition-colors"
            >
              <Link href="/signup">
                Get Started Free
                <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
            </Button>
          </div>
          <p className="mt-4 text-sm text-muted-foreground/60">
            Free plan available. No credit card required.
          </p>
        </div>
      </section>

      <Footer />
    </main>
  );
}
