'use client';

/**
 * Budget Alerts Client Component
 *
 * Interactive UI for managing budget alerts. Displays alert cards in a grid
 * with progress bars, action badges, and controls for creating, editing,
 * enabling/disabling, and deleting alerts.
 *
 * WHY this is a client component: It requires interactive state management
 * for the create/edit modal, toggle switches, and optimistic UI updates
 * when toggling or deleting alerts.
 */

import { useState, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Valid agent types matching the Postgres enum */
type AgentType = 'claude' | 'codex' | 'gemini';

/** Valid alert periods matching the database CHECK constraint */
type AlertPeriod = 'daily' | 'weekly' | 'monthly';

/** Valid alert actions matching the database CHECK constraint */
type AlertAction = 'notify' | 'warn_and_slowdown' | 'hard_stop';

/** Valid notification channels */
type NotificationChannel = 'push' | 'in_app' | 'email';

/**
 * Budget alert from the database, enriched with computed spend data.
 * The server calculates current_spend_usd and percentage_used by querying
 * the cost_records table for the alert's period and agent scope.
 */
interface BudgetAlertWithSpend {
  id: string;
  user_id: string;
  name: string;
  threshold_usd: number;
  period: AlertPeriod;
  agent_type: AgentType | null;
  action: AlertAction;
  notification_channels: NotificationChannel[];
  is_enabled: boolean;
  last_triggered_at: string | null;
  created_at: string;
  updated_at: string;
  current_spend_usd: number;
  percentage_used: number;
}

/** Props passed from the server component page */
interface BudgetAlertsClientProps {
  /** List of budget alerts with computed spend data */
  initialAlerts: BudgetAlertWithSpend[];
  /** The user's subscription tier */
  tier: string;
  /** Maximum number of alerts allowed by the user's tier */
  alertLimit: number;
  /** Current number of alerts the user has */
  alertCount: number;
}

/**
 * Form data for creating or editing a budget alert.
 * Matches the shape expected by the POST/PATCH API endpoints.
 */
interface AlertFormData {
  name: string;
  threshold_usd: number;
  period: AlertPeriod;
  agent_type: AgentType | null;
  action: AlertAction;
  notification_channels: NotificationChannel[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Human-readable descriptions for each alert action.
 * Shown in the create/edit form to help users understand consequences.
 */
const ACTION_DESCRIPTIONS: Record<AlertAction, { label: string; description: string; icon: string }> = {
  notify: {
    label: 'Notify Only',
    description: 'Send a notification when the threshold is reached',
    icon: 'M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9',
  },
  warn_and_slowdown: {
    label: 'Warn & Slowdown',
    description: 'Notify and throttle agent activity to reduce spending',
    icon: 'M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z',
  },
  hard_stop: {
    label: 'Hard Stop',
    description: 'Notify and immediately stop all agent usage',
    icon: 'M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636',
  },
};

/**
 * Color configuration for agent type badges.
 * Matches the color scheme used throughout the Styrby dashboard.
 */
const AGENT_COLORS: Record<AgentType, { bg: string; text: string }> = {
  claude: { bg: 'bg-orange-500/10', text: 'text-orange-400' },
  codex: { bg: 'bg-green-500/10', text: 'text-green-400' },
  gemini: { bg: 'bg-blue-500/10', text: 'text-blue-400' },
};

// ---------------------------------------------------------------------------
// Helper Functions
// ---------------------------------------------------------------------------

/**
 * Returns the Tailwind CSS color class for a progress bar based on usage percentage.
 *
 * WHY: Visual urgency helps users quickly identify alerts that need attention.
 * - Green (<50%): Safe, well within budget
 * - Yellow (50-80%): Approaching threshold, be aware
 * - Orange (80-100%): Close to threshold, take action soon
 * - Red (>100%): Over budget, immediate attention needed
 *
 * @param percentage - The percentage of the threshold used (0-100+)
 * @returns Tailwind CSS background color class
 */
function getProgressColor(percentage: number): string {
  if (percentage >= 100) return 'bg-red-500';
  if (percentage >= 80) return 'bg-orange-500';
  if (percentage >= 50) return 'bg-yellow-500';
  return 'bg-green-500';
}

/**
 * Returns the Tailwind CSS text color class for a usage percentage.
 *
 * @param percentage - The percentage of the threshold used (0-100+)
 * @returns Tailwind CSS text color class
 */
function getPercentageTextColor(percentage: number): string {
  if (percentage >= 100) return 'text-red-400';
  if (percentage >= 80) return 'text-orange-400';
  if (percentage >= 50) return 'text-yellow-400';
  return 'text-green-400';
}

/**
 * Returns the badge color classes for an alert action.
 *
 * @param action - The alert action type
 * @returns Object with bg and text Tailwind classes
 */
function getActionBadgeColor(action: AlertAction): { bg: string; text: string } {
  switch (action) {
    case 'notify':
      return { bg: 'bg-blue-500/10', text: 'text-blue-400' };
    case 'warn_and_slowdown':
      return { bg: 'bg-yellow-500/10', text: 'text-yellow-400' };
    case 'hard_stop':
      return { bg: 'bg-red-500/10', text: 'text-red-400' };
  }
}

/**
 * Returns the badge color classes for a period.
 *
 * @param period - The alert period
 * @returns Object with bg and text Tailwind classes
 */
function getPeriodBadgeColor(period: AlertPeriod): { bg: string; text: string } {
  switch (period) {
    case 'daily':
      return { bg: 'bg-purple-500/10', text: 'text-purple-400' };
    case 'weekly':
      return { bg: 'bg-cyan-500/10', text: 'text-cyan-400' };
    case 'monthly':
      return { bg: 'bg-indigo-500/10', text: 'text-indigo-400' };
  }
}

// ---------------------------------------------------------------------------
// Default Form Values
// ---------------------------------------------------------------------------

/** Default values for the alert creation form */
const DEFAULT_FORM_DATA: AlertFormData = {
  name: '',
  threshold_usd: 10,
  period: 'daily',
  agent_type: null,
  action: 'notify',
  notification_channels: ['push', 'in_app'],
};

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

/**
 * Budget alerts management interface.
 *
 * Renders a grid of alert cards with progress bars and controls,
 * plus a modal form for creating and editing alerts.
 *
 * @param initialAlerts - Pre-fetched alert data from the server component
 * @param tier - The user's subscription tier ID
 * @param alertLimit - Maximum alerts allowed for the user's tier
 * @param alertCount - Current number of alerts
 */
export function BudgetAlertsClient({
  initialAlerts,
  tier,
  alertLimit,
  alertCount: initialAlertCount,
}: BudgetAlertsClientProps) {
  const router = useRouter();
  const [alerts, setAlerts] = useState<BudgetAlertWithSpend[]>(initialAlerts);
  const [alertCount, setAlertCount] = useState(initialAlertCount);
  const [showModal, setShowModal] = useState(false);
  const [editingAlert, setEditingAlert] = useState<BudgetAlertWithSpend | null>(null);
  const [formData, setFormData] = useState<AlertFormData>(DEFAULT_FORM_DATA);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const canCreateAlert = alertCount < alertLimit;

  // -------------------------------------------------------------------------
  // Modal Handlers
  // -------------------------------------------------------------------------

  /**
   * Opens the create modal with default form values.
   */
  const handleOpenCreate = useCallback(() => {
    setEditingAlert(null);
    setFormData(DEFAULT_FORM_DATA);
    setError(null);
    setShowModal(true);
  }, []);

  /**
   * Opens the edit modal pre-populated with the alert's current values.
   *
   * @param alert - The alert to edit
   */
  const handleOpenEdit = useCallback((alert: BudgetAlertWithSpend) => {
    setEditingAlert(alert);
    setFormData({
      name: alert.name,
      threshold_usd: Number(alert.threshold_usd),
      period: alert.period,
      agent_type: alert.agent_type,
      action: alert.action,
      notification_channels: alert.notification_channels,
    });
    setError(null);
    setShowModal(true);
  }, []);

  /**
   * Closes the modal and resets form state.
   */
  const handleCloseModal = useCallback(() => {
    setShowModal(false);
    setEditingAlert(null);
    setFormData(DEFAULT_FORM_DATA);
    setError(null);
  }, []);

  // -------------------------------------------------------------------------
  // CRUD Operations
  // -------------------------------------------------------------------------

  /**
   * Submits the form to create or update a budget alert.
   * Calls the POST or PATCH endpoint and refreshes the page on success.
   */
  const handleSubmit = useCallback(async () => {
    setIsSubmitting(true);
    setError(null);

    try {
      const isEdit = editingAlert !== null;
      const response = await fetch('/api/budget-alerts', {
        method: isEdit ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          isEdit ? { id: editingAlert.id, ...formData } : formData
        ),
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.error || 'Something went wrong');
        return;
      }

      handleCloseModal();
      // WHY: Revalidate the server component data so the page shows fresh
      // spend calculations. Client-side state alone would show stale spend.
      router.refresh();

      // Optimistic update for immediate feedback
      if (isEdit) {
        setAlerts((prev) =>
          prev.map((a) => (a.id === editingAlert.id ? { ...a, ...data.alert } : a))
        );
      } else {
        setAlerts((prev) => [{ ...data.alert, current_spend_usd: 0, percentage_used: 0 }, ...prev]);
        setAlertCount((prev) => prev + 1);
      }
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  }, [editingAlert, formData, handleCloseModal, router]);

  /**
   * Toggles an alert's enabled/disabled state.
   * Uses optimistic update for instant UI feedback.
   *
   * @param alert - The alert to toggle
   */
  const handleToggle = useCallback(
    async (alert: BudgetAlertWithSpend) => {
      setTogglingId(alert.id);

      // Optimistic update
      setAlerts((prev) =>
        prev.map((a) =>
          a.id === alert.id ? { ...a, is_enabled: !a.is_enabled } : a
        )
      );

      try {
        const response = await fetch('/api/budget-alerts', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: alert.id, is_enabled: !alert.is_enabled }),
        });

        if (!response.ok) {
          // Revert optimistic update on failure
          setAlerts((prev) =>
            prev.map((a) =>
              a.id === alert.id ? { ...a, is_enabled: alert.is_enabled } : a
            )
          );
        }
      } catch {
        // Revert on network error
        setAlerts((prev) =>
          prev.map((a) =>
            a.id === alert.id ? { ...a, is_enabled: alert.is_enabled } : a
          )
        );
      } finally {
        setTogglingId(null);
      }
    },
    []
  );

  /**
   * Deletes a budget alert after confirmation.
   *
   * @param alertId - UUID of the alert to delete
   */
  const handleDelete = useCallback(
    async (alertId: string) => {
      if (!confirm('Are you sure you want to delete this budget alert?')) {
        return;
      }

      setDeletingId(alertId);

      try {
        const response = await fetch('/api/budget-alerts', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: alertId }),
        });

        if (response.ok) {
          setAlerts((prev) => prev.filter((a) => a.id !== alertId));
          setAlertCount((prev) => prev - 1);
          router.refresh();
        }
      } catch {
        // Silently fail - the alert remains visible so the user can retry
      } finally {
        setDeletingId(null);
      }
    },
    [router]
  );

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div>
      {/* Header with create button and tier indicator */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <p className="text-sm text-zinc-400">
            {alertCount} / {alertLimit} alerts used
            <span className="text-zinc-600 ml-2">({tier} plan)</span>
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/costs"
            className="rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-300 hover:bg-zinc-800 transition-colors"
          >
            Back to Costs
          </Link>
          {canCreateAlert ? (
            <button
              onClick={handleOpenCreate}
              className="rounded-lg bg-orange-500 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-600 transition-colors flex items-center gap-2"
              aria-label="Create a new budget alert"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              Create Alert
            </button>
          ) : alertLimit === 0 ? (
            <Link
              href="/pricing"
              className="rounded-lg bg-orange-500 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-600 transition-colors"
            >
              Upgrade to Pro
            </Link>
          ) : (
            <Link
              href="/pricing"
              className="rounded-lg border border-orange-500/50 px-4 py-2 text-sm font-medium text-orange-400 hover:bg-orange-500/10 transition-colors"
            >
              Upgrade for More
            </Link>
          )}
        </div>
      </div>

      {/* Empty State */}
      {alerts.length === 0 && (
        <div className="rounded-xl bg-zinc-900 border border-zinc-800 px-4 py-16 text-center">
          <div className="mx-auto h-16 w-16 rounded-full bg-zinc-800 flex items-center justify-center mb-4">
            <svg
              className="h-8 w-8 text-zinc-500"
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
          <h3 className="text-lg font-medium text-zinc-100 mb-2">No budget alerts</h3>
          {alertLimit > 0 ? (
            <>
              <p className="text-zinc-500 mb-6 max-w-sm mx-auto">
                Set up budget alerts to get notified when your AI spending
                reaches your thresholds.
              </p>
              <button
                onClick={handleOpenCreate}
                className="rounded-lg bg-orange-500 px-6 py-2.5 text-sm font-semibold text-white hover:bg-orange-600 transition-colors"
                aria-label="Create your first budget alert"
              >
                Create Your First Alert
              </button>
            </>
          ) : (
            <>
              <p className="text-zinc-500 mb-6 max-w-sm mx-auto">
                Budget alerts help you control AI spending. Upgrade to Pro to
                create up to 3 budget alerts.
              </p>
              <Link
                href="/pricing"
                className="inline-block rounded-lg bg-orange-500 px-6 py-2.5 text-sm font-semibold text-white hover:bg-orange-600 transition-colors"
              >
                Upgrade to Pro
              </Link>
            </>
          )}
        </div>
      )}

      {/* Alert Cards Grid */}
      {alerts.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {alerts.map((alert) => {
            const progressColor = getProgressColor(alert.percentage_used);
            const percentTextColor = getPercentageTextColor(alert.percentage_used);
            const actionBadge = getActionBadgeColor(alert.action);
            const periodBadge = getPeriodBadgeColor(alert.period);
            const isDeleting = deletingId === alert.id;
            const isToggling = togglingId === alert.id;

            return (
              <div
                key={alert.id}
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
                      {/* Period badge */}
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${periodBadge.bg} ${periodBadge.text}`}
                      >
                        {alert.period}
                      </span>
                      {/* Agent filter badge */}
                      {alert.agent_type && (
                        <span
                          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${AGENT_COLORS[alert.agent_type].bg} ${AGENT_COLORS[alert.agent_type].text}`}
                        >
                          {alert.agent_type}
                        </span>
                      )}
                    </div>
                  </div>
                  {/* Toggle switch */}
                  <label className="relative inline-flex cursor-pointer items-center flex-shrink-0">
                    <input
                      type="checkbox"
                      className="peer sr-only"
                      checked={alert.is_enabled}
                      onChange={() => handleToggle(alert)}
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
                  <div className="h-2 rounded-full bg-zinc-800 overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-500 ${progressColor}`}
                      style={{ width: `${Math.min(alert.percentage_used, 100)}%` }}
                    />
                  </div>
                </div>

                {/* Action badge */}
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

                  {/* Edit / Delete buttons */}
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => handleOpenEdit(alert)}
                      className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
                      aria-label={`Edit ${alert.name} alert`}
                    >
                      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                        />
                      </svg>
                    </button>
                    <button
                      onClick={() => handleDelete(alert.id)}
                      className="p-1.5 rounded-lg text-zinc-500 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                      disabled={isDeleting}
                      aria-label={`Delete ${alert.name} alert`}
                    >
                      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
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
                  <p className="text-xs text-zinc-600 mt-2">
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
          })}
        </div>
      )}

      {/* Create/Edit Modal */}
      {showModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-label={editingAlert ? 'Edit budget alert' : 'Create budget alert'}
        >
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={handleCloseModal}
            aria-hidden="true"
          />

          {/* Modal content */}
          <div className="relative w-full max-w-lg rounded-xl bg-zinc-900 border border-zinc-800 p-6 shadow-xl">
            <h2 className="text-lg font-semibold text-zinc-100 mb-6">
              {editingAlert ? 'Edit Budget Alert' : 'Create Budget Alert'}
            </h2>

            {/* Error message */}
            {error && (
              <div className="mb-4 rounded-lg bg-red-500/10 border border-red-500/30 px-4 py-3">
                <p className="text-sm text-red-400">{error}</p>
              </div>
            )}

            {/* Form fields */}
            <div className="space-y-5">
              {/* Name */}
              <div>
                <label
                  htmlFor="alert-name"
                  className="block text-sm font-medium text-zinc-300 mb-1.5"
                >
                  Alert Name
                </label>
                <input
                  id="alert-name"
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  placeholder="e.g., Daily Claude limit"
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500"
                  maxLength={100}
                />
              </div>

              {/* Threshold */}
              <div>
                <label
                  htmlFor="alert-threshold"
                  className="block text-sm font-medium text-zinc-300 mb-1.5"
                >
                  Threshold Amount
                </label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-zinc-500">
                    $
                  </span>
                  <input
                    id="alert-threshold"
                    type="number"
                    value={formData.threshold_usd}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        threshold_usd: parseFloat(e.target.value) || 0,
                      })
                    }
                    min={0.01}
                    step={0.01}
                    className="w-full rounded-lg border border-zinc-700 bg-zinc-800 pl-7 pr-3 py-2 text-sm text-zinc-100 focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500"
                  />
                </div>
              </div>

              {/* Period selector */}
              <div>
                <label className="block text-sm font-medium text-zinc-300 mb-1.5">
                  Period
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {(['daily', 'weekly', 'monthly'] as AlertPeriod[]).map(
                    (period) => (
                      <button
                        key={period}
                        type="button"
                        onClick={() => setFormData({ ...formData, period })}
                        className={`rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                          formData.period === period
                            ? 'bg-orange-500 text-white'
                            : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 border border-zinc-700'
                        }`}
                        aria-pressed={formData.period === period}
                      >
                        {period.charAt(0).toUpperCase() + period.slice(1)}
                      </button>
                    )
                  )}
                </div>
              </div>

              {/* Agent filter */}
              <div>
                <label className="block text-sm font-medium text-zinc-300 mb-1.5">
                  Agent Filter
                  <span className="text-zinc-500 font-normal ml-1">(optional)</span>
                </label>
                <div className="grid grid-cols-4 gap-2">
                  <button
                    type="button"
                    onClick={() => setFormData({ ...formData, agent_type: null })}
                    className={`rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                      formData.agent_type === null
                        ? 'bg-orange-500 text-white'
                        : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 border border-zinc-700'
                    }`}
                    aria-pressed={formData.agent_type === null}
                  >
                    All
                  </button>
                  {(['claude', 'codex', 'gemini'] as AgentType[]).map((agent) => (
                    <button
                      key={agent}
                      type="button"
                      onClick={() => setFormData({ ...formData, agent_type: agent })}
                      className={`rounded-lg px-3 py-2 text-sm font-medium capitalize transition-colors ${
                        formData.agent_type === agent
                          ? 'bg-orange-500 text-white'
                          : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 border border-zinc-700'
                      }`}
                      aria-pressed={formData.agent_type === agent}
                    >
                      {agent}
                    </button>
                  ))}
                </div>
              </div>

              {/* Action selector */}
              <div>
                <label className="block text-sm font-medium text-zinc-300 mb-1.5">
                  Action When Triggered
                </label>
                <div className="space-y-2">
                  {(
                    ['notify', 'warn_and_slowdown', 'hard_stop'] as AlertAction[]
                  ).map((action) => {
                    const info = ACTION_DESCRIPTIONS[action];
                    const isSelected = formData.action === action;
                    return (
                      <button
                        key={action}
                        type="button"
                        onClick={() => setFormData({ ...formData, action })}
                        className={`w-full rounded-lg px-4 py-3 text-left transition-colors ${
                          isSelected
                            ? 'bg-orange-500/10 border-orange-500/50 border'
                            : 'bg-zinc-800 border border-zinc-700 hover:bg-zinc-700'
                        }`}
                        aria-pressed={isSelected}
                      >
                        <div className="flex items-center gap-3">
                          <svg
                            className={`h-5 w-5 flex-shrink-0 ${
                              isSelected ? 'text-orange-400' : 'text-zinc-500'
                            }`}
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            aria-hidden="true"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d={info.icon}
                            />
                          </svg>
                          <div>
                            <p
                              className={`text-sm font-medium ${
                                isSelected ? 'text-orange-300' : 'text-zinc-300'
                              }`}
                            >
                              {info.label}
                            </p>
                            <p className="text-xs text-zinc-500">{info.description}</p>
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Modal actions */}
            <div className="flex items-center justify-end gap-3 mt-6 pt-4 border-t border-zinc-800">
              <button
                onClick={handleCloseModal}
                className="rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-300 hover:bg-zinc-800 transition-colors"
                disabled={isSubmitting}
              >
                Cancel
              </button>
              <button
                onClick={handleSubmit}
                disabled={isSubmitting || !formData.name.trim() || formData.threshold_usd <= 0}
                className="rounded-lg bg-orange-500 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {isSubmitting && (
                  <div
                    className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white"
                    aria-hidden="true"
                  />
                )}
                {editingAlert ? 'Save Changes' : 'Create Alert'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
