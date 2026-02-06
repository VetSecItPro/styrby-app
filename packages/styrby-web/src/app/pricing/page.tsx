'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Check, Minus, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Navbar } from '@/components/landing/navbar';
import { Footer } from '@/components/landing/footer';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';

/**
 * Public pricing page with plan comparison, feature table, and FAQ.
 *
 * WHY public (no auth required): Moving pricing out from behind the auth wall
 * lets prospective users compare plans before signing up. This reduces friction
 * in the acquisition funnel — users can see exactly what they get before
 * creating an account.
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
    ctaVariant: 'outline' as const,
    features: [
      '1 connected machine',
      '1 AI agent (your choice)',
      '7-day session history',
      '1,000 messages/month',
      'Basic cost view',
    ],
  },
  {
    name: 'Pro',
    description: 'For developers who ship daily with AI',
    monthly: 19,
    annual: 190,
    savings: 38,
    popular: true,
    cta: 'Start Free Trial',
    ctaVariant: 'default' as const,
    features: [
      '5 connected machines',
      'All 5 AI agents',
      '90-day session history',
      '25,000 messages/month',
      'Full cost dashboard',
      '3 budget alerts',
      'Email support',
    ],
  },
  {
    name: 'Power',
    description: 'For teams and power users',
    monthly: 49,
    annual: 490,
    savings: 98,
    popular: false,
    cta: 'Start Free Trial',
    ctaVariant: 'default' as const,
    features: [
      '15 connected machines',
      'All 5 AI agents',
      '1-year session history',
      '100,000 messages/month',
      'Full cost dashboard',
      '10 budget alerts',
      '5 team members',
      'API access',
      'Priority support',
    ],
  },
];

const comparisonCategories = [
  {
    name: 'Usage',
    features: [
      { name: 'Connected machines', free: '1', pro: '5', power: '15' },
      { name: 'AI agents', free: '1', pro: 'All 5', power: 'All 5' },
      { name: 'Messages per month', free: '1,000', pro: '25,000', power: '100,000' },
      { name: 'Session history', free: '7 days', pro: '90 days', power: '1 year' },
    ],
  },
  {
    name: 'Monitoring & Alerts',
    features: [
      { name: 'Real-time session feed', free: true, pro: true, power: true },
      { name: 'Cost tracking', free: 'Basic', pro: 'Full dashboard', power: 'Full dashboard' },
      { name: 'Budget alerts', free: false, pro: '3', power: '10' },
      { name: 'Cost attribution by agent', free: false, pro: true, power: true },
      { name: 'Daily / weekly reports', free: false, pro: true, power: true },
    ],
  },
  {
    name: 'Security & Privacy',
    features: [
      { name: 'End-to-end encryption', free: true, pro: true, power: true },
      { name: 'Zero-knowledge architecture', free: true, pro: true, power: true },
      { name: 'Permission approval logs', free: true, pro: true, power: true },
      { name: 'Audit trail export', free: false, pro: false, power: true },
    ],
  },
  {
    name: 'Collaboration & Integration',
    features: [
      { name: 'Team members', free: false, pro: false, power: '5' },
      { name: 'Shared dashboards', free: false, pro: false, power: true },
      { name: 'API access', free: false, pro: false, power: true },
      { name: 'Webhooks', free: false, pro: false, power: true },
    ],
  },
  {
    name: 'Support',
    features: [
      { name: 'Community forum', free: true, pro: true, power: true },
      { name: 'Email support', free: false, pro: true, power: true },
      { name: 'Priority support', free: false, pro: false, power: true },
      { name: 'Dedicated onboarding', free: false, pro: false, power: true },
    ],
  },
];

const faqs = [
  {
    q: 'Is my code data encrypted?',
    a: 'Yes, all data is end-to-end encrypted using TweetNaCl. We use a zero-knowledge architecture, meaning we never see your code or prompts. Only metadata (costs, timestamps, status) is processed on our servers.',
  },
  {
    q: 'Which AI agents are supported?',
    a: 'Styrby supports five AI coding agents: Claude Code (Anthropic), Codex (OpenAI), Gemini CLI (Google), OpenCode, and Aider. All five are available on Pro and Power plans.',
  },
  {
    q: 'Does it work offline?',
    a: 'Yes! Commands queue offline and sync automatically when your connection is restored. You\'ll never lose a permission approval or cost record.',
  },
  {
    q: 'Can I use it with my team?',
    a: 'Absolutely. The Power plan supports up to 5 team members with shared dashboards, cost attribution, and team-level budget alerts.',
  },
  {
    q: 'What happens if I hit my message limit?',
    a: 'You\'ll receive a notification well before hitting the limit. If you do reach it, monitoring continues in read-only mode. You can upgrade anytime to increase your limit.',
  },
  {
    q: 'Can I switch plans at any time?',
    a: 'Yes. You can upgrade, downgrade, or cancel at any time. When upgrading, you\'ll be prorated for the remainder of the billing cycle. When downgrading, the change takes effect at the next billing date.',
  },
  {
    q: 'Is there a free trial for paid plans?',
    a: 'Yes, both the Pro and Power plans include a 14-day free trial with full access to all features. No credit card required to start.',
  },
  {
    q: 'Is there a mobile app?',
    a: 'Our iOS app is launching soon. In the meantime, the web dashboard is fully responsive and works beautifully on mobile browsers. Android app is on the roadmap.',
  },
];

function CellValue({ value }: { value: boolean | string }) {
  if (value === true) {
    return <Check className="mx-auto h-4 w-4 text-amber-500" />;
  }
  if (value === false) {
    return <Minus className="mx-auto h-4 w-4 text-muted-foreground/40" />;
  }
  return <span className="text-sm text-foreground">{value}</span>;
}

export default function PricingPage() {
  const [annual, setAnnual] = useState(false);

  return (
    <main className="min-h-screen">
      <Navbar />

      {/* Hero */}
      <section className="pt-32 pb-16">
        <div className="mx-auto max-w-7xl px-6 text-center">
          <h1 className="text-balance text-4xl font-bold tracking-tight text-foreground md:text-5xl">
            Simple, Transparent Pricing
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-lg text-muted-foreground leading-relaxed">
            Start free, scale as you grow. No hidden fees, no surprises. Cancel anytime.
          </p>
        </div>
      </section>

      {/* Toggle */}
      <section className="pb-4">
        <div className="mx-auto max-w-7xl px-6">
          <div className="flex items-center justify-center gap-3">
            <span className={cn('text-sm', !annual ? 'text-foreground font-medium' : 'text-muted-foreground')}>
              Monthly
            </span>
            <button
              type="button"
              onClick={() => setAnnual(!annual)}
              className={cn(
                'relative h-6 w-11 rounded-full transition-colors duration-200',
                annual ? 'bg-amber-500' : 'bg-secondary',
              )}
              role="switch"
              aria-checked={annual}
              aria-label="Toggle annual billing"
            >
              <span
                className={cn(
                  'absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-foreground transition-transform duration-200',
                  annual && 'translate-x-5',
                )}
              />
            </button>
            <span className={cn('text-sm', annual ? 'text-foreground font-medium' : 'text-muted-foreground')}>
              Annual{' '}
              <span className="text-xs text-amber-500 font-medium">(Save up to $98)</span>
            </span>
          </div>
        </div>
      </section>

      {/* Pricing Cards */}
      <section className="py-12">
        <div className="mx-auto max-w-7xl px-6">
          <div className="grid gap-6 md:grid-cols-3">
            {plans.map((plan) => (
              <div
                key={plan.name}
                className={cn(
                  'relative rounded-xl bg-card/60 p-8 transition-all duration-200',
                  plan.popular
                    ? 'border-2 border-amber-500/50 amber-glow'
                    : 'border border-border/60',
                )}
              >
                {plan.popular && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-amber-500 px-3 py-1 text-xs font-semibold text-background">
                    Most Popular
                  </div>
                )}

                <h3 className="text-xl font-semibold text-foreground">{plan.name}</h3>
                <p className="mt-1 text-sm text-muted-foreground">{plan.description}</p>
                <div className="mt-4 flex items-baseline gap-1">
                  <span className="font-mono text-4xl font-bold text-foreground">
                    ${annual && plan.annual > 0 ? Math.round(plan.annual / 12) : plan.monthly}
                  </span>
                  {plan.monthly > 0 && <span className="text-sm text-muted-foreground">/month</span>}
                </div>
                {annual && plan.savings && (
                  <p className="mt-1 text-xs text-amber-500">
                    ${plan.annual}/year — save ${plan.savings}
                  </p>
                )}

                <ul className="mt-8 space-y-3">
                  {plan.features.map((feature) => (
                    <li key={feature} className="flex items-center gap-3 text-sm text-muted-foreground">
                      <Check className="h-4 w-4 shrink-0 text-amber-500" />
                      {feature}
                    </li>
                  ))}
                </ul>

                <div className="mt-8">
                  {plan.ctaVariant === 'default' ? (
                    <Button asChild className="w-full bg-amber-500 text-background hover:bg-amber-600 font-medium">
                      <Link href="/signup">{plan.cta}</Link>
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      asChild
                      className="w-full border-border/60 text-muted-foreground hover:text-foreground bg-transparent"
                    >
                      <Link href="/signup">{plan.cta}</Link>
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Feature Comparison Table */}
      <section className="py-24">
        <div className="mx-auto max-w-5xl px-6">
          <h2 className="text-balance text-center text-3xl font-bold tracking-tight text-foreground">
            Compare All Features
          </h2>
          <p className="mx-auto mt-3 max-w-lg text-center text-muted-foreground">
            A detailed breakdown of what each plan includes.
          </p>

          <div className="mt-12 overflow-x-auto">
            <table className="w-full min-w-[600px]">
              <thead>
                <tr className="border-b border-border/60">
                  <th className="pb-4 text-left text-sm font-medium text-muted-foreground w-[40%]">Feature</th>
                  <th className="pb-4 text-center text-sm font-medium text-muted-foreground w-[20%]">Free</th>
                  <th className="pb-4 text-center text-sm font-medium w-[20%]">
                    <span className="text-amber-500">Pro</span>
                  </th>
                  <th className="pb-4 text-center text-sm font-medium text-muted-foreground w-[20%]">Power</th>
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

      {/* FAQ */}
      <section className="py-24 border-t border-border/30">
        <div className="mx-auto max-w-3xl px-6">
          <h2 className="text-balance text-center text-3xl font-bold tracking-tight text-foreground">
            Frequently Asked Questions
          </h2>

          <Accordion type="single" collapsible className="mt-12">
            {faqs.map((faq, i) => (
              <AccordionItem key={i} value={`faq-${i}`} className="border-border/40">
                <AccordionTrigger className="text-left text-foreground hover:text-amber-500 hover:no-underline">
                  {faq.q}
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground leading-relaxed">
                  {faq.a}
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </div>
      </section>

      {/* Final CTA */}
      <section className="relative overflow-hidden py-24">
        <div className="absolute inset-0 bg-gradient-to-r from-amber-500/10 via-amber-500/5 to-transparent" />
        <div className="absolute inset-0 dot-grid opacity-30" />

        <div className="relative mx-auto max-w-7xl px-6 text-center">
          <h2 className="mx-auto max-w-2xl text-balance text-3xl font-bold tracking-tight text-foreground md:text-4xl">
            Start Free — No credit card required
          </h2>
          <p className="mx-auto mt-4 max-w-md text-muted-foreground leading-relaxed">
            Get full visibility into your AI coding agents in under two minutes.
          </p>
          <div className="mt-8">
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
          </div>
        </div>
      </section>

      <Footer />
    </main>
  );
}

/**
 * Renders a comparison category with its header and feature rows.
 * Extracted to avoid React Fragment key warning in the table.
 */
function ComparisonCategory({ category }: { category: typeof comparisonCategories[number] }) {
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
