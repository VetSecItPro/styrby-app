/**
 * WebhookTestToast
 *
 * Inline success/error banner displayed above the webhook list after the
 * user dispatches a test event. Auto-clears after 5s in the orchestrator.
 */

import type { WebhookTestMessage } from './webhook-types';

interface WebhookTestToastProps {
  message: WebhookTestMessage;
}

/**
 * Renders the test event result banner.
 */
export function WebhookTestToast({ message }: WebhookTestToastProps) {
  const isSuccess = message.type === 'success';
  return (
    <div
      className={`mb-4 rounded-lg px-4 py-3 ${
        isSuccess
          ? 'bg-green-500/10 border border-green-500/30'
          : 'bg-red-500/10 border border-red-500/30'
      }`}
    >
      <p className={`text-sm ${isSuccess ? 'text-green-400' : 'text-red-400'}`}>
        {message.text}
      </p>
    </div>
  );
}
