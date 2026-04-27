import type { Metadata } from 'next';
import Script from 'next/script';

/**
 * Layout for the /pricing page.
 *
 * WHY server layout (not client): Metadata and JSON-LD structured data must
 * live in a server component. The pricing page.tsx uses client-side state
 * for the billing toggle and seat slider, so metadata lives here instead.
 *
 * SEO: Schema.org Product markup helps search engines display pricing
 * snippets in results (Google Rich Results). Phase 6: surfaced offers
 * collapsed from four to two (Pro and Growth) following the tier
 * reconciliation in `.audit/styrby-fulltest.md`.
 *
 * WHY canonical URL: prevents duplicate-content penalties if the page is
 * accessible from multiple paths (www vs non-www, trailing-slash variants).
 */

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://styrbyapp.com';

export const metadata: Metadata = {
  title: 'Pricing - Pro and Growth Plans',
  description:
    'Styrby pricing: Pro at $39/mo for individual developers, Growth at $99/mo for teams (3 seats included, +$19/seat after). All 11 CLI coding agents. End-to-end encryption. ROI estimator and seat-count slider on this page.',
  alternates: {
    canonical: `${APP_URL}/pricing`,
  },
  openGraph: {
    title: 'Styrby Pricing — Pro and Growth',
    description:
      'Two plans, no surprises. Pro at $39/mo for solo developers. Growth at $99/mo for teams of 3, +$19/seat after.',
    type: 'website',
    url: `${APP_URL}/pricing`,
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Styrby Pricing — Pro and Growth',
    description:
      'Pro at $39/mo for solos. Growth at $99/mo for teams of 3 (+$19/seat after). 14-day free trial.',
  },
};

/**
 * Schema.org Product structured data for the Styrby pricing page.
 *
 * WHY JSON-LD (not microdata): JSON-LD is Google's recommended format,
 * does not pollute the HTML structure, and is easier to maintain.
 *
 * WHY two offers (Phase 6): the public ladder is now Pro + Growth.
 * Listing both lets search engines display rich pricing results and
 * helps SEO for "styrby pricing" and "ai coding agent price" queries.
 */
const structuredData = {
  '@context': 'https://schema.org',
  '@type': 'Product',
  name: 'Styrby',
  description:
    'Mobile control center for CLI coding agents. Monitor, approve, and manage Claude Code, Codex, Gemini CLI and 8 more agents from your phone.',
  url: `${APP_URL}/pricing`,
  brand: {
    '@type': 'Brand',
    name: 'Styrby',
  },
  offers: [
    {
      '@type': 'Offer',
      name: 'Pro',
      description: 'For individual developers who ship daily with AI',
      price: '39.00',
      priceCurrency: 'USD',
      priceSpecification: {
        '@type': 'UnitPriceSpecification',
        price: '39.00',
        priceCurrency: 'USD',
        unitText: 'MONTH',
      },
      availability: 'https://schema.org/InStock',
      url: `${APP_URL}/signup?plan=pro`,
    },
    {
      '@type': 'Offer',
      name: 'Growth',
      description:
        'For engineering teams. $99/mo includes 3 seats; each additional seat is $19/mo.',
      price: '99.00',
      priceCurrency: 'USD',
      priceSpecification: {
        '@type': 'UnitPriceSpecification',
        price: '99.00',
        priceCurrency: 'USD',
        unitText: 'MONTH',
        description: 'Base price covers 3 seats. Additional seats are $19/seat/month.',
      },
      availability: 'https://schema.org/InStock',
      url: `${APP_URL}/signup?plan=growth`,
    },
  ],
};

export default function PricingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      {/* Schema.org Product JSON-LD */}
      <Script
        id="pricing-structured-data"
        type="application/ld+json"
        // WHY dangerouslySetInnerHTML: Next.js Script requires this for
        // inline JSON-LD. The content is static server-rendered data, not
        // user input — safe here.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
      />
      {children}
    </>
  );
}
