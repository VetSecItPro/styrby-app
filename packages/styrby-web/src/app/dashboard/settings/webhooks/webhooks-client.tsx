'use client';

/**
 * Webhooks Client (orchestrator)
 *
 * Owns webhook state, network calls, and modal coordination. All
 * presentation lives in `./_components/*`.
 *
 * WHY a client component: Interactive state management — modals, toggle
 * switches, optimistic UI updates — none of which can run on the server.
 *
 * WHY orchestrator pattern: The previous monolith mixed list rendering,
 * card layout, two modals, and four mutation flows in a single 920-line
 * file. Splitting into one orchestrator + focused presentation children
 * makes each concern testable, reusable, and below the 400-LOC ceiling.
 */

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';

import {
  DEFAULT_FORM_DATA,
  DeliveryLogModal,
  WebhookCard,
  WebhookEmptyState,
  WebhookFormModal,
  WebhookHeader,
  WebhookTestToast,
  toggleEvent,
  type Webhook,
  type WebhookEvent,
  type WebhookFormData,
  type WebhookTestMessage,
} from './_components';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

/** Props from the server component (initial render data). */
interface WebhooksClientProps {
  initialWebhooks: Webhook[];
  tier: string;
  webhookLimit: number;
  webhookCount: number;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Webhooks management interface.
 *
 * Renders a list of webhook cards with status indicators and controls,
 * plus modals for creating/editing webhooks and viewing delivery logs.
 *
 * @param initialWebhooks - SSR-fetched webhooks for the user.
 * @param tier - User's plan tier (e.g., "Free", "Power").
 * @param webhookLimit - Maximum webhooks the user can create on their tier.
 * @param webhookCount - Initial count of active webhooks for the user.
 */
export function WebhooksClient({
  initialWebhooks,
  tier,
  webhookLimit,
  webhookCount: initialCount,
}: WebhooksClientProps) {
  const router = useRouter();

  // List + quota state
  const [webhooks, setWebhooks] = useState<Webhook[]>(initialWebhooks);
  const [webhookCount, setWebhookCount] = useState(initialCount);

  // Modal state
  const [showModal, setShowModal] = useState(false);
  const [showDeliveryModal, setShowDeliveryModal] = useState(false);
  const [editingWebhook, setEditingWebhook] = useState<Webhook | null>(null);
  const [selectedWebhook, setSelectedWebhook] = useState<Webhook | null>(null);

  // Form state
  const [formData, setFormData] = useState<WebhookFormData>(DEFAULT_FORM_DATA);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);

  // Per-row pending state
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testMessage, setTestMessage] = useState<WebhookTestMessage | null>(null);

  const canCreateWebhook = webhookCount < webhookLimit;

  // -------------------------------------------------------------------------
  // Modal handlers
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
  // Form change handlers
  // -------------------------------------------------------------------------

  const handleChangeName = useCallback((name: string) => {
    setFormData((prev) => ({ ...prev, name }));
  }, []);

  const handleChangeUrl = useCallback((url: string) => {
    setFormData((prev) => ({ ...prev, url }));
  }, []);

  const handleEventToggle = useCallback((event: WebhookEvent) => {
    setFormData((prev) => ({ ...prev, events: toggleEvent(prev.events, event) }));
  }, []);

  // -------------------------------------------------------------------------
  // CRUD operations
  // -------------------------------------------------------------------------

  /**
   * Submit create or edit. On create with a returned secret, switches the
   * modal into the secret-reveal panel; on edit, optimistically updates
   * the list and refreshes the route to re-fetch SSR state.
   */
  const handleSubmit = useCallback(async () => {
    setIsSubmitting(true);
    setError(null);

    try {
      const isEdit = editingWebhook !== null;
      const response = await fetch('/api/webhooks/user', {
        method: isEdit ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          isEdit ? { id: editingWebhook.id, ...formData } : formData,
        ),
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.error || 'Something went wrong');
        return;
      }

      if (!isEdit && data.secret) {
        // WHY: Show signing secret only once at creation — it is hashed
        // server-side and cannot be re-derived afterwards.
        setCreatedSecret(data.secret);
        setWebhooks((prev) => [data.webhook, ...prev]);
        setWebhookCount((prev) => prev + 1);
      } else {
        handleCloseModal();
        router.refresh();
        if (isEdit) {
          setWebhooks((prev) =>
            prev.map((w) =>
              w.id === editingWebhook.id ? { ...w, ...data.webhook } : w,
            ),
          );
        }
      }
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  }, [editingWebhook, formData, handleCloseModal, router]);

  /**
   * Optimistically toggle is_active and revert on any failure so the user
   * sees instant feedback while still tolerating network errors.
   */
  const handleToggle = useCallback(async (webhook: Webhook) => {
    setTogglingId(webhook.id);

    setWebhooks((prev) =>
      prev.map((w) =>
        w.id === webhook.id ? { ...w, is_active: !w.is_active } : w,
      ),
    );

    const revert = () =>
      setWebhooks((prev) =>
        prev.map((w) =>
          w.id === webhook.id ? { ...w, is_active: webhook.is_active } : w,
        ),
      );

    try {
      const response = await fetch('/api/webhooks/user', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: webhook.id, is_active: !webhook.is_active }),
      });
      if (!response.ok) revert();
    } catch {
      revert();
    } finally {
      setTogglingId(null);
    }
  }, []);

  const handleDelete = useCallback(
    async (webhookId: string) => {
      // WHY confirm(): Webhook deletion drops all associated delivery
      // history and cannot be undone. Native confirm is the lightest
      // possible "are you sure?" guard.
      if (
        !confirm(
          'Are you sure you want to delete this webhook? All delivery history will be lost.',
        )
      ) {
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
        // Silent fail - webhook remains visible; user can retry
      } finally {
        setDeletingId(null);
      }
    },
    [router],
  );

  /**
   * Dispatch a synthetic event to the webhook URL. Toast clears after 5s.
   */
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
        setTestMessage({
          type: 'success',
          text: data.message || 'Test event sent!',
        });
      } else {
        setTestMessage({
          type: 'error',
          text: data.error || 'Failed to send test',
        });
      }
    } catch {
      setTestMessage({ type: 'error', text: 'Network error' });
    } finally {
      setTestingId(null);
      setTimeout(() => setTestMessage(null), 5000);
    }
  }, []);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div>
      <WebhookHeader
        webhookCount={webhookCount}
        webhookLimit={webhookLimit}
        tier={tier}
        canCreateWebhook={canCreateWebhook}
        onCreate={handleOpenCreate}
      />

      {testMessage && <WebhookTestToast message={testMessage} />}

      {webhooks.length === 0 && (
        <WebhookEmptyState webhookLimit={webhookLimit} onCreate={handleOpenCreate} />
      )}

      {webhooks.length > 0 && (
        <div className="space-y-4">
          {webhooks.map((webhook) => (
            <WebhookCard
              key={webhook.id}
              webhook={webhook}
              isDeleting={deletingId === webhook.id}
              isToggling={togglingId === webhook.id}
              isTesting={testingId === webhook.id}
              onToggle={handleToggle}
              onTest={handleTest}
              onOpenDeliveries={handleOpenDeliveries}
              onEdit={handleOpenEdit}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}

      {showModal && (
        <WebhookFormModal
          isEditing={editingWebhook !== null}
          formData={formData}
          error={error}
          isSubmitting={isSubmitting}
          createdSecret={createdSecret}
          onClose={handleCloseModal}
          onSubmit={handleSubmit}
          onChangeName={handleChangeName}
          onChangeUrl={handleChangeUrl}
          onToggleEvent={handleEventToggle}
        />
      )}

      {showDeliveryModal && selectedWebhook && (
        <DeliveryLogModal webhook={selectedWebhook} onClose={handleCloseDeliveries} />
      )}
    </div>
  );
}
