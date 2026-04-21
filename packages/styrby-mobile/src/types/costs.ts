/**
 * Costs screen type definitions.
 *
 * WHY: Per CLAUDE.md "Component-First Architecture", shared prop types
 * for the costs sub-components live here so they aren't redeclared inline
 * across multiple files. Keeps each sub-component focused on rendering.
 */

import type { SubscriptionTier } from 'styrby-shared';
import type { BudgetAlert } from '../hooks/useBudgetAlerts';
import type { CostTimeRange, ModelCostBreakdown, TagCostBreakdown } from '../hooks/useCosts';
import type { MemberCostRow } from '../hooks/useTeamCosts';

/**
 * Props for the BudgetAlertsSummary sub-component.
 */
export interface BudgetAlertsSummaryProps {
  /** All budget alerts for the current user */
  alerts: BudgetAlert[];
  /** User's subscription tier */
  tier: SubscriptionTier;
  /** Whether alerts data is still loading */
  isLoading: boolean;
  /** Callback when the section is pressed (navigate to budget-alerts screen) */
  onPress: () => void;
}

/**
 * Props for the TimeRangeSelector segmented control.
 */
export interface TimeRangeSelectorProps {
  /** Currently selected time range */
  selected: CostTimeRange;
  /** Callback when a new range is selected */
  onSelect: (range: CostTimeRange) => void;
}

/**
 * Props for the cost-screen connection status badge.
 */
export interface CostConnectionStatusProps {
  /** Whether the realtime subscription is active */
  isConnected: boolean;
}

/**
 * Props for the CollapsibleSection wrapper.
 */
export interface CollapsibleSectionProps {
  /** Section header text */
  title: string;
  /** Whether the section is currently expanded */
  isExpanded: boolean;
  /** Callback to toggle expanded state */
  onToggle: () => void;
  /** Content to show when expanded */
  children: React.ReactNode;
}

/**
 * Props for a single ModelCostRow inside the COST BY MODEL breakdown.
 */
export interface ModelCostRowProps {
  /** Model cost breakdown data */
  item: ModelCostBreakdown;
}

/**
 * Props for a single TagCostRow inside the COST BY TAG breakdown.
 */
export interface TagCostRowProps {
  /** Tag cost breakdown data */
  item: TagCostBreakdown;
}

/**
 * Props for the TeamCostSection (Power tier + team required).
 */
export interface TeamCostSectionProps {
  /** Per-member cost rows sorted by spend descending */
  memberCosts: MemberCostRow[];
  /** Combined team total in USD */
  teamTotal: number;
  /** Whether data is still loading */
  isLoading: boolean;
  /** Error message (null if no error) */
  error: string | null;
  /** Whether the current user is on Power tier and in a team */
  isEligible: boolean;
  /** User's subscription tier for gate messaging */
  userTier: SubscriptionTier;
}

/**
 * Props for the ExportButton in the costs header.
 */
export interface ExportButtonProps {
  /** User's subscription tier — only 'power' enables export */
  tier: SubscriptionTier;
  /** Whether an export is currently in flight */
  isExporting: boolean;
  /** Press handler — open the format picker */
  onPress: () => void;
}
