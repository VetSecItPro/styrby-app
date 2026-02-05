/**
 * Budget Alerts Summary Widget
 *
 * Compact summary component displayed on the main costs page. Shows the most
 * critical budget alert (highest percentage used) as a mini card, with a link
 * to manage all alerts.
 *
 * WHY this is a server component: It only renders static data passed as props
 * from the costs page. No interactivity needed here -- the full management
 * UI is on the dedicated budget alerts page.
 */

import Link from 'next/link';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Data for the most critical (highest % used) budget alert */
interface CriticalAlert {
  /** Human-readable alert name */
  name: string;
  /** Spending threshold in USD */
  threshold_usd: number;
  /** Current spend in the alert's period */
  current_spend_usd: number;
  /** Percentage of threshold used (can exceed 100) */
  percentage_used: number;
  /** Alert period (daily, weekly, monthly) */
  period: string;
  /** Action taken when threshold is reached */
  action: string;
  /** Agent filter, null means all agents */
  agent_type: string | null;
}

interface BudgetAlertsSummaryProps {
  /** The alert with the highest percentage used, or null if no alerts */
  mostCriticalAlert: CriticalAlert | null;
  /** Total number of enabled budget alerts */
  alertCount: number;
  /** User's subscription tier */
  tier: string;
  /** Maximum alerts allowed by the user's tier */
  alertLimit: number;
}

// ---------------------------------------------------------------------------
// Helper Functions
// ---------------------------------------------------------------------------

/**
 * Returns the Tailwind CSS background color for a progress bar based on usage.
 *
 * @param percentage - Usage percentage (0-100+)
 * @returns Tailwind background color class
 */
function getProgressColor(percentage: number): string {
  if (percentage >= 100) return 'bg-red-500';
  if (percentage >= 80) return 'bg-orange-500';
  if (percentage >= 50) return 'bg-yellow-500';
  return 'bg-green-500';
}

/**
 * Returns human-readable action label.
 *
 * @param action - The raw action string from the database
 * @returns Formatted label
 */
function getActionLabel(action: string): string {
  switch (action) {
    case 'notify':
      return 'Notify';
    case 'warn_and_slowdown':
      return 'Slowdown';
    case 'hard_stop':
      return 'Hard Stop';
    default:
      return action;
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Renders a compact budget alerts summary for the costs page.
 *
 * Display logic:
 * - Has alerts: Shows the most critical alert with a progress bar
 * - No alerts, paid tier: Shows a "Set up budget alerts" prompt
 * - Free tier: Shows an "Upgrade to Pro" prompt
 *
 * @param mostCriticalAlert - The alert with the highest usage, or null
 * @param alertCount - Number of enabled alerts
 * @param tier - User's subscription tier
 * @param alertLimit - Max alerts for the tier
 */
export function BudgetAlertsSummary({
  mostCriticalAlert,
  alertCount,
  tier: _tier,
  alertLimit,
}: BudgetAlertsSummaryProps) {
  // Free tier: prompt to upgrade
  if (alertLimit === 0) {
    return (
      <section className="mb-8">
        <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-orange-500/10 flex items-center justify-center flex-shrink-0">
                <svg
                  className="h-5 w-5 text-orange-400"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
                  />
                </svg>
              </div>
              <div>
                <p className="text-sm font-medium text-zinc-100">Budget Alerts</p>
                <p className="text-xs text-zinc-500">
                  Upgrade to Pro to set spending thresholds and get notified
                </p>
              </div>
            </div>
            <Link
              href="/pricing"
              className="rounded-lg bg-orange-500 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-600 transition-colors flex-shrink-0"
            >
              Upgrade to Pro
            </Link>
          </div>
        </div>
      </section>
    );
  }

  // Paid tier but no alerts: prompt to set up
  if (alertCount === 0) {
    return (
      <section className="mb-8">
        <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-zinc-800 flex items-center justify-center flex-shrink-0">
                <svg
                  className="h-5 w-5 text-zinc-500"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
                  />
                </svg>
              </div>
              <div>
                <p className="text-sm font-medium text-zinc-100">No budget alerts set</p>
                <p className="text-xs text-zinc-500">
                  Create alerts to get notified when spending reaches your thresholds
                </p>
              </div>
            </div>
            <Link
              href="/costs/budget-alerts"
              className="rounded-lg border border-orange-500/50 px-4 py-2 text-sm font-medium text-orange-400 hover:bg-orange-500/10 transition-colors flex-shrink-0 flex items-center gap-1.5"
            >
              Set up budget alerts
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </Link>
          </div>
        </div>
      </section>
    );
  }

  // Has alerts: show the most critical one
  if (!mostCriticalAlert) return null;

  const progressColor = getProgressColor(mostCriticalAlert.percentage_used);
  const isOverBudget = mostCriticalAlert.percentage_used >= 100;

  return (
    <section className="mb-8">
      <div
        className={`rounded-xl bg-zinc-900 border p-4 ${
          isOverBudget ? 'border-red-500/50' : 'border-zinc-800'
        }`}
      >
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3">
            <div
              className={`h-10 w-10 rounded-lg flex items-center justify-center flex-shrink-0 ${
                isOverBudget ? 'bg-red-500/10' : 'bg-zinc-800'
              }`}
            >
              <svg
                className={`h-5 w-5 ${isOverBudget ? 'text-red-400' : 'text-zinc-400'}`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
                />
              </svg>
            </div>
            <div>
              <div className="flex items-center gap-2">
                <p className="text-sm font-medium text-zinc-100">
                  {mostCriticalAlert.name}
                </p>
                <span className="inline-flex items-center rounded-full bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400">
                  {mostCriticalAlert.period}
                </span>
                {mostCriticalAlert.agent_type && (
                  <span className="inline-flex items-center rounded-full bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400 capitalize">
                    {mostCriticalAlert.agent_type}
                  </span>
                )}
                <span className="inline-flex items-center rounded-full bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400">
                  {getActionLabel(mostCriticalAlert.action)}
                </span>
              </div>
              <div className="flex items-baseline gap-2 mt-0.5">
                <span className="text-sm text-zinc-300">
                  ${mostCriticalAlert.current_spend_usd.toFixed(2)}
                  <span className="text-zinc-500">
                    {' '}/ ${mostCriticalAlert.threshold_usd.toFixed(2)}
                  </span>
                </span>
                <span
                  className={`text-xs font-medium ${
                    isOverBudget ? 'text-red-400' : 'text-zinc-500'
                  }`}
                >
                  ({mostCriticalAlert.percentage_used.toFixed(0)}%)
                </span>
              </div>
            </div>
          </div>
          <Link
            href="/costs/budget-alerts"
            className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm font-medium text-zinc-400 hover:text-zinc-200 hover:border-zinc-600 transition-colors flex-shrink-0 flex items-center gap-1.5"
          >
            Manage Alerts
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </Link>
        </div>

        {/* Progress bar */}
        <div className="h-2 rounded-full bg-zinc-800 overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-500 ${progressColor}`}
            style={{ width: `${Math.min(mostCriticalAlert.percentage_used, 100)}%` }}
          />
        </div>

        {/* Alert count indicator */}
        {alertCount > 1 && (
          <p className="text-xs text-zinc-600 mt-2">
            Showing most critical of {alertCount} active alert{alertCount !== 1 ? 's' : ''}
          </p>
        )}
      </div>
    </section>
  );
}
