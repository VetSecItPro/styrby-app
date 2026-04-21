/**
 * WebhookCard
 *
 * Single webhook row on the management page. Owns the per-card layout
 * (header, event badges, footer/actions) and forwards intent to the
 * orchestrator via callback props. Owns no state.
 */

import { formatLastSuccess, getEventColors } from './webhook-helpers';
import { WebhookIconButton } from './webhook-icon-button';
import type { Webhook } from './webhook-types';

interface WebhookCardProps {
  webhook: Webhook;
  /** True when a delete request is in-flight for this webhook. */
  isDeleting: boolean;
  /** True when an enable/disable toggle is in-flight. */
  isToggling: boolean;
  /** True when a test event is being dispatched. */
  isTesting: boolean;
  onToggle: (webhook: Webhook) => void;
  onTest: (webhook: Webhook) => void;
  onOpenDeliveries: (webhook: Webhook) => void;
  onEdit: (webhook: Webhook) => void;
  onDelete: (webhookId: string) => void;
}

/**
 * Renders one webhook card.
 *
 * Visual cues:
 *   - Disabled webhooks render at 60% opacity.
 *   - Cards being deleted go to 30% opacity and stop accepting clicks.
 *   - Webhooks with consecutive failures show a red "N failures" pill.
 */
export function WebhookCard({
  webhook,
  isDeleting,
  isToggling,
  isTesting,
  onToggle,
  onTest,
  onOpenDeliveries,
  onEdit,
  onDelete,
}: WebhookCardProps) {
  const hasFailures = webhook.consecutive_failures > 0;

  return (
    <div
      className={`rounded-xl bg-zinc-900 border border-zinc-800 p-4 transition-opacity ${
        !webhook.is_active ? 'opacity-60' : ''
      } ${isDeleting ? 'opacity-30 pointer-events-none' : ''}`}
    >
      {/* Header row */}
      <div className="flex items-start justify-between mb-3">
        <div className="flex-1 min-w-0 mr-4">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-zinc-100">{webhook.name}</h3>
            {hasFailures && (
              <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-red-500/10 text-red-400">
                {webhook.consecutive_failures} failures
              </span>
            )}
          </div>
          <p className="text-xs text-zinc-500 mt-1 truncate" title={webhook.url}>
            {webhook.url}
          </p>
        </div>
        {/* Toggle switch */}
        <label className="relative inline-flex cursor-pointer items-center flex-shrink-0">
          <input
            type="checkbox"
            className="peer sr-only"
            checked={webhook.is_active}
            onChange={() => onToggle(webhook)}
            disabled={isToggling}
            aria-label={`${webhook.is_active ? 'Disable' : 'Enable'} ${webhook.name}`}
          />
          <div className="h-5 w-9 rounded-full bg-zinc-700 after:absolute after:left-[2px] after:top-[2px] after:h-4 after:w-4 after:rounded-full after:bg-white after:transition-all peer-checked:bg-orange-500 peer-checked:after:translate-x-full" />
        </label>
      </div>

      {/* Event badges */}
      <div className="flex flex-wrap gap-2 mb-3">
        {webhook.events.map((event) => {
          const colors = getEventColors(event);
          return (
            <span
              key={event}
              className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${colors.bg} ${colors.text}`}
            >
              {event}
            </span>
          );
        })}
      </div>

      {/* Footer with status and actions */}
      <div className="flex items-center justify-between">
        <div className="text-xs text-zinc-500">
          {webhook.last_success_at ? (
            <span className="text-green-400">
              Last success: {formatLastSuccess(webhook.last_success_at)}
            </span>
          ) : (
            <span>{formatLastSuccess(null)}</span>
          )}
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-1">
          <WebhookIconButton
            onClick={() => onTest(webhook)}
            disabled={isTesting || !webhook.is_active}
            ariaLabel={`Test ${webhook.name}`}
            title="Send test event"
          >
            {isTesting ? (
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-zinc-500 border-t-zinc-300" />
            ) : (
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
                  d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"
                />
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
            )}
          </WebhookIconButton>

          <WebhookIconButton
            onClick={() => onOpenDeliveries(webhook)}
            ariaLabel={`View delivery log for ${webhook.name}`}
            title="View delivery log"
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
                d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
              />
            </svg>
          </WebhookIconButton>

          <WebhookIconButton
            onClick={() => onEdit(webhook)}
            ariaLabel={`Edit ${webhook.name}`}
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
          </WebhookIconButton>

          <WebhookIconButton
            onClick={() => onDelete(webhook.id)}
            disabled={isDeleting}
            ariaLabel={`Delete ${webhook.name}`}
            variant="danger"
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
          </WebhookIconButton>
        </div>
      </div>
    </div>
  );
}
