/**
 * DeliveryLogModal
 *
 * Modal that fetches and displays recent webhook delivery attempts for the
 * selected webhook. Limited to the last 20 deliveries server-side.
 */

import { useEffect, useState } from 'react';

import { getDeliveryStatusClasses } from './webhook-helpers';
import type { Webhook, WebhookDelivery } from './webhook-types';

interface DeliveryLogModalProps {
  webhook: Webhook;
  onClose: () => void;
}

/**
 * Renders the delivery log modal.
 *
 * WHY useEffect (not useState initializer): The original implementation
 * fired the fetch from `useState(() => { ... })`, which technically works
 * but abuses useState's initializer for side effects. Switched to
 * useEffect so the intent (run-on-mount side effect) is explicit and
 * compatible with React Strict Mode's expectations.
 */
export function DeliveryLogModal({ webhook, onClose }: DeliveryLogModalProps) {
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    /**
     * Fetch the latest 20 delivery attempts for the selected webhook.
     * Cancellation guard avoids state writes after unmount.
     */
    async function fetchDeliveries() {
      try {
        const response = await fetch(
          `/api/webhooks/user/deliveries?webhookId=${webhook.id}&limit=20`,
        );
        const data = await response.json();

        if (cancelled) return;

        if (response.ok) {
          setDeliveries(data.deliveries || []);
        } else {
          setError(data.error || 'Failed to load deliveries');
        }
      } catch {
        if (!cancelled) setError('Network error');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchDeliveries();
    return () => {
      cancelled = true;
    };
  }, [webhook.id]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end md:items-center md:justify-center p-0 md:p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Webhook delivery log"
    >
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />

      <div className="relative w-full md:w-auto md:min-w-[40rem] max-w-2xl max-h-[85vh] overflow-hidden rounded-t-xl md:rounded-xl bg-zinc-900 border border-zinc-800 shadow-xl flex flex-col">
        <div className="px-6 py-4 border-b border-zinc-800 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-zinc-100">Delivery Log</h2>
            <p className="text-sm text-zinc-500">{webhook.name}</p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
            aria-label="Close delivery log"
          >
            <svg
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {loading && (
            <div className="flex items-center justify-center py-8">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-zinc-600 border-t-orange-500" />
            </div>
          )}

          {error && (
            <div className="rounded-lg bg-red-500/10 border border-red-500/30 px-4 py-3">
              <p className="text-sm text-red-400">{error}</p>
            </div>
          )}

          {!loading && !error && deliveries.length === 0 && (
            <div className="text-center py-8">
              <p className="text-zinc-500">No deliveries yet</p>
              <p className="text-sm text-zinc-500 mt-1">
                Deliveries will appear here once events are triggered
              </p>
            </div>
          )}

          {!loading && !error && deliveries.length > 0 && (
            <div className="space-y-3">
              {deliveries.map((delivery) => (
                <DeliveryRow key={delivery.id} delivery={delivery} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Renders a single delivery attempt row.
 */
function DeliveryRow({ delivery }: { delivery: WebhookDelivery }) {
  return (
    <div className="rounded-lg bg-zinc-800 border border-zinc-700 p-4">
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${getDeliveryStatusClasses(delivery.status)}`}
          >
            {delivery.status}
          </span>
          <span className="text-sm text-zinc-300">{delivery.event}</span>
        </div>
        <span className="text-xs text-zinc-500">
          {new Date(delivery.created_at).toLocaleString()}
        </span>
      </div>
      <div className="text-xs text-zinc-500 flex items-center gap-3">
        {delivery.response_status && <span>HTTP {delivery.response_status}</span>}
        {delivery.duration_ms !== null && <span>{delivery.duration_ms}ms</span>}
        <span>Attempts: {delivery.attempts}</span>
      </div>
      {delivery.error_message && (
        <p
          className="mt-2 text-xs text-red-400 truncate"
          title={delivery.error_message}
        >
          {delivery.error_message}
        </p>
      )}
    </div>
  );
}
