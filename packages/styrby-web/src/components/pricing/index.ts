/**
 * Pricing components barrel export.
 *
 * All pricing page sub-components exported from a single entry point so the
 * page file stays clean and imports are stable across refactors.
 *
 * Phase 6 update: legacy `SoloTierCard` / `TeamTierCard` / `BusinessTierCard`
 * / `EnterpriseTierCard` are replaced by `ProTierCard` + `GrowthTierCard`
 * (see `.audit/styrby-fulltest.md` Decisions #1 / #2).
 *
 * @module components/pricing
 */

export { ProTierCard } from './ProTierCard';
export { GrowthTierCard } from './GrowthTierCard';
export { SeatCountSlider } from './SeatCountSlider';
export { ROICalculator, computeAnnualROI } from './ROICalculator';
export { ComparisonTable } from './ComparisonTable';
export { comparisonCategories, faqs } from './pricing-data';
export {
  PricingPageTracker,
  trackPricingEvent,
  PRICING_AB_FLAG,
  type PricingVariant,
} from './PricingPageTracker';
