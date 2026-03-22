import type { Metadata } from 'next';
import { Navbar } from '@/components/landing/navbar';
import { Hero } from '@/components/landing/hero';
import { SocialProof } from '@/components/landing/social-proof';
import { FeaturesSection } from '@/components/landing/features-section';
import { MobileShowcase } from '@/components/landing/mobile-showcase';
import { HowItWorks } from '@/components/landing/how-it-works';
import { PricingCTA } from '@/components/landing/pricing-cta';
import { FAQSection } from '@/components/landing/faq-section';
import { CTABanner } from '@/components/landing/cta-banner';
import { Footer } from '@/components/landing/footer';

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
    'Monitor costs, approve permissions, and manage Claude Code, Codex, Gemini CLI, and more from one encrypted mobile dashboard.',
  openGraph: {
    title: 'Styrby - Control Your AI Agents From Your Phone',
    description:
      'Monitor costs, approve permissions, and manage Claude Code, Codex, Gemini CLI, and more from one encrypted mobile dashboard.',
    type: 'website',
    url: 'https://styrbyapp.com',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Styrby - Control Your AI Agents From Your Phone',
    description:
      'Monitor costs, approve permissions, and manage Claude Code, Codex, Gemini CLI, and more from one encrypted mobile dashboard.',
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
    'Remote control dashboard for AI coding agents. Monitor costs, approve permissions, and manage Claude Code, Codex, Gemini CLI, OpenCode, and Aider from one encrypted mobile dashboard.',
  url: 'https://styrbyapp.com',
  screenshot: 'https://styrbyapp.com/logo-full.png',
  featureList: [
    'AI agent cost tracking',
    'Remote permission approval',
    'End-to-end encrypted sessions',
    'Budget alerts and spending limits',
    'Multi-agent dashboard',
    'Push notifications',
    'Session replay',
    'Offline command queue',
  ],
  offers: {
    '@type': 'Offer',
    price: '0',
    priceCurrency: 'USD',
    description: 'Free tier available. Pro and Power plans with additional features.',
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
        text: 'Five today: Claude Code (Anthropic), Codex (OpenAI), Gemini CLI (Google), OpenCode, and Aider. The Free plan includes one agent. Pro and Power plans unlock all five. We add new agents as the ecosystem grows.',
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
        text: 'The Power plan ($49/mo) supports up to 3 team members with shared dashboards, per-developer cost attribution, and team-level budget alerts.',
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
        text: 'API dashboards show you total spend after the fact, across all usage. Styrby shows per-agent, per-session, and per-model cost breakdowns with budget limits that automatically stop runaway sessions. It works across five different agents in one place.',
      },
    },
  ],
};

/**
 * Marketing landing page - composed from modular section components.
 *
 * WHY this order: Hero establishes the value prop. Social proof builds
 * trust. Features shows the top 3 capabilities (full list on /features).
 * How It Works removes friction. Pricing drives action. FAQ handles
 * objections. Final CTA closes.
 *
 * Removed from homepage (moved to /features): ProblemSection, UseCases,
 * CostSavings. These added depth but created a wall-of-text effect.
 */
export default function LandingPage() {
  return (
    <main id="main-content" className="min-h-screen">
      {/* JSON-LD: SoftwareApplication schema for rich search results */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(softwareApplicationJsonLd) }}
      />
      {/* JSON-LD: FAQPage schema for expandable Q/A rich results in Google */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqPageJsonLd) }}
      />
      <Navbar />
      <Hero />
      <SocialProof />
      <FeaturesSection />
      <MobileShowcase />
      <HowItWorks />
      <PricingCTA />
      <FAQSection />
      <CTABanner />
      <Footer />
    </main>
  );
}
