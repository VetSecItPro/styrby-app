/**
 * Barrel exports for the Budget Alerts feature sub-components.
 *
 * WHY narrow surface: Only the symbols the orchestrator imports are
 * re-exported here. Helpers, OptionPill, and AGENT_COLORS stay
 * intentionally absent so callers cannot reach into internals from
 * outside the feature folder.
 */

export { AlertsHeader } from './AlertsHeader';
export { EmptyState } from './EmptyState';
export { AlertCard } from './AlertCard';
export { AlertModal } from './AlertModal';
export type { BudgetAlertWithSpend, AlertFormData } from './types';
