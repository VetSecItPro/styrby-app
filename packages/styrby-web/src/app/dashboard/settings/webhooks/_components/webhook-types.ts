/**
 * Webhook Domain Types and Constants
 *
 * Co-located with the webhooks settings page since these types are only
 * consumed by the webhooks client tree. If/when other features (e.g. mobile
 * client, edge functions) need them, promote to packages/styrby-shared.
 *
 * WHY co-location: Avoids cross-app type drift while these UI shapes are
 * still in flux. The DB row shape itself lives in the Supabase schema and
 * is mirrored here for the client component layer.
 */

// ---------------------------------------------------------------------------
// Domain Types
// ---------------------------------------------------------------------------

/** Valid webhook event types emitted by the Styrby backend. */
export type WebhookEvent =
  | 'session.started'
  | 'session.completed'
  | 'budget.exceeded'
  | 'permission.requested';

/**
 * Webhook row as returned from the Supabase `webhooks` table.
 *
 * Mirrors the DB schema shape — keep in sync with
 * supabase/migrations defining the `webhooks` table.
 */
export interface Webhook {
  /** Unique identifier (UUID). */
  id: string;
  /** Human-readable name shown in the UI. */
  name: string;
  /** HTTPS endpoint receiving signed payloads. */
  url: string;
  /** Subscribed events; stored as `text[]` in Postgres. */
  events: string[];
  /** Whether the webhook actively delivers events. */
  is_active: boolean;
  /** ISO timestamp of last 2xx delivery, null if never. */
  last_success_at: string | null;
  /** ISO timestamp of last failed delivery, null if never. */
  last_failure_at: string | null;
  /** Consecutive failures since the last success; drives the failure badge. */
  consecutive_failures: number;
  /** ISO timestamp when the webhook was created. */
  created_at: string;
  /** ISO timestamp when the webhook was last modified. */
  updated_at: string;
}

/**
 * A single delivery attempt log row used by the delivery log modal.
 */
export interface WebhookDelivery {
  id: string;
  event: string;
  status: string;
  attempts: number;
  response_status: number | null;
  error_message: string | null;
  duration_ms: number | null;
  created_at: string;
}

/** Form state for the create/edit modal. */
export interface WebhookFormData {
  name: string;
  url: string;
  events: WebhookEvent[];
}

/** Inline toast for test-event feedback. */
export interface WebhookTestMessage {
  type: 'success' | 'error';
  text: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Event metadata shown in the create/edit form.
 *
 * WHY array (not map): Render order is significant in the UI — showing
 * session lifecycle events before alert events matches the user's mental
 * model of "what happens, then what to alert on".
 */
export const EVENT_OPTIONS: ReadonlyArray<{
  value: WebhookEvent;
  label: string;
  description: string;
}> = [
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
 * Tailwind color classes for each event badge.
 *
 * WHY paired bg/text: Each badge needs both a tinted background and an
 * accent text color. Bundling them prevents typo drift between the two.
 */
export const EVENT_COLORS: Record<WebhookEvent, { bg: string; text: string }> = {
  'session.started': { bg: 'bg-green-500/10', text: 'text-green-400' },
  'session.completed': { bg: 'bg-blue-500/10', text: 'text-blue-400' },
  'budget.exceeded': { bg: 'bg-orange-500/10', text: 'text-orange-400' },
  'permission.requested': { bg: 'bg-purple-500/10', text: 'text-purple-400' },
};

/** Fallback colors for any unknown event string in `webhook.events`. */
export const FALLBACK_EVENT_COLORS = {
  bg: 'bg-zinc-500/10',
  text: 'text-zinc-400',
} as const;

/** Initial value for the create/edit form. */
export const DEFAULT_FORM_DATA: WebhookFormData = {
  name: '',
  url: '',
  events: [],
};
