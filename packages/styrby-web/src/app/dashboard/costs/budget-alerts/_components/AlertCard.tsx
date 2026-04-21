'use client';

/**
 * AlertCard — single budget alert tile in the grid.
 *
 * Renders the name, period/agent badges, enable toggle, spend progress
 * bar, action badge, and edit/delete controls for one alert.
 *
 * WHY split out: Each card is a self-contained presentation unit.
 * Extracting it lets the orchestrator's render loop stay short and
 * makes future per-card features (drag-to-reorder, bulk select) easy
 * to add without touching the parent.
 */

import {
  ACTION_DESCRIPTIONS,
  AGENT_COLORS,
  getActionBadgeColor,
  getPercentageTextColor,
  getPeriodBadgeColor,
  getProgressColor,
} from './helpers';
import type { BudgetAlertWithSpend } from './types';

interface AlertCardProps {
  /** The alert to render. */
  alert: BudgetAlertWithSpend;
  /** True while a delete request for this alert is in flight. */
  isDeleting: boolean;
  /** True while a toggle request for this alert is in flight. */
  isToggling: boolean;
  /** Toggles the alert's enabled state. */
  onToggle: (alert: BudgetAlertWithSpend) => void;
  /** Opens the edit modal for this alert. */
  onEdit: (alert: BudgetAlertWithSpend) => void;
  /** Deletes this alert (after user confirmation). */
  onDelete: (alertId: string) => void;
}

/**
 * Renders a single budget alert card with progress, badges, and controls.
 *
 * @param props - See {@link AlertCardProps}.
 */
export function AlertCard({
  alert,
  isDeleting,
  isToggling,
  onToggle,
  onEdit,
  onDelete,
}: AlertCardProps) {
  const progressColor = getProgressColor(alert.percentage_used);
  const percentTextColor = getPercentageTextColor(alert.percentage_used);
  const actionBadge = getActionBadgeColor(alert.action);
  const periodBadge = getPeriodBadgeColor(alert.period);

  return (
    <div
      className={`rounded-xl bg-zinc-900 border border-zinc-800 p-4 transition-opacity ${
        !alert.is_enabled ? 'opacity-60' : ''
      } ${isDeleting ? 'opacity-30 pointer-events-none' : ''}`}
    >
      {/* Header row: name, period badge, toggle */}
      <div className="flex items-start justify-between mb-3">
        <div className="flex-1 min-w-0 mr-3">
          <h3 className="text-sm font-semibold text-zinc-100 truncate">
            {alert.name}
          </h3>
          <div className="flex items-center gap-2 mt-1">
            <span
              className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${periodBadge.bg} ${periodBadge.text}`}
            >
              {alert.period}
            </span>
            {alert.agent_type && (
              <span
                className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${AGENT_COLORS[alert.agent_type].bg} ${AGENT_COLORS[alert.agent_type].text}`}
              >
                {alert.agent_type}
              </span>
            )}
          </div>
        </div>
        <label className="relative inline-flex cursor-pointer items-center flex-shrink-0">
          <input
            type="checkbox"
            className="peer sr-only"
            checked={alert.is_enabled}
            onChange={() => onToggle(alert)}
            disabled={isToggling}
            aria-label={`${alert.is_enabled ? 'Disable' : 'Enable'} ${alert.name} alert`}
          />
          <div className="h-5 w-9 rounded-full bg-zinc-700 after:absolute after:left-[2px] after:top-[2px] after:h-4 after:w-4 after:rounded-full after:bg-white after:transition-all peer-checked:bg-orange-500 peer-checked:after:translate-x-full" />
        </label>
      </div>

      {/* Progress bar */}
      <div className="mb-3">
        <div className="flex items-baseline justify-between mb-1">
          <span className="text-sm text-zinc-300">
            ${alert.current_spend_usd.toFixed(2)}{' '}
            <span className="text-zinc-500">
              / ${Number(alert.threshold_usd).toFixed(2)}
            </span>
          </span>
          <span className={`text-xs font-medium ${percentTextColor}`}>
            {alert.percentage_used.toFixed(0)}%
          </span>
        </div>
        <div
          className="h-2 rounded-full bg-zinc-800 overflow-hidden"
          role="progressbar"
          aria-valuenow={Math.min(Math.round(alert.percentage_used), 100)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`Budget usage: ${alert.percentage_used.toFixed(0)}% of $${alert.threshold_usd}`}
        >
          <div
            className={`h-full rounded-full transition-all duration-500 ${progressColor}`}
            style={{ width: `${Math.min(alert.percentage_used, 100)}%` }}
          />
        </div>
      </div>

      {/* Action badge + edit/delete buttons */}
      <div className="flex items-center justify-between">
        <span
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${actionBadge.bg} ${actionBadge.text}`}
        >
          <svg
            className="h-3 w-3"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d={ACTION_DESCRIPTIONS[alert.action].icon}
            />
          </svg>
          {ACTION_DESCRIPTIONS[alert.action].label}
        </span>

        <div className="flex items-center gap-1">
          <button
            onClick={() => onEdit(alert)}
            className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
            aria-label={`Edit ${alert.name} alert`}
          >
            <svg
              className="h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
              />
            </svg>
          </button>
          <button
            onClick={() => onDelete(alert.id)}
            className="p-1.5 rounded-lg text-zinc-500 hover:text-red-400 hover:bg-red-500/10 transition-colors"
            disabled={isDeleting}
            aria-label={`Delete ${alert.name} alert`}
          >
            <svg
              className="h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
              />
            </svg>
          </button>
        </div>
      </div>

      {/* Last triggered */}
      {alert.last_triggered_at && (
        <p className="text-xs text-zinc-500 mt-2">
          Last triggered:{' '}
          {new Date(alert.last_triggered_at).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
          })}
        </p>
      )}
    </div>
  );
}
