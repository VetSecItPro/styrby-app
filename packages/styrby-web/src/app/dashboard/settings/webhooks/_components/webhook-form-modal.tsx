/**
 * WebhookFormModal
 *
 * Bottom-sheet / centered modal for creating or editing a webhook, plus a
 * post-create state that surfaces the freshly-generated signing secret.
 *
 * WHY one component, two states: The "form" and "secret" panels share the
 * same backdrop, container, and close behavior. Splitting them would
 * duplicate the chrome and risk the two halves drifting visually.
 */

import { EVENT_OPTIONS, type WebhookFormData, type WebhookEvent } from './webhook-types';
import { isFormSubmittable } from './webhook-helpers';

interface WebhookFormModalProps {
  /** True when editing an existing webhook (changes title + button label). */
  isEditing: boolean;
  formData: WebhookFormData;
  /** Validation/server error to display above the form. */
  error: string | null;
  /** Whether a create/edit request is in flight. */
  isSubmitting: boolean;
  /**
   * If non-null, the modal switches to the "secret created" panel. The
   * close handler is suppressed on backdrop click in this state to prevent
   * accidental loss of the secret.
   */
  createdSecret: string | null;
  onClose: () => void;
  onSubmit: () => void;
  onChangeName: (name: string) => void;
  onChangeUrl: (url: string) => void;
  onToggleEvent: (event: WebhookEvent) => void;
}

/**
 * Renders the create/edit modal or the post-create secret reveal.
 */
export function WebhookFormModal({
  isEditing,
  formData,
  error,
  isSubmitting,
  createdSecret,
  onClose,
  onSubmit,
  onChangeName,
  onChangeUrl,
  onToggleEvent,
}: WebhookFormModalProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-end md:items-center md:justify-center p-0 md:p-4"
      role="dialog"
      aria-modal="true"
      aria-label={isEditing ? 'Edit webhook' : 'Create webhook'}
    >
      {/* Backdrop — disabled while showing the secret to prevent loss */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={createdSecret ? undefined : onClose}
        aria-hidden="true"
      />

      <div className="relative w-full md:w-auto md:min-w-[32rem] max-w-lg max-h-[85vh] overflow-y-auto rounded-t-xl md:rounded-xl bg-zinc-900 border border-zinc-800 p-6 shadow-xl">
        {createdSecret ? (
          <SecretRevealPanel secret={createdSecret} onClose={onClose} />
        ) : (
          <CreateEditPanel
            isEditing={isEditing}
            formData={formData}
            error={error}
            isSubmitting={isSubmitting}
            onClose={onClose}
            onSubmit={onSubmit}
            onChangeName={onChangeName}
            onChangeUrl={onChangeUrl}
            onToggleEvent={onToggleEvent}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Internal panels
// ---------------------------------------------------------------------------

interface SecretRevealPanelProps {
  secret: string;
  onClose: () => void;
}

/**
 * One-time reveal of the newly-minted webhook signing secret.
 *
 * The user MUST copy this now — it is hashed at rest server-side and we
 * cannot show it again. The "Done" CTA confirms acknowledgement.
 */
function SecretRevealPanel({ secret, onClose }: SecretRevealPanelProps) {
  return (
    <>
      <h2 className="text-lg font-semibold text-zinc-100 mb-4">Webhook Created!</h2>
      <div className="mb-4 rounded-lg bg-yellow-500/10 border border-yellow-500/30 px-4 py-3">
        <p className="text-sm text-yellow-400 mb-2">
          Save this signing secret now. You will not be able to see it again!
        </p>
        <code className="block p-3 bg-zinc-800 rounded text-sm text-zinc-100 font-mono break-all">
          {secret}
        </code>
      </div>
      <p className="text-sm text-zinc-400 mb-6">
        Use this secret to verify webhook signatures. Store it securely in your environment variables.
      </p>
      <div className="flex justify-end">
        <button
          onClick={onClose}
          className="rounded-lg bg-orange-500 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-600 transition-colors"
        >
          Done
        </button>
      </div>
    </>
  );
}

interface CreateEditPanelProps {
  isEditing: boolean;
  formData: WebhookFormData;
  error: string | null;
  isSubmitting: boolean;
  onClose: () => void;
  onSubmit: () => void;
  onChangeName: (name: string) => void;
  onChangeUrl: (url: string) => void;
  onToggleEvent: (event: WebhookEvent) => void;
}

/**
 * Form panel for create/edit. Renders the three fields (name, URL,
 * event picker) and the submit/cancel actions.
 */
function CreateEditPanel({
  isEditing,
  formData,
  error,
  isSubmitting,
  onClose,
  onSubmit,
  onChangeName,
  onChangeUrl,
  onToggleEvent,
}: CreateEditPanelProps) {
  const submittable = isFormSubmittable(formData);

  return (
    <>
      <h2 className="text-lg font-semibold text-zinc-100 mb-6">
        {isEditing ? 'Edit Webhook' : 'Create Webhook'}
      </h2>

      {error && (
        <div className="mb-4 rounded-lg bg-red-500/10 border border-red-500/30 px-4 py-3">
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      <div className="space-y-5">
        <div>
          <label htmlFor="webhook-name" className="block text-sm font-medium text-zinc-300 mb-1.5">
            Name
          </label>
          <input
            id="webhook-name"
            type="text"
            value={formData.name}
            onChange={(e) => onChangeName(e.target.value)}
            placeholder="e.g., Slack Notifications"
            className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500"
            maxLength={100}
          />
        </div>

        <div>
          <label htmlFor="webhook-url" className="block text-sm font-medium text-zinc-300 mb-1.5">
            Endpoint URL
          </label>
          <input
            id="webhook-url"
            type="url"
            value={formData.url}
            onChange={(e) => onChangeUrl(e.target.value)}
            placeholder="https://..."
            className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500"
          />
          <p className="mt-1 text-xs text-zinc-500">Must be HTTPS for production use</p>
        </div>

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
                  onClick={() => onToggleEvent(event.value)}
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
                        <svg
                          className="h-3 w-3 text-white"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                          aria-hidden="true"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={3}
                            d="M5 13l4 4L19 7"
                          />
                        </svg>
                      )}
                    </div>
                    <div>
                      <p
                        className={`text-sm font-medium ${
                          isSelected ? 'text-orange-300' : 'text-zinc-300'
                        }`}
                      >
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
          disabled={isSubmitting || !submittable}
          className="rounded-lg bg-orange-500 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
        >
          {isSubmitting && (
            <div
              className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white"
              aria-hidden="true"
            />
          )}
          {isEditing ? 'Save Changes' : 'Create Webhook'}
        </button>
      </div>
    </>
  );
}
