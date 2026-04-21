'use client';

/**
 * AlertModal — create/edit dialog for a budget alert.
 *
 * Owns the form-field layout and selector UI. Form state is owned by
 * the parent orchestrator so submit/cancel logic stays centralized.
 *
 * WHY split out: This is the largest visual chunk of the page (~225
 * LOC of fields, fieldsets, and the action grid). Extracting it keeps
 * the orchestrator within the 400-LOC budget and makes the form's
 * accessibility wiring (focus trap, aria-pressed, fieldset/legend)
 * easier to reason about in isolation.
 */

import {
  ACTION_DESCRIPTIONS,
  AGENT_TYPES,
  ALERT_ACTIONS,
  ALERT_PERIODS,
  ALERT_TYPES,
  ALERT_TYPE_INFO,
} from './helpers';
import { OptionPill } from './OptionPill';
import type { AlertFormData, AgentType, BudgetAlertType, BudgetAlertWithSpend } from './types';

interface AlertModalProps {
  /**
   * The alert being edited, or `null` when creating.
   * Used only to flip the modal title and submit-button label.
   */
  editingAlert: BudgetAlertWithSpend | null;
  /** Current form values. Controlled by the orchestrator. */
  formData: AlertFormData;
  /** Updates the form values. */
  onFormChange: (next: AlertFormData) => void;
  /** Server-returned error message, or `null` for none. */
  error: string | null;
  /** True while a create/update request is in flight. */
  isSubmitting: boolean;
  /** Closes the modal without saving. */
  onClose: () => void;
  /** Submits the form (create or update). */
  onSubmit: () => void;
  /**
   * Focus-trap container ref. Provided by the orchestrator so the trap
   * can outlive the modal mount and restore focus to the trigger.
   */
  focusTrapRef: React.RefObject<HTMLDivElement | null>;
}

/**
 * Renders the create/edit modal dialog.
 *
 * @param props - See {@link AlertModalProps}.
 */
export function AlertModal({
  editingAlert,
  formData,
  onFormChange,
  error,
  isSubmitting,
  onClose,
  onSubmit,
  focusTrapRef,
}: AlertModalProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-end md:items-center md:justify-center p-0 md:p-4"
      role="dialog"
      aria-modal="true"
      aria-label={editingAlert ? 'Edit budget alert' : 'Create budget alert'}
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Modal content */}
      <div
        ref={focusTrapRef}
        className="relative w-full md:w-auto md:min-w-[32rem] max-w-lg max-h-[85vh] overflow-y-auto rounded-t-xl md:rounded-xl bg-zinc-900 border border-zinc-800 p-6 shadow-xl"
      >
        <h2 className="text-lg font-semibold text-zinc-100 mb-6">
          {editingAlert ? 'Edit Budget Alert' : 'Create Budget Alert'}
        </h2>

        {error && (
          <div
            role="alert"
            className="mb-4 rounded-lg bg-red-500/10 border border-red-500/30 px-4 py-3"
          >
            <p className="text-sm text-red-400">{error}</p>
          </div>
        )}

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
              onChange={(e) =>
                onFormChange({ ...formData, name: e.target.value })
              }
              placeholder="e.g., Daily Claude limit"
              className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500"
              maxLength={100}
            />
          </div>

          {/* Alert Type picker (migration 023) */}
          <fieldset className="border-0 p-0 m-0">
            <legend className="block text-sm font-medium text-zinc-300 mb-1.5">
              Alert Type
            </legend>
            <div className="space-y-2">
              {ALERT_TYPES.map((type: BudgetAlertType) => {
                const info = ALERT_TYPE_INFO[type];
                const isSelected = formData.alert_type === type;
                return (
                  <button
                    key={type}
                    type="button"
                    onClick={() =>
                      onFormChange({
                        ...formData,
                        alert_type: type,
                        // WHY: Reset the type-specific threshold fields when
                        // switching alert type to avoid invalid cross-field state
                        // (e.g., a threshold_quota_fraction on a cost_usd alert).
                        threshold_quota_fraction: null,
                        threshold_credits: null,
                      })
                    }
                    className={`w-full rounded-lg px-3 py-2.5 text-left transition-colors ${
                      isSelected
                        ? 'bg-orange-500/10 border-orange-500/50 border'
                        : 'bg-zinc-800 border border-zinc-700 hover:bg-zinc-700'
                    }`}
                    aria-pressed={isSelected}
                  >
                    <p
                      className={`text-sm font-medium ${
                        isSelected ? 'text-orange-300' : 'text-zinc-300'
                      }`}
                    >
                      {info.label}
                    </p>
                    <p className="text-xs text-zinc-500 mt-0.5">{info.description}</p>
                  </button>
                );
              })}
            </div>
          </fieldset>

          {/* Threshold — conditional on alert_type */}
          {formData.alert_type === 'cost_usd' && (
            <div>
              <label
                htmlFor="alert-threshold"
                className="block text-sm font-medium text-zinc-300 mb-1.5"
              >
                {ALERT_TYPE_INFO.cost_usd.thresholdLabel}
                <span className="text-xs text-zinc-500 font-normal ml-2">
                  {ALERT_TYPE_INFO.cost_usd.thresholdHint}
                </span>
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
                    onFormChange({
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
          )}

          {formData.alert_type === 'subscription_quota' && (
            <div>
              <label
                htmlFor="alert-quota-fraction"
                className="block text-sm font-medium text-zinc-300 mb-1.5"
              >
                {ALERT_TYPE_INFO.subscription_quota.thresholdLabel}
                <span className="text-xs text-zinc-500 font-normal ml-2">
                  {ALERT_TYPE_INFO.subscription_quota.thresholdHint}
                </span>
              </label>
              <div className="relative">
                <input
                  id="alert-quota-fraction"
                  type="number"
                  value={
                    formData.threshold_quota_fraction !== null
                      ? (formData.threshold_quota_fraction * 100).toFixed(0)
                      : ''
                  }
                  onChange={(e) => {
                    const pct = parseFloat(e.target.value);
                    onFormChange({
                      ...formData,
                      threshold_quota_fraction: isNaN(pct) ? null : Math.min(100, Math.max(0, pct)) / 100,
                    });
                  }}
                  min={1}
                  max={100}
                  step={1}
                  placeholder="80"
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-800 pr-7 pl-3 py-2 text-sm text-zinc-100 focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-zinc-500">
                  %
                </span>
              </div>
            </div>
          )}

          {formData.alert_type === 'credits' && (
            <div>
              <label
                htmlFor="alert-credits"
                className="block text-sm font-medium text-zinc-300 mb-1.5"
              >
                {ALERT_TYPE_INFO.credits.thresholdLabel}
                <span className="text-xs text-zinc-500 font-normal ml-2">
                  {ALERT_TYPE_INFO.credits.thresholdHint}
                </span>
              </label>
              <input
                id="alert-credits"
                type="number"
                value={formData.threshold_credits ?? ''}
                onChange={(e) => {
                  const val = parseInt(e.target.value, 10);
                  onFormChange({
                    ...formData,
                    threshold_credits: isNaN(val) ? null : Math.max(1, val),
                  });
                }}
                min={1}
                step={1}
                placeholder="500"
                className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500"
              />
            </div>
          )}

          {/* Period selector */}
          <fieldset className="border-0 p-0 m-0">
            <legend className="block text-sm font-medium text-zinc-300 mb-1.5">
              Period
            </legend>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              {ALERT_PERIODS.map((period) => (
                <OptionPill
                  key={period}
                  isSelected={formData.period === period}
                  onClick={() => onFormChange({ ...formData, period })}
                >
                  {period.charAt(0).toUpperCase() + period.slice(1)}
                </OptionPill>
              ))}
            </div>
          </fieldset>

          {/* Agent filter */}
          <fieldset className="border-0 p-0 m-0">
            <legend className="block text-sm font-medium text-zinc-300 mb-1.5">
              Agent Filter
              <span className="text-zinc-500 font-normal ml-1">(optional)</span>
            </legend>
            <div className="grid grid-cols-4 gap-2">
              <OptionPill
                isSelected={formData.agent_type === null}
                onClick={() => onFormChange({ ...formData, agent_type: null })}
              >
                All
              </OptionPill>
              {AGENT_TYPES.map((agent: AgentType) => (
                <OptionPill
                  key={agent}
                  isSelected={formData.agent_type === agent}
                  onClick={() =>
                    onFormChange({ ...formData, agent_type: agent })
                  }
                  className="capitalize"
                >
                  {agent}
                </OptionPill>
              ))}
            </div>
          </fieldset>

          {/* Action selector */}
          <fieldset className="border-0 p-0 m-0">
            <legend className="block text-sm font-medium text-zinc-300 mb-1.5">
              Action When Triggered
            </legend>
            <div className="space-y-2">
              {ALERT_ACTIONS.map((action) => {
                const info = ACTION_DESCRIPTIONS[action];
                const isSelected = formData.action === action;
                return (
                  <button
                    key={action}
                    type="button"
                    onClick={() => onFormChange({ ...formData, action })}
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
                        <p className="text-xs text-zinc-500">
                          {info.description}
                        </p>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </fieldset>
        </div>

        {/* Modal actions */}
        <div className="flex items-center justify-end gap-3 mt-6 pt-4 border-t border-zinc-800">
          <button
            onClick={onClose}
            className="rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-300 hover:bg-zinc-800 transition-colors"
            disabled={isSubmitting}
          >
            Cancel
          </button>
          <button
            onClick={onSubmit}
            disabled={
              isSubmitting ||
              !formData.name.trim() ||
              // WHY per-type validation: each alert type has a different required
              // threshold field. Disabling submit prevents sending invalid data.
              (formData.alert_type === 'cost_usd' && formData.threshold_usd <= 0) ||
              (formData.alert_type === 'subscription_quota' && !formData.threshold_quota_fraction) ||
              (formData.alert_type === 'credits' && !formData.threshold_credits)
            }
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
  );
}
