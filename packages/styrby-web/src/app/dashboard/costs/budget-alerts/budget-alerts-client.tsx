'use client';

/**
 * Budget Alerts Client Component (orchestrator).
 *
 * Owns state, server I/O, and top-level layout for the Budget Alerts
 * page. Delegates presentation to focused sub-components in
 * `./_components`:
 * - {@link AlertsHeader}: tier usage line + Create CTA
 * - {@link EmptyState}: zero-alerts onboarding
 * - {@link AlertCard}: a single alert tile in the grid
 * - {@link AlertModal}: create/edit form dialog
 *
 * WHY this is a client component: Modal state, optimistic toggle/delete
 * updates, and form interactions all require interactive React state.
 * The parent server component pre-fetches the alert list and pricing
 * tier so the first paint is data-complete.
 */

import { useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import {
  AlertCard,
  AlertModal,
  AlertsHeader,
  EmptyState,
  type AlertFormData,
  type BudgetAlertWithSpend,
} from './_components';

/** Props passed from the server component page. */
interface BudgetAlertsClientProps {
  /** List of budget alerts with computed spend data. */
  initialAlerts: BudgetAlertWithSpend[];
  /** The user's subscription tier (e.g. "Free", "Pro"). */
  tier: string;
  /** Maximum number of alerts allowed by the user's tier. */
  alertLimit: number;
  /** Current number of alerts the user has. */
  alertCount: number;
}

/**
 * Default values for the alert creation form.
 *
 * WHY these defaults: Daily/$10/notify/cost_usd is the safest "training wheels"
 * configuration — low impact (notify-only), short window (1 day), and
 * a small enough threshold that most users will see it trigger
 * organically and learn how alerts behave. alert_type defaults to 'cost_usd'
 * so existing users upgrading from pre-023 behavior are unaffected.
 */
const DEFAULT_FORM_DATA: AlertFormData = {
  name: '',
  threshold_usd: 10,
  period: 'daily',
  agent_type: null,
  action: 'notify',
  notification_channels: ['push', 'in_app'],
  alert_type: 'cost_usd',
  threshold_quota_fraction: null,
  threshold_credits: null,
};

/**
 * Budget alerts management interface.
 *
 * @param props - See {@link BudgetAlertsClientProps}.
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
  const [editingAlert, setEditingAlert] = useState<BudgetAlertWithSpend | null>(
    null
  );
  const [formData, setFormData] = useState<AlertFormData>(DEFAULT_FORM_DATA);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  // ---------------------------------------------------------------------
  // Modal Handlers
  // ---------------------------------------------------------------------

  /** Opens the create modal with default form values. */
  const handleOpenCreate = useCallback(() => {
    setEditingAlert(null);
    setFormData(DEFAULT_FORM_DATA);
    setError(null);
    setShowModal(true);
  }, []);

  /** Opens the edit modal pre-populated with the alert's current values. */
  const handleOpenEdit = useCallback((alert: BudgetAlertWithSpend) => {
    setEditingAlert(alert);
    setFormData({
      name: alert.name,
      threshold_usd: Number(alert.threshold_usd),
      period: alert.period,
      agent_type: alert.agent_type,
      action: alert.action,
      notification_channels: alert.notification_channels,
      alert_type: alert.alert_type ?? 'cost_usd',
      threshold_quota_fraction: alert.threshold_quota_fraction ?? null,
      threshold_credits: alert.threshold_credits ?? null,
    });
    setError(null);
    setShowModal(true);
  }, []);

  /** Closes the modal and resets form state. */
  const handleCloseModal = useCallback(() => {
    setShowModal(false);
    setEditingAlert(null);
    setFormData(DEFAULT_FORM_DATA);
    setError(null);
  }, []);

  // WHY: WCAG 2.1.2 requires focus to not be trapped unless the trap is
  // intentional (i.e., a modal dialog). The focus trap keeps keyboard
  // users inside the modal and restores focus to the trigger element
  // when the modal closes.
  const focusTrapRef = useFocusTrap<HTMLDivElement>(showModal, handleCloseModal);

  // ---------------------------------------------------------------------
  // CRUD Operations
  // ---------------------------------------------------------------------

  /**
   * Submits the form to create or update a budget alert. Calls the
   * POST or PATCH endpoint and refreshes the page on success.
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
      // WHY: Revalidate the server component data so the page shows
      // fresh spend calculations. Client-side state alone would show
      // stale spend.
      router.refresh();

      // Optimistic update for immediate feedback
      if (isEdit) {
        setAlerts((prev) =>
          prev.map((a) =>
            a.id === editingAlert.id ? { ...a, ...data.alert } : a
          )
        );
      } else {
        setAlerts((prev) => [
          { ...data.alert, current_spend_usd: 0, percentage_used: 0 },
          ...prev,
        ]);
        setAlertCount((prev) => prev + 1);
      }
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  }, [editingAlert, formData, handleCloseModal, router]);

  /**
   * Toggles an alert's enabled/disabled state. Uses an optimistic
   * update for instant UI feedback, reverting on failure.
   */
  const handleToggle = useCallback(async (alert: BudgetAlertWithSpend) => {
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
  }, []);

  /** Deletes a budget alert after user confirmation. */
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
        // Silently fail - the alert remains visible so the user can retry.
      } finally {
        setDeletingId(null);
      }
    },
    [router]
  );

  // ---------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------

  return (
    <div>
      <AlertsHeader
        alertCount={alertCount}
        alertLimit={alertLimit}
        tier={tier}
        onCreate={handleOpenCreate}
      />

      {alerts.length === 0 && (
        <EmptyState alertLimit={alertLimit} onCreate={handleOpenCreate} />
      )}

      {alerts.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {alerts.map((alert) => (
            <AlertCard
              key={alert.id}
              alert={alert}
              isDeleting={deletingId === alert.id}
              isToggling={togglingId === alert.id}
              onToggle={handleToggle}
              onEdit={handleOpenEdit}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}

      {showModal && (
        <AlertModal
          editingAlert={editingAlert}
          formData={formData}
          onFormChange={setFormData}
          error={error}
          isSubmitting={isSubmitting}
          onClose={handleCloseModal}
          onSubmit={handleSubmit}
          focusTrapRef={focusTrapRef}
        />
      )}
    </div>
  );
}
