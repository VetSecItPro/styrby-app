'use client';

/**
 * Retention Section — global auto-delete settings
 *
 * Lets the user set a global "auto-delete sessions older than N days" policy.
 * Backed by PUT /api/account/retention.
 *
 * WHY options are only 7/30/90/365/never:
 *   The migration constrains profiles.retention_days to these exact values.
 *   Arbitrary values would require a free-text input with server-side validation
 *   and confuse users ("exactly how many days is 3 weeks?"). Discrete options
 *   are clearer and map to natural periods.
 *
 * Audit: every change writes an audit_log row via the API route.
 * GDPR Art. 5(1)(e) — storage limitation principle.
 */

import { useCallback, useState } from 'react';
import { Shield } from 'lucide-react';

/** Retention window options shown in the UI. */
const RETENTION_OPTIONS: { label: string; value: number | null; description: string }[] = [
  {
    label: '7 days',
    value: 7,
    description: 'Sessions older than 7 days are auto-deleted. Good for privacy-first workflows.',
  },
  {
    label: '30 days',
    value: 30,
    description: 'Sessions older than 30 days are auto-deleted. Recommended balance.',
  },
  {
    label: '90 days',
    value: 90,
    description: 'Sessions older than 90 days are auto-deleted.',
  },
  {
    label: '1 year',
    value: 365,
    description: 'Sessions older than 1 year are auto-deleted.',
  },
  {
    label: 'Never',
    value: null,
    description: 'Sessions are never auto-deleted. You manage deletion manually.',
  },
];

/** Props for {@link RetentionSection}. */
export interface RetentionSectionProps {
  /** Current user ID (unused directly — retained for audit trace). */
  userId: string;
  /** Current retention setting from server. null = never. */
  initialRetentionDays: number | null;
}

/**
 * Renders the global session retention picker.
 *
 * @param props - Server-pre-fetched retention settings
 */
export function RetentionSection({ initialRetentionDays }: RetentionSectionProps) {
  const [retentionDays, setRetentionDays] = useState<number | null>(initialRetentionDays);
  const [isLoading, setIsLoading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  /**
   * Persist the selected retention window to the API.
   *
   * WHY optimistic UI update (setRetentionDays before await):
   *   The retention change is low-stakes — if the API call fails we revert.
   *   Optimistic updates feel faster and reduce perceived latency.
   */
  const handleChange = useCallback(async (value: number | null) => {
    const previous = retentionDays;
    setRetentionDays(value); // optimistic
    setIsLoading(true);
    setMessage(null);

    try {
      const response = await fetch('/api/account/retention', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ retention_days: value }),
      });

      if (!response.ok) {
        const data = await response.json();
        setRetentionDays(previous); // revert
        setMessage({ type: 'error', text: data.error ?? 'Failed to update retention settings.' });
        return;
      }

      const label = RETENTION_OPTIONS.find((o) => o.value === value)?.label ?? 'Never';
      setMessage({ type: 'success', text: `Retention policy updated to: ${label}.` });
    } catch {
      setRetentionDays(previous); // revert
      setMessage({ type: 'error', text: 'Network error. Please try again.' });
    } finally {
      setIsLoading(false);
    }
  }, [retentionDays]);

  return (
    <section className="rounded-xl bg-zinc-900 border border-zinc-800">
      <div className="px-6 py-4 border-b border-zinc-800 flex items-center gap-3">
        <Shield className="h-4 w-4 text-blue-400" aria-hidden />
        <h2 className="text-base font-semibold text-zinc-100">Session Retention</h2>
        <span className="ml-auto text-xs text-zinc-500">GDPR Art. 5(1)(e)</span>
      </div>

      <div className="px-6 py-4">
        <p className="text-sm text-zinc-400 mb-4">
          Auto-delete sessions after a set period. Older sessions take up storage and may
          contain sensitive context - set a window that fits your workflow.
        </p>

        <div className="space-y-2">
          {RETENTION_OPTIONS.map((option) => {
            const isSelected = retentionDays === option.value;
            return (
              <button
                key={String(option.value)}
                type="button"
                onClick={() => handleChange(option.value)}
                disabled={isLoading}
                aria-pressed={isSelected}
                className={`w-full flex items-start gap-3 rounded-lg px-4 py-3 text-left transition-colors border ${
                  isSelected
                    ? 'border-blue-500/50 bg-blue-500/10'
                    : 'border-zinc-700 bg-zinc-800 hover:border-zinc-600'
                } disabled:opacity-50 disabled:cursor-not-allowed`}
              >
                <div
                  className={`mt-0.5 h-4 w-4 rounded-full border-2 flex-shrink-0 ${
                    isSelected ? 'border-blue-400 bg-blue-400' : 'border-zinc-500'
                  }`}
                  aria-hidden
                />
                <div>
                  <p className={`text-sm font-medium ${isSelected ? 'text-blue-300' : 'text-zinc-200'}`}>
                    {option.label}
                  </p>
                  <p className="text-xs text-zinc-500 mt-0.5">{option.description}</p>
                </div>
              </button>
            );
          })}
        </div>

        {message && (
          <p
            role="status"
            className={`mt-3 text-sm ${message.type === 'success' ? 'text-green-400' : 'text-red-400'}`}
          >
            {message.text}
          </p>
        )}
      </div>
    </section>
  );
}
