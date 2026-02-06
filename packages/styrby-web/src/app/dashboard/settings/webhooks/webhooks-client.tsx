'use client';

/**
 * Webhooks Client Component
 *
 * Interactive UI for managing webhooks. Displays webhook cards with status,
 * event badges, and controls for creating, editing, testing, and deleting webhooks.
 *
 * WHY this is a client component: It requires interactive state management
 * for modals, toggle switches, and optimistic UI updates.
 */

import { useState, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Valid webhook event types */
type WebhookEvent =
  | 'session.started'
  | 'session.completed'
  | 'budget.exceeded'
  | 'permission.requested';

/** Webhook from the database */
interface Webhook {
  id: string;
  name: string;
  url: string;
  events: string[];
  is_active: boolean;
  last_success_at: string | null;
  last_failure_at: string | null;
  consecutive_failures: number;
  created_at: string;
  updated_at: string;
}

/** Props from server component */
interface WebhooksClientProps {
  initialWebhooks: Webhook[];
  tier: string;
  webhookLimit: number;
  webhookCount: number;
}

/** Form data for creating/editing webhook */
interface WebhookFormData {
  name: string;
  url: string;
  events: WebhookEvent[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Event descriptions for the create/edit form.
 */
const EVENT_OPTIONS: { value: WebhookEvent; label: string; description: string }[] = [
  {
    value: 'session.started',
    label: 'Session Started',
    description: 'When an agent session begins',
  },
  {
    value: 'session.completed',
    label: 'Session Completed',
    description: 'When an agent session ends',
  },
  {
    value: 'budget.exceeded',
    label: 'Budget Exceeded',
    description: 'When a budget alert threshold is crossed',
  },
  {
    value: 'permission.requested',
    label: 'Permission Requested',
    description: 'When an agent requests permission for an action',
  },
];

/**
 * Color scheme for event badges.
 */
const EVENT_COLORS: Record<WebhookEvent, { bg: string; text: string }> = {
  'session.started': { bg: 'bg-green-500/10', text: 'text-green-400' },
  'session.completed': { bg: 'bg-blue-500/10', text: 'text-blue-400' },
  'budget.exceeded': { bg: 'bg-orange-500/10', text: 'text-orange-400' },
  'permission.requested': { bg: 'bg-purple-500/10', text: 'text-purple-400' },
};

/** Default form values */
const DEFAULT_FORM_DATA: WebhookFormData = {
  name: '',
  url: '',
  events: [],
};

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

/**
 * Webhooks management interface.
 *
 * Renders a list of webhook cards with status indicators and controls,
 * plus modals for creating/editing webhooks and viewing delivery logs.
 */
export function WebhooksClient({
  initialWebhooks,
  tier,
  webhookLimit,
  webhookCount: initialCount,
}: WebhooksClientProps) {
  const router = useRouter();
  const [webhooks, setWebhooks] = useState<Webhook[]>(initialWebhooks);
  const [webhookCount, setWebhookCount] = useState(initialCount);
  const [showModal, setShowModal] = useState(false);
  const [showDeliveryModal, setShowDeliveryModal] = useState(false);
  const [editingWebhook, setEditingWebhook] = useState<Webhook | null>(null);
  const [selectedWebhook, setSelectedWebhook] = useState<Webhook | null>(null);
  const [formData, setFormData] = useState<WebhookFormData>(DEFAULT_FORM_DATA);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testMessage, setTestMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const canCreateWebhook = webhookCount < webhookLimit;

  // -------------------------------------------------------------------------
  // Modal Handlers
  // -------------------------------------------------------------------------

  const handleOpenCreate = useCallback(() => {
    setEditingWebhook(null);
    setFormData(DEFAULT_FORM_DATA);
    setError(null);
    setCreatedSecret(null);
    setShowModal(true);
  }, []);

  const handleOpenEdit = useCallback((webhook: Webhook) => {
    setEditingWebhook(webhook);
    setFormData({
      name: webhook.name,
      url: webhook.url,
      events: webhook.events as WebhookEvent[],
    });
    setError(null);
    setCreatedSecret(null);
    setShowModal(true);
  }, []);

  const handleCloseModal = useCallback(() => {
    setShowModal(false);
    setEditingWebhook(null);
    setFormData(DEFAULT_FORM_DATA);
    setError(null);
    setCreatedSecret(null);
  }, []);

  const handleOpenDeliveries = useCallback((webhook: Webhook) => {
    setSelectedWebhook(webhook);
    setShowDeliveryModal(true);
  }, []);

  const handleCloseDeliveries = useCallback(() => {
    setShowDeliveryModal(false);
    setSelectedWebhook(null);
  }, []);

  // -------------------------------------------------------------------------
  // Event Toggle Handler
  // -------------------------------------------------------------------------

  const handleEventToggle = useCallback((event: WebhookEvent) => {
    setFormData((prev) => ({
      ...prev,
      events: prev.events.includes(event)
        ? prev.events.filter((e) => e !== event)
        : [...prev.events, event],
    }));
  }, []);

  // -------------------------------------------------------------------------
  // CRUD Operations
  // -------------------------------------------------------------------------

  const handleSubmit = useCallback(async () => {
    setIsSubmitting(true);
    setError(null);

    try {
      const isEdit = editingWebhook !== null;
      const response = await fetch('/api/webhooks/user', {
        method: isEdit ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          isEdit ? { id: editingWebhook.id, ...formData } : formData
        ),
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.error || 'Something went wrong');
        return;
      }

      if (!isEdit && data.secret) {
        // Show the secret to the user (only on creation)
        setCreatedSecret(data.secret);
        setWebhooks((prev) => [data.webhook, ...prev]);
        setWebhookCount((prev) => prev + 1);
      } else {
        handleCloseModal();
        router.refresh();
        if (isEdit) {
          setWebhooks((prev) =>
            prev.map((w) => (w.id === editingWebhook.id ? { ...w, ...data.webhook } : w))
          );
        }
      }
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  }, [editingWebhook, formData, handleCloseModal, router]);

  const handleToggle = useCallback(async (webhook: Webhook) => {
    setTogglingId(webhook.id);

    // Optimistic update
    setWebhooks((prev) =>
      prev.map((w) =>
        w.id === webhook.id ? { ...w, is_active: !w.is_active } : w
      )
    );

    try {
      const response = await fetch('/api/webhooks/user', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: webhook.id, is_active: !webhook.is_active }),
      });

      if (!response.ok) {
        // Revert on failure
        setWebhooks((prev) =>
          prev.map((w) =>
            w.id === webhook.id ? { ...w, is_active: webhook.is_active } : w
          )
        );
      }
    } catch {
      // Revert on error
      setWebhooks((prev) =>
        prev.map((w) =>
          w.id === webhook.id ? { ...w, is_active: webhook.is_active } : w
        )
      );
    } finally {
      setTogglingId(null);
    }
  }, []);

  const handleDelete = useCallback(async (webhookId: string) => {
    if (!confirm('Are you sure you want to delete this webhook? All delivery history will be lost.')) {
      return;
    }

    setDeletingId(webhookId);

    try {
      const response = await fetch('/api/webhooks/user', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: webhookId }),
      });

      if (response.ok) {
        setWebhooks((prev) => prev.filter((w) => w.id !== webhookId));
        setWebhookCount((prev) => prev - 1);
        router.refresh();
      }
    } catch {
      // Silent fail - webhook remains visible
    } finally {
      setDeletingId(null);
    }
  }, [router]);

  const handleTest = useCallback(async (webhook: Webhook) => {
    setTestingId(webhook.id);
    setTestMessage(null);

    try {
      const response = await fetch('/api/webhooks/user/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: webhook.id }),
      });

      const data = await response.json();

      if (response.ok) {
        setTestMessage({ type: 'success', text: data.message || 'Test event sent!' });
      } else {
        setTestMessage({ type: 'error', text: data.error || 'Failed to send test' });
      }
    } catch {
      setTestMessage({ type: 'error', text: 'Network error' });
    } finally {
      setTestingId(null);
      // Clear message after 5 seconds
      setTimeout(() => setTestMessage(null), 5000);
    }
  }, []);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div>
      {/* Header with create button and tier indicator */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-4">
          <p className="text-sm text-zinc-400">
            {webhookCount} / {webhookLimit} webhooks used
            <span className="text-zinc-600 ml-2">({tier} plan)</span>
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
              onClick={handleOpenCreate}
              className="rounded-lg bg-orange-500 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-600 transition-colors flex items-center gap-2"
              aria-label="Create a new webhook"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
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

      {/* Test message toast */}
      {testMessage && (
        <div
          className={`mb-4 rounded-lg px-4 py-3 ${
            testMessage.type === 'success'
              ? 'bg-green-500/10 border border-green-500/30'
              : 'bg-red-500/10 border border-red-500/30'
          }`}
        >
          <p className={`text-sm ${testMessage.type === 'success' ? 'text-green-400' : 'text-red-400'}`}>
            {testMessage.text}
          </p>
        </div>
      )}

      {/* Empty State */}
      {webhooks.length === 0 && (
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
                onClick={handleOpenCreate}
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
      )}

      {/* Webhook Cards */}
      {webhooks.length > 0 && (
        <div className="space-y-4">
          {webhooks.map((webhook) => {
            const isDeleting = deletingId === webhook.id;
            const isToggling = togglingId === webhook.id;
            const isTesting = testingId === webhook.id;
            const hasFailures = webhook.consecutive_failures > 0;

            return (
              <div
                key={webhook.id}
                className={`rounded-xl bg-zinc-900 border border-zinc-800 p-4 transition-opacity ${
                  !webhook.is_active ? 'opacity-60' : ''
                } ${isDeleting ? 'opacity-30 pointer-events-none' : ''}`}
              >
                {/* Header row */}
                <div className="flex items-start justify-between mb-3">
                  <div className="flex-1 min-w-0 mr-4">
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-semibold text-zinc-100">
                        {webhook.name}
                      </h3>
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
                      onChange={() => handleToggle(webhook)}
                      disabled={isToggling}
                      aria-label={`${webhook.is_active ? 'Disable' : 'Enable'} ${webhook.name}`}
                    />
                    <div className="h-5 w-9 rounded-full bg-zinc-700 after:absolute after:left-[2px] after:top-[2px] after:h-4 after:w-4 after:rounded-full after:bg-white after:transition-all peer-checked:bg-orange-500 peer-checked:after:translate-x-full" />
                  </label>
                </div>

                {/* Event badges */}
                <div className="flex flex-wrap gap-2 mb-3">
                  {webhook.events.map((event) => {
                    const colors = EVENT_COLORS[event as WebhookEvent] || {
                      bg: 'bg-zinc-500/10',
                      text: 'text-zinc-400',
                    };
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
                        Last success: {new Date(webhook.last_success_at).toLocaleDateString('en-US', {
                          month: 'short',
                          day: 'numeric',
                          hour: 'numeric',
                          minute: '2-digit',
                        })}
                      </span>
                    ) : (
                      <span>No deliveries yet</span>
                    )}
                  </div>

                  {/* Action buttons */}
                  <div className="flex items-center gap-1">
                    {/* Test */}
                    <button
                      onClick={() => handleTest(webhook)}
                      disabled={isTesting || !webhook.is_active}
                      className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors disabled:opacity-50"
                      aria-label={`Test ${webhook.name}`}
                      title="Send test event"
                    >
                      {isTesting ? (
                        <div className="h-4 w-4 animate-spin rounded-full border-2 border-zinc-500 border-t-zinc-300" />
                      ) : (
                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                      )}
                    </button>
                    {/* Delivery log */}
                    <button
                      onClick={() => handleOpenDeliveries(webhook)}
                      className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
                      aria-label={`View delivery log for ${webhook.name}`}
                      title="View delivery log"
                    >
                      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                      </svg>
                    </button>
                    {/* Edit */}
                    <button
                      onClick={() => handleOpenEdit(webhook)}
                      className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
                      aria-label={`Edit ${webhook.name}`}
                    >
                      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                      </svg>
                    </button>
                    {/* Delete */}
                    <button
                      onClick={() => handleDelete(webhook.id)}
                      disabled={isDeleting}
                      className="p-1.5 rounded-lg text-zinc-500 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                      aria-label={`Delete ${webhook.name}`}
                    >
                      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  </div>
                </div>
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
          aria-label={editingWebhook ? 'Edit webhook' : 'Create webhook'}
        >
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={createdSecret ? undefined : handleCloseModal}
            aria-hidden="true"
          />

          {/* Modal content */}
          <div className="relative w-full max-w-lg rounded-xl bg-zinc-900 border border-zinc-800 p-6 shadow-xl">
            {createdSecret ? (
              // Secret display after creation
              <>
                <h2 className="text-lg font-semibold text-zinc-100 mb-4">
                  Webhook Created!
                </h2>
                <div className="mb-4 rounded-lg bg-yellow-500/10 border border-yellow-500/30 px-4 py-3">
                  <p className="text-sm text-yellow-400 mb-2">
                    Save this signing secret now. You will not be able to see it again!
                  </p>
                  <code className="block p-3 bg-zinc-800 rounded text-sm text-zinc-100 font-mono break-all">
                    {createdSecret}
                  </code>
                </div>
                <p className="text-sm text-zinc-400 mb-6">
                  Use this secret to verify webhook signatures. Store it securely in your environment variables.
                </p>
                <div className="flex justify-end">
                  <button
                    onClick={handleCloseModal}
                    className="rounded-lg bg-orange-500 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-600 transition-colors"
                  >
                    Done
                  </button>
                </div>
              </>
            ) : (
              // Create/Edit form
              <>
                <h2 className="text-lg font-semibold text-zinc-100 mb-6">
                  {editingWebhook ? 'Edit Webhook' : 'Create Webhook'}
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
                    <label htmlFor="webhook-name" className="block text-sm font-medium text-zinc-300 mb-1.5">
                      Name
                    </label>
                    <input
                      id="webhook-name"
                      type="text"
                      value={formData.name}
                      onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                      placeholder="e.g., Slack Notifications"
                      className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500"
                      maxLength={100}
                    />
                  </div>

                  {/* URL */}
                  <div>
                    <label htmlFor="webhook-url" className="block text-sm font-medium text-zinc-300 mb-1.5">
                      Endpoint URL
                    </label>
                    <input
                      id="webhook-url"
                      type="url"
                      value={formData.url}
                      onChange={(e) => setFormData({ ...formData, url: e.target.value })}
                      placeholder="https://..."
                      className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500"
                    />
                    <p className="mt-1 text-xs text-zinc-500">
                      Must be HTTPS for production use
                    </p>
                  </div>

                  {/* Events */}
                  <div>
                    <label className="block text-sm font-medium text-zinc-300 mb-1.5">
                      Events to Subscribe
                    </label>
                    <div className="space-y-2">
                      {EVENT_OPTIONS.map((event) => {
                        const isSelected = formData.events.includes(event.value);
                        return (
                          <button
                            key={event.value}
                            type="button"
                            onClick={() => handleEventToggle(event.value)}
                            className={`w-full rounded-lg px-4 py-3 text-left transition-colors ${
                              isSelected
                                ? 'bg-orange-500/10 border-orange-500/50 border'
                                : 'bg-zinc-800 border border-zinc-700 hover:bg-zinc-700'
                            }`}
                            aria-pressed={isSelected}
                          >
                            <div className="flex items-center gap-3">
                              <div
                                className={`h-4 w-4 rounded border-2 flex items-center justify-center ${
                                  isSelected
                                    ? 'bg-orange-500 border-orange-500'
                                    : 'border-zinc-500'
                                }`}
                              >
                                {isSelected && (
                                  <svg className="h-3 w-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                                  </svg>
                                )}
                              </div>
                              <div>
                                <p className={`text-sm font-medium ${isSelected ? 'text-orange-300' : 'text-zinc-300'}`}>
                                  {event.label}
                                </p>
                                <p className="text-xs text-zinc-500">{event.description}</p>
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
                    disabled={isSubmitting || !formData.name.trim() || !formData.url.trim() || formData.events.length === 0}
                    className="rounded-lg bg-orange-500 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                  >
                    {isSubmitting && (
                      <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" aria-hidden="true" />
                    )}
                    {editingWebhook ? 'Save Changes' : 'Create Webhook'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Delivery Log Modal */}
      {showDeliveryModal && selectedWebhook && (
        <DeliveryLogModal
          webhook={selectedWebhook}
          onClose={handleCloseDeliveries}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Delivery Log Modal Component
// ---------------------------------------------------------------------------

interface DeliveryLogModalProps {
  webhook: Webhook;
  onClose: () => void;
}

function DeliveryLogModal({ webhook, onClose }: DeliveryLogModalProps) {
  const [deliveries, setDeliveries] = useState<Array<{
    id: string;
    event: string;
    status: string;
    attempts: number;
    response_status: number | null;
    error_message: string | null;
    duration_ms: number | null;
    created_at: string;
  }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Fetch deliveries on mount
  useState(() => {
    async function fetchDeliveries() {
      try {
        const response = await fetch(
          `/api/webhooks/user/deliveries?webhookId=${webhook.id}&limit=20`
        );
        const data = await response.json();

        if (response.ok) {
          setDeliveries(data.deliveries || []);
        } else {
          setError(data.error || 'Failed to load deliveries');
        }
      } catch {
        setError('Network error');
      } finally {
        setLoading(false);
      }
    }

    fetchDeliveries();
  });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Webhook delivery log"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Modal content */}
      <div className="relative w-full max-w-2xl max-h-[80vh] overflow-hidden rounded-xl bg-zinc-900 border border-zinc-800 shadow-xl flex flex-col">
        {/* Header */}
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
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
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
              <p className="text-sm text-zinc-600 mt-1">
                Deliveries will appear here once events are triggered
              </p>
            </div>
          )}

          {!loading && !error && deliveries.length > 0 && (
            <div className="space-y-3">
              {deliveries.map((delivery) => (
                <div
                  key={delivery.id}
                  className="rounded-lg bg-zinc-800 border border-zinc-700 p-4"
                >
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                          delivery.status === 'success'
                            ? 'bg-green-500/10 text-green-400'
                            : delivery.status === 'pending'
                            ? 'bg-yellow-500/10 text-yellow-400'
                            : 'bg-red-500/10 text-red-400'
                        }`}
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
                    {delivery.response_status && (
                      <span>HTTP {delivery.response_status}</span>
                    )}
                    {delivery.duration_ms !== null && (
                      <span>{delivery.duration_ms}ms</span>
                    )}
                    <span>Attempts: {delivery.attempts}</span>
                  </div>
                  {delivery.error_message && (
                    <p className="mt-2 text-xs text-red-400 truncate" title={delivery.error_message}>
                      {delivery.error_message}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
