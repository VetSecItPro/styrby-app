/**
 * Webhook Empty State
 *
 * Shown when the user has no webhooks. Two variants based on tier:
 *   - tier supports webhooks → invite the user to create their first
 *   - tier does not (limit === 0) → invite the user to upgrade
 */

import Link from 'next/link';

interface WebhookEmptyStateProps {
  /** Tier limit; 0 means the user must upgrade before creating any. */
  webhookLimit: number;
  /** Open the create modal (only used when webhookLimit > 0). */
  onCreate: () => void;
}

/**
 * Renders the empty-state card for the webhooks page.
 *
 * When the tier has zero quota, the CTA links to /pricing instead of
 * opening the create modal — there's nothing to create until they upgrade.
 */
export function WebhookEmptyState({ webhookLimit, onCreate }: WebhookEmptyStateProps) {
  return (
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
            d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"
          />
        </svg>
      </div>
      <h3 className="text-lg font-medium text-zinc-100 mb-2">No webhooks</h3>
      {webhookLimit > 0 ? (
        <>
          <p className="text-zinc-500 mb-6 max-w-sm mx-auto">
            Create webhooks to receive event notifications in Slack, Discord,
            or any custom endpoint.
          </p>
          <button
            onClick={onCreate}
            className="rounded-lg bg-orange-500 px-6 py-2.5 text-sm font-semibold text-white hover:bg-orange-600 transition-colors"
            aria-label="Create your first webhook"
          >
            Create Your First Webhook
          </button>
        </>
      ) : (
        <>
          <p className="text-zinc-500 mb-6 max-w-sm mx-auto">
            Webhooks let you integrate Styrby with Slack, Discord, and more.
            Upgrade to Pro to create webhooks.
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
  );
}
