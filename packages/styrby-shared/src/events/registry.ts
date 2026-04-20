/**
 * Event Registry (Phase 0.10).
 *
 * Central catalog of every event type the system can emit to webhooks and
 * realtime subscribers. Holding this in one place — versioned and zod-typed —
 * lets us:
 *
 * 1. Audit every event surface in a single grep (SOC2 CC7.2 logging).
 * 2. Generate webhook documentation from a single source of truth.
 * 3. Enforce payload shape at the dispatch boundary so downstream consumers
 *    never see malformed events.
 *
 * @module events/registry
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Per-event Zod schemas
//
// WHY zod (not bare interfaces): we validate at runtime before delivery so
// a developer who silently changes a webhook payload cannot ship the change
// without breaking a test. The static type is inferred from the schema.
// ---------------------------------------------------------------------------

/** `session.created` — emitted when a new agent session is started. */
export const SessionCreatedPayload = z.object({
  sessionId: z.string().uuid(),
  userId: z.string().uuid(),
  agentType: z.string(),
  startedAt: z.string().datetime(),
  projectPath: z.string().optional(),
});
export type SessionCreatedPayload = z.infer<typeof SessionCreatedPayload>;

/** `session.completed` — emitted when an agent session ends (success or error). */
export const SessionCompletedPayload = z.object({
  sessionId: z.string().uuid(),
  userId: z.string().uuid(),
  durationMs: z.number().nonnegative(),
  status: z.enum(['completed', 'error', 'cancelled']),
  totalCostUsd: z.number().nonnegative(),
  totalTokens: z.number().nonnegative(),
});
export type SessionCompletedPayload = z.infer<typeof SessionCompletedPayload>;

/** `tool.approved` — emitted when a user approves an agent tool invocation. */
export const ToolApprovedPayload = z.object({
  sessionId: z.string().uuid(),
  userId: z.string().uuid(),
  toolName: z.string(),
  approvedAt: z.string().datetime(),
  approvalSource: z.enum(['user', 'auto', 'pre-approved']),
});
export type ToolApprovedPayload = z.infer<typeof ToolApprovedPayload>;

/** `budget.threshold_hit` — emitted when a user crosses a configured budget threshold. */
export const BudgetThresholdHitPayload = z.object({
  userId: z.string().uuid(),
  alertId: z.string().uuid(),
  thresholdUsd: z.number().nonnegative(),
  currentSpendUsd: z.number().nonnegative(),
  windowStart: z.string().datetime(),
  windowEnd: z.string().datetime(),
  action: z.enum(['notify', 'slowdown', 'stop']),
});
export type BudgetThresholdHitPayload = z.infer<typeof BudgetThresholdHitPayload>;

/** `cost.weekly_summary` — emitted by the weekly summary cron. */
export const CostWeeklySummaryPayload = z.object({
  userId: z.string().uuid(),
  weekStart: z.string().datetime(),
  weekEnd: z.string().datetime(),
  totalCostUsd: z.number().nonnegative(),
  sessionCount: z.number().nonnegative(),
  topAgent: z.string(),
});
export type CostWeeklySummaryPayload = z.infer<typeof CostWeeklySummaryPayload>;

// ---------------------------------------------------------------------------
// Registry — the single source of truth
// ---------------------------------------------------------------------------

/**
 * Map of event type → Zod schema. Adding a new event MUST add an entry
 * here; the dispatcher refuses to deliver event types that are not
 * registered.
 */
export const EVENT_REGISTRY = {
  'session.created': SessionCreatedPayload,
  'session.completed': SessionCompletedPayload,
  'tool.approved': ToolApprovedPayload,
  'budget.threshold_hit': BudgetThresholdHitPayload,
  'cost.weekly_summary': CostWeeklySummaryPayload,
} as const;

/** Union of every registered event type. */
export type EventType = keyof typeof EVENT_REGISTRY;

/** Helper: payload type for a given event type. */
export type EventPayloadFor<T extends EventType> = z.infer<(typeof EVENT_REGISTRY)[T]>;

/**
 * The full envelope that webhook subscribers receive on every event.
 * Includes a non-payload metadata layer (event id, type, occurred_at).
 */
export interface EventEnvelope<T extends EventType = EventType> {
  /** Stable per-event UUID — useful for idempotency on the receiver side. */
  id: string;
  /** Registered event type (`session.created`, …). */
  type: T;
  /** ISO 8601 timestamp when the event occurred (set by dispatcher). */
  occurredAt: string;
  /** The validated payload; shape depends on `type`. */
  payload: EventPayloadFor<T>;
}
