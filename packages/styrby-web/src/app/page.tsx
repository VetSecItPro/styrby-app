import { Navbar } from '@/components/landing/navbar';
import { Hero } from '@/components/landing/hero';
import { SocialProof } from '@/components/landing/social-proof';
import { ProblemSection } from '@/components/landing/problem-section';
import { FeaturesSection } from '@/components/landing/features-section';
import { HowItWorks } from '@/components/landing/how-it-works';
import { CostSavings } from '@/components/landing/cost-savings';
import { PricingCTA } from '@/components/landing/pricing-cta';
import { CTABanner } from '@/components/landing/cta-banner';
import { Footer } from '@/components/landing/footer';

/**
 * Marketing landing page - composed from modular v0 section components.
 *
 * WHY composable sections: Each section (hero, features, pricing, etc.) is
 * independently maintained in components/landing/. This avoids the previous
 * 500+ line monolithic page and makes A/B testing individual sections trivial.
 */
export default function LandingPage() {
  return (
    <main className="min-h-screen">
      <Navbar />
      <Hero />
      <SocialProof />
      <ProblemSection />
      <FeaturesSection />
      <HowItWorks />
      <CostSavings />
      <PricingCTA />
      <CTABanner />
      <Footer />
    </main>
  );
}
