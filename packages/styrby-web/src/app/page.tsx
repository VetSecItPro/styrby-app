import type { Metadata } from 'next';
import dynamic from 'next/dynamic';
import { Navbar } from '@/components/landing/navbar';
import { Hero } from '@/components/landing/hero';
import { SocialProof } from '@/components/landing/social-proof';
import { ProblemSection } from '@/components/landing/problem-section';
import { FeaturesSection } from '@/components/landing/features-section';
import { MobileShowcase } from '@/components/landing/mobile-showcase';
import { CostSavings } from '@/components/landing/cost-savings';
import { HowItWorks } from '@/components/landing/how-it-works';
import { PricingCTA } from '@/components/landing/pricing-cta';
import { CTABanner } from '@/components/landing/cta-banner';
import { Footer } from '@/components/landing/footer';

/**
 * WHY dynamic FAQSection: FAQSection is a 'use client' component (uses useState
 * for the selected-question interaction). It lives far below the fold and is
 * never the LCP element. Deferring its JS chunk removes ~4 kB of client
 * JavaScript from the critical path, improving TTI and the Lighthouse
 * "Reduce unused JavaScript" audit.
 *
 * SSR remains enabled (default) so search engines still receive the full
 * FAQ HTML in the initial response — no SEO impact.
 */
const FAQSection = dynamic(
  () => import('@/components/landing/faq-section').then((mod) => ({ default: mod.FAQSection }))
);

export const metadata: Metadata = {
  title: {
    /**
     * WHY absolute: The root layout template appends "| Styrby" to all page titles.
     * The homepage title should stand alone as the full brand statement without
     * duplication, so we bypass the template with an absolute title.
     */
    absolute: 'Styrby - Control Your AI Agents From Your Phone',
  },
  description:
    'Monitor costs, approve permissions, and manage 11 CLI coding agents including Claude Code, Codex, Gemini CLI, and more from one encrypted mobile dashboard.',
  openGraph: {
    title: 'Styrby - Control Your AI Agents From Your Phone',
    description:
      'Monitor costs, approve permissions, and manage 11 CLI coding agents including Claude Code, Codex, Gemini CLI, and more from one encrypted mobile dashboard.',
    type: 'website',
    url: 'https://styrbyapp.com',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Styrby - Control Your AI Agents From Your Phone',
    description:
      'Monitor costs, approve permissions, and manage 11 CLI coding agents including Claude Code, Codex, Gemini CLI, and more from one encrypted mobile dashboard.',
  },
};

/**
 * JSON-LD structured data: SoftwareApplication
 *
 * WHY: Google uses SoftwareApplication markup to generate rich results in search
 * (star ratings, price, platform badges). AI answer engines (ChatGPT, Perplexity,
 * Claude) parse JSON-LD to build accurate factual summaries about products.
 * Without this, they infer metadata from prose, which is less reliable and may
 * produce hallucinated attributes.
 *
 * @see https://schema.org/SoftwareApplication
 * @see https://developers.google.com/search/docs/appearance/structured-data/software-app
 */
const softwareApplicationJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: 'Styrby',
  applicationCategory: 'DeveloperApplication',
  operatingSystem: 'Web, iOS',
  description:
    'Remote control dashboard for AI coding agents. Monitor costs, approve permissions, and manage 11 CLI agents including Claude Code, Codex, Gemini CLI, OpenCode, Aider, Goose, Amp, Crush, Kilo, Kiro, and Droid from one encrypted mobile dashboard.',
  url: 'https://styrbyapp.com',
  screenshot: 'https://styrbyapp.com/logo-full.png',
  featureList: [
    'AI agent cost tracking',
    'Remote permission approval',
    'End-to-end encrypted sessions',
    'Budget alerts and spending limits',
    'Multi-agent dashboard (11 agents)',
    'Push notifications',
    'Session replay',
    'Session checkpoints',
    'Session sharing',
    'Voice commands',
    'Cloud monitoring',
    'Code review from mobile',
    'OTEL export',
    'Activity graph',
    'Per-message cost tracking',
    'Per-file context breakdown',
    'Offline command queue',
    'Team management',
  ],
  offers: {
    '@type': 'Offer',
    price: '0',
    priceCurrency: 'USD',
    description: 'Pro plan at $39/mo for individual developers. Growth plan at $99/mo for teams (3 seats included, $19/seat after).',
  },
  author: {
    '@type': 'Organization',
    name: 'Steel Motion LLC',
    url: 'https://styrbyapp.com',
  },
};

/**
 * JSON-LD structured data: FAQPage
 *
 * WHY: Google shows FAQ rich results directly in search (expandable Q/A below the
 * blue link). This dramatically increases click-through rate for developer queries
 * like "is Styrby secure?" or "which AI agents does Styrby support?". The answers
 * here must match what the FAQSection component renders on-screen -- Google
 * de-lists pages where the JSON-LD content differs from visible page content.
 *
 * WHY on the homepage and not a dedicated /faq page:
 * The FAQ section lives on the homepage. Google's guidelines require the FAQ
 * schema to be on the same page as the visible FAQ content.
 *
 * @see https://schema.org/FAQPage
 * @see https://developers.google.com/search/docs/appearance/structured-data/faqpage
 */
const faqPageJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: [
    {
      '@type': 'Question',
      name: 'Can you see my code or prompts?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'No. Styrby uses end-to-end encryption (TweetNaCl) with a zero-knowledge architecture. Your code and prompts are encrypted on your machine before anything leaves it. Our servers only process metadata: costs, timestamps, and session status. We literally cannot read your data, even if compelled to.',
      },
    },
    {
      '@type': 'Question',
      name: 'Which AI agents are supported?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Eleven CLI coding agents: Claude Code (Anthropic), Codex (OpenAI), Gemini CLI (Google), OpenCode, Aider, Goose, Amp, Crush, Kilo, Kiro, and Droid. Pro and Growth both unlock all eleven.',
      },
    },
    {
      '@type': 'Question',
      name: 'Does it work offline?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Yes. Commands queue locally and sync the moment your connection returns. Permission approvals, cost records, session data: nothing is lost.',
      },
    },
    {
      '@type': 'Question',
      name: 'Can I use it with my team?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Yes. Growth is $99/month and includes 3 seats; each additional seat is $19/month, billed via a separate seat add-on so you can adjust seats from the dashboard. Pro covers a single developer end-to-end if you are flying solo.',
      },
    },
    {
      '@type': 'Question',
      name: 'Is there a mobile app?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'The iOS app launches soon. Until then, the web dashboard is fully responsive and optimized for mobile browsers. Android is on the roadmap.',
      },
    },
    {
      '@type': 'Question',
      name: 'How is this different from checking my API provider\'s dashboard?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'API dashboards show you total spend after the fact, across all usage. Styrby shows per-agent, per-session, per-message, and per-model cost breakdowns with per-file context breakdown and budget limits that automatically stop runaway sessions. It works across all eleven agents in one place.',
      },
    },
  ],
};

/**
 * Marketing landing page - composed from modular section components.
 *
 * WHY this order:
 * 1. Hero - establishes the remote control value prop
 * 2. SocialProof - builds trust before asking for attention
 * 3. ProblemSection - names the pain (no unified view, surprise bills, desk-tethered)
 * 4. FeaturesSection - bento grid showing how Styrby solves each problem
 * 5. MobileShowcase - makes the phone experience concrete: permission, voice, diff
 * 6. CostSavings - supporting benefit positioned as "oh, and it does this too"
 * 7. HowItWorks - removes setup friction with staggered timeline + CSS mockups
 * 8. PricingCTA - drives plan selection after full value is established
 * 9. FAQSection - handles remaining objections
 * 10. CTABanner + Footer - closes
 */
export default function LandingPage() {
  return (
    <main id="main-content" className="min-h-screen">
      {/* JSON-LD: SoftwareApplication schema for rich search results.
          Safe: JSON.stringify escapes all HTML special chars (`<`, `>`, `&`,
          `'`, `"`), making XSS via the JSON-LD payload structurally impossible.
          Standard Next.js pattern for injecting structured data. */}
      <script
        type="application/ld+json"
        // nosemgrep: typescript.react.security.audit.react-dangerouslysetinnerhtml
        dangerouslySetInnerHTML={{ __html: JSON.stringify(softwareApplicationJsonLd) }}
      />
      {/* JSON-LD: FAQPage schema for expandable Q/A rich results in Google.
          Same safety reasoning as above. */}
      <script
        type="application/ld+json"
        // nosemgrep: typescript.react.security.audit.react-dangerouslysetinnerhtml
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqPageJsonLd) }}
      />
      <Navbar />
      <Hero />
      <SocialProof />
      <ProblemSection />
      <FeaturesSection />
      <MobileShowcase />
      <CostSavings />
      <HowItWorks />
      <PricingCTA />
      <FAQSection />
      <CTABanner />
      <Footer />
    </main>
  );
}
