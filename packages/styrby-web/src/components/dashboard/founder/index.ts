/**
 * Founder dashboard components barrel export.
 *
 * WHY: Per CLAUDE.md component-first architecture, every component directory
 * exposes a barrel so the page orchestrator imports a flat surface area.
 *
 * @module components/dashboard/founder
 */

export { MrrCard } from './MrrCard';
export type { MrrCardProps } from './MrrCard';

export { FunnelChart } from './FunnelChart';
export type { FunnelChartProps, FunnelStep } from './FunnelChart';

export { TierMixTable } from './TierMixTable';
export type { TierMixTableProps, TierCount, AgentUsage } from './TierMixTable';

export { CohortRetentionTable } from './CohortRetentionTable';
export type { CohortRetentionTableProps, CohortRow } from './CohortRetentionTable';

// Phase 2.3 — Teams card for the founder dashboard
export { TeamsCard } from './TeamsCard';
export type { TeamsCardProps } from './TeamsCard';

// Phase 2.5 (absorbs 1.6.7b) — Error class histogram for the founder dashboard
export { ErrorClassHistogramDynamic } from './ErrorClassHistogramDynamic';
export type { ErrorClassHistogramProps, ErrorHistogramDay } from './ErrorClassHistogram';
