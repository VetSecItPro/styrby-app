import type { Metadata } from 'next';
import Script from 'next/script';

/**
 * Layout for the /pricing page.
 *
 * WHY server layout (not client): Metadata and JSON-LD structured data must
 * live in a server component. The pricing page.tsx uses client-side state for
 * the billing toggle and seat slider, so metadata lives here instead.
 *
 * SEO: Schema.org Product markup helps search engines display pricing snippets
 * in results (Google Rich Results). Including all four tiers maximises coverage.
 *
 * WHY canonical URL: prevents duplicate content penalties if the page is
 * accessible from multiple paths (www vs non-www, trailing slash variants).
 */

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://styrbyapp.com';

export const metadata: Metadata = {
  title: 'Pricing - Solo, Team, Business and Enterprise Plans',
  description:
    'Styrby pricing: Solo at $49/mo, Team from $19/seat/mo (3-seat min), Business from $39/seat/mo (10-seat min), Enterprise custom. ' +
    'All 11 CLI coding agents. E2E encryption. Seat-count slider and ROI estimator on this page.',
  alternates: {
    canonical: `${APP_URL}/pricing`,
  },
  openGraph: {
    title: 'Styrby Pricing - Solo, Team, Business and Enterprise',
    description:
      'Compare all four Styrby plans. Solo at $49/mo for individual developers. ' +
      'Team from $19/seat/mo. Business from $39/seat/mo. Enterprise custom from $15K/year.',
    type: 'website',
    url: `${APP_URL}/pricing`,
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Styrby Pricing - Solo, Team, Business and Enterprise',
    description:
      'Compare all four Styrby plans. Solo at $49/mo. Team from $57/mo (3 seats). ' +
      'Business from $390/mo (10 seats). Enterprise custom.',
  },
};

/**
 * Schema.org Product structured data for the Styrby pricing page.
 *
 * WHY JSON-LD (not microdata): JSON-LD is Google's recommended format.
 * It does not pollute the HTML structure and is easier to maintain.
 *
 * WHY multiple offers: Google supports AggregateOffer and Offer arrays.
 * Listing all four tiers lets search engines display rich pricing results
 * and helps SEO for "styrby pricing" and "ai coding agent price" queries.
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
      name: 'Solo',
      description: 'For individual developers who ship daily with AI',
      price: '49.00',
      priceCurrency: 'USD',
      priceSpecification: {
        '@type': 'UnitPriceSpecification',
        price: '49.00',
        priceCurrency: 'USD',
        unitText: 'MONTH',
      },
      availability: 'https://schema.org/InStock',
      url: `${APP_URL}/signup?plan=power`,
    },
    {
      '@type': 'Offer',
      name: 'Team',
      description: 'For engineering teams of 3 to 100 developers',
      price: '19.00',
      priceCurrency: 'USD',
      priceSpecification: {
        '@type': 'UnitPriceSpecification',
        price: '19.00',
        priceCurrency: 'USD',
        unitText: 'MONTH',
        description: 'Per seat per month. Minimum 3 seats ($57/mo floor).',
      },
      availability: 'https://schema.org/InStock',
      url: `${APP_URL}/signup?plan=team`,
    },
    {
      '@type': 'Offer',
      name: 'Business',
      description: 'For larger engineering orgs with custom retention and priority support',
      price: '39.00',
      priceCurrency: 'USD',
      priceSpecification: {
        '@type': 'UnitPriceSpecification',
        price: '39.00',
        priceCurrency: 'USD',
        unitText: 'MONTH',
        description: 'Per seat per month. Minimum 10 seats ($390/mo floor).',
      },
      availability: 'https://schema.org/InStock',
      url: `${APP_URL}/signup?plan=business`,
    },
    {
      '@type': 'Offer',
      name: 'Enterprise',
      description: 'Custom contract, SSO, dedicated support. From $15K/year.',
      availability: 'https://schema.org/InStock',
      url: `${APP_URL}/pricing#enterprise`,
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
        // WHY dangerouslySetInnerHTML: Next.js Script requires this for inline JSON-LD.
        // The content is static server-rendered data, not user input - safe here.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
      />
      {children}
    </>
  );
}
