/**
 * Cost Summary Card Component
 *
 * Displays a single cost metric in a styled card format for the cost dashboard.
 * Used to show key metrics like "Today's Spend", "This Week", "This Month".
 *
 * @module components/costs/CostSummaryCard
 */

import { formatCost, formatTokens, type CostSummary } from '@/lib/costs';

/**
 * Props for CostSummaryCard component.
 */
interface CostSummaryCardProps {
  /** Title for the card (e.g., "Today", "This Week") */
  title: string;
  /** Cost summary data to display */
  summary: CostSummary;
  /** Whether to highlight this card (uses orange accent color) */
  highlight?: boolean;
  /** Optional icon component to display next to the title */
  icon?: React.ReactNode;
}

/**
 * Displays a cost summary metric in a styled card.
 *
 * Shows:
 * - Title (time period)
 * - Total cost in USD (large, prominent)
 * - Total token count
 * - Request count (if > 0)
 *
 * @param props - Component props
 * @returns Cost summary card element
 *
 * @example
 * // Basic usage
 * <CostSummaryCard
 *   title="Today"
 *   summary={todayCosts}
 * />
 *
 * @example
 * // Highlighted with icon
 * <CostSummaryCard
 *   title="This Month"
 *   summary={monthlyCosts}
 *   highlight={true}
 *   icon={<CalendarIcon />}
 * />
 */
export function CostSummaryCard({
  title,
  summary,
  highlight = false,
  icon,
}: CostSummaryCardProps) {
  const totalTokens = summary.inputTokens + summary.outputTokens;

  return (
    <div
      className={`rounded-xl border p-4 transition-colors ${
        highlight
          ? 'bg-orange-500/10 border-orange-500/30'
          : 'bg-zinc-900 border-zinc-800'
      }`}
    >
      <div className="flex items-center gap-2">
        {icon && <span className="text-zinc-500">{icon}</span>}
        <p className="text-sm text-zinc-500">{title}</p>
      </div>

      <p
        className={`text-2xl font-bold mt-1 ${
          highlight ? 'text-orange-400' : 'text-zinc-100'
        }`}
      >
        {formatCost(summary.totalCost)}
      </p>

      <div className="flex items-center gap-2 mt-1">
        <p className="text-xs text-zinc-600">{formatTokens(totalTokens)} tokens</p>
        {summary.requestCount > 0 && (
          <>
            <span className="text-zinc-700">|</span>
            <p className="text-xs text-zinc-600">
              {summary.requestCount.toLocaleString()} requests
            </p>
          </>
        )}
      </div>
    </div>
  );
}
