/**
 * Pricing components barrel export.
 *
 * All pricing page sub-components exported from a single entry point
 * so the page file stays clean and imports are stable across refactors.
 *
 * @module components/pricing
 */

export { SoloTierCard } from './SoloTierCard';
export { TeamTierCard } from './TeamTierCard';
export { BusinessTierCard } from './BusinessTierCard';
export { EnterpriseTierCard } from './EnterpriseTierCard';
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
