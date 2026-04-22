/**
 * Costs screen — barrel exports.
 *
 * WHY: Per CLAUDE.md "Component-First Architecture", every component
 * directory exposes a single barrel so the orchestrator imports a flat
 * surface area instead of reaching into individual files. Internal helpers
 * (e.g. pricing.ts formatters used only by sub-components) are not
 * re-exported here — leaking them would tempt the orchestrator to bypass
 * the sub-components.
 */

export { BudgetAlertsSummary } from './BudgetAlertsSummary';
export { CollapsibleSection } from './CollapsibleSection';
export { CostConnectionStatus } from './CostConnectionStatus';
export { ExportButton } from './ExportButton';
export { ModelCostRow } from './ModelCostRow';
export { ModelPricingRow } from './ModelPricingRow';
export { TagCostRow } from './TagCostRow';
export { TeamCostSection } from './TeamCostSection';
export { TimeRangeSelector } from './TimeRangeSelector';
export { BillingModelChip, SourceBadge, BILLING_MODEL_LABEL } from './BillingModelChip';
export type { BillingModelChipProps, SourceBadgeProps } from './BillingModelChip';
export { CostPill, formatPillCost } from './CostPill';
export type { CostPillProps } from './CostPill';
export { BillingModelSummaryStrip } from './BillingModelSummaryStrip';
export { useBillingBreakdown } from './useBillingBreakdown';
export type { BillingBreakdown } from './useBillingBreakdown';

// Phase 1.6.7 — cost dashboard additions
export { RunRateProjection } from './RunRateProjection';
export type { RunRateProjectionProps } from './RunRateProjection';
export { TierCapWarning } from './TierCapWarning';
export type { TierCapWarningProps } from './TierCapWarning';
