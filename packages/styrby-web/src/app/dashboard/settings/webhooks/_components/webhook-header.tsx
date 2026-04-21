/**
 * Webhook Header
 *
 * Top bar of the webhooks settings page: usage indicator, docs link, back
 * link, and the create-or-upgrade CTA.
 *
 * WHY split: Decouples the orchestrator from the tier/quota CTA branching,
 * which has three states (can-create / locked-on-free / hit-limit-on-paid).
 */

import Link from 'next/link';

interface WebhookHeaderProps {
  /** Active webhook count for the user. */
  webhookCount: number;
  /** Hard limit by tier. 0 means tier has no webhook access. */
  webhookLimit: number;
  /** User's plan name shown in parentheses. */
  tier: string;
  /** Whether the user is below their limit. */
  canCreateWebhook: boolean;
  /** Open the create modal. */
  onCreate: () => void;
}

/**
 * Renders the top header strip for the webhooks page.
 *
 * Shows quota usage on the left and the primary CTA on the right. The CTA
 * routes to /pricing when the user is at or above their tier limit.
 */
export function WebhookHeader({
  webhookCount,
  webhookLimit,
  tier,
  canCreateWebhook,
  onCreate,
}: WebhookHeaderProps) {
  return (
    <div className="flex items-center justify-between mb-6">
      <div className="flex items-center gap-4">
        <p className="text-sm text-zinc-400">
          {webhookCount} / {webhookLimit} webhooks used
          <span className="text-zinc-500 ml-2">({tier} plan)</span>
        </p>
        <Link
          href="/dashboard/settings/webhooks/docs"
          className="text-sm text-orange-400 hover:text-orange-300 transition-colors"
        >
          View Documentation
        </Link>
      </div>
      <div className="flex items-center gap-3">
        <Link
          href="/dashboard/settings"
          className="rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-300 hover:bg-zinc-800 transition-colors"
        >
          Back to Settings
        </Link>
        {canCreateWebhook ? (
          <button
            onClick={onCreate}
            className="rounded-lg bg-orange-500 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-600 transition-colors flex items-center gap-2"
            aria-label="Create a new webhook"
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
                d="M12 4v16m8-8H4"
              />
            </svg>
            Create Webhook
          </button>
        ) : webhookLimit === 0 ? (
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
  );
}
