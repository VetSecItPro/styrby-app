import type { Metadata } from 'next';

/**
 * Layout for the /pricing page.
 *
 * WHY: The pricing page is a client component (uses useState for billing toggle
 * and plan comparison). Metadata cannot be exported from client components in
 * Next.js, so it lives here in a server-rendered layout wrapper instead.
 */
export const metadata: Metadata = {
  title: 'Pricing',
  description:
    'Styrby plans: Free, Pro at $19/mo, Power at $49/mo. Compare features and pick the plan that fits your workflow.',
  openGraph: {
    title: 'Styrby Pricing',
    description:
      'Styrby plans: Free, Pro at $19/mo, Power at $49/mo. Compare features and pick the plan that fits your workflow.',
    type: 'website',
    url: 'https://styrbyapp.com/pricing',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Styrby Pricing',
    description:
      'Styrby plans: Free, Pro at $19/mo, Power at $49/mo. Compare features and pick the plan that fits your workflow.',
  },
};

export default function PricingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
