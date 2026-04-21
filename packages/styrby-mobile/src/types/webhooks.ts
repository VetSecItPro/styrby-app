/**
 * Webhook Domain Types
 *
 * Shared types used by the webhooks orchestrator screen and its
 * sub-components in `src/components/webhooks/`.
 *
 * WHY a dedicated type module:
 * Per the project's "Component-First Architecture" rule, shared types must not
 * live inline in page files. The hook `useWebhooks` is the canonical source of
 * the schema-derived types; this module re-exports them under a stable
 * domain-oriented module path so UI components do not need to reach into the
 * hooks layer to import a type.
 */

export type {
  Webhook,
  WebhookEvent,
  WebhookDelivery,
  CreateWebhookInput,
  UpdateWebhookInput,
  UseWebhooksResult,
} from '../hooks/useWebhooks';
