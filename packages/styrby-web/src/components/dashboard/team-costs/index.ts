/**
 * Team cost dashboard components barrel export.
 *
 * WHY: Per CLAUDE.md component-first architecture, every component directory
 * exposes a barrel so the page orchestrator imports a flat surface area.
 *
 * @module components/dashboard/team-costs
 */

export { TeamMemberCostTable } from './TeamMemberCostTable';
export type { TeamMemberCostTableProps, MemberCostRow } from './TeamMemberCostTable';

export { TeamAgentStackedBarDynamic } from './TeamAgentStackedBarDynamic';

export { TeamBudgetProjection } from './TeamBudgetProjection';
export type { TeamBudgetProjectionProps, TeamProjectionData } from './TeamBudgetProjection';

// WHY no direct export of TeamAgentStackedBar: consumers must use the dynamic
// wrapper to avoid pulling Recharts into the initial bundle.
