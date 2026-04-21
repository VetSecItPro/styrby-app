/**
 * Pure helper functions for the webhooks UI.
 *
 * WHY split out: Each helper is deterministic and side-effect free, so we
 * can unit test them in isolation rather than dragging the React tree into
 * every assertion. Also keeps the orchestrator and presentation components
 * free of formatting noise.
 */

import {
  EVENT_COLORS,
  FALLBACK_EVENT_COLORS,
  type WebhookEvent,
} from './webhook-types';

/**
 * Resolve the badge color pair for an arbitrary event string.
 *
 * Falls back to neutral zinc when the event is not in the known map, which
 * happens if the backend introduces a new event type before the client is
 * updated. We render the badge instead of crashing or hiding the event.
 *
 * @param event - Event identifier from `webhook.events`.
 * @returns `{ bg, text }` Tailwind class pair for the badge.
 */
export function getEventColors(event: string): { bg: string; text: string } {
  return EVENT_COLORS[event as WebhookEvent] ?? FALLBACK_EVENT_COLORS;
}

/**
 * Format a webhook's last-success timestamp for the card footer.
 *
 * @param iso - ISO 8601 timestamp or null.
 * @returns Human-friendly string, or `'No deliveries yet'` when null.
 */
export function formatLastSuccess(iso: string | null): string {
  if (!iso) return 'No deliveries yet';
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * Toggle membership of `event` inside the `events` array.
 *
 * Used by the form's event picker. Order is preserved on remove; appended
 * to the end on add. Idempotent for missing events (returns a fresh copy).
 *
 * @param events - Current selected events.
 * @param event - Event to toggle in/out of selection.
 * @returns A new array; never mutates the input.
 */
export function toggleEvent(
  events: WebhookEvent[],
  event: WebhookEvent,
): WebhookEvent[] {
  return events.includes(event)
    ? events.filter((e) => e !== event)
    : [...events, event];
}

/**
 * Whether the create/edit form is ready for submission.
 *
 * All three fields are required: trimmed name + trimmed URL + at least one
 * event. Centralised so the submit button and an upcoming form-level
 * validation message stay in sync.
 *
 * @param form - Current form state.
 * @returns true when the user can hit submit.
 */
export function isFormSubmittable(form: {
  name: string;
  url: string;
  events: readonly WebhookEvent[];
}): boolean {
  return (
    form.name.trim().length > 0 &&
    form.url.trim().length > 0 &&
    form.events.length > 0
  );
}

/**
 * Color classes for a delivery row's status badge.
 *
 * Treats anything other than `success` / `pending` as a failure (red),
 * matching the backend's three-state model in the `webhook_deliveries`
 * table.
 */
export function getDeliveryStatusClasses(status: string): string {
  if (status === 'success') return 'bg-green-500/10 text-green-400';
  if (status === 'pending') return 'bg-yellow-500/10 text-yellow-400';
  return 'bg-red-500/10 text-red-400';
}
