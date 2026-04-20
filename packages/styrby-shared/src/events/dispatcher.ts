/**
 * Event Dispatcher (Phase 0.10).
 *
 * Centralised enqueue + delivery for system events. Replaces the inline
 * webhook delivery code that used to live in `app/api/webhooks/user/route.ts`.
 *
 * Design goals:
 * - **Validate at the boundary.** Every payload is parsed by the registered
 *   Zod schema before delivery; malformed events throw at enqueue time so
 *   the bug surfaces in tests, not in production webhook receivers.
 * - **Pluggable delivery sink.** The dispatcher delegates the actual HTTP /
 *   queue write to an injected `EventDeliverySink` so the same dispatcher
 *   works in web (HTTP POST), edge functions (Supabase queue), and tests
 *   (in-memory recorder).
 * - **Audit trail.** Every dispatch logs `{eventId, type, deliveryStatus}`
 *   via the injected logger so SOC2 CC7.2 (system operations) has a
 *   complete event audit trail.
 *
 * @module events/dispatcher
 */

import { randomUUID } from 'crypto';
import {
  EVENT_REGISTRY,
  type EventEnvelope,
  type EventPayloadFor,
  type EventType,
} from './registry.js';

/**
 * Sink contract for delivering events. Implementations include:
 * - HTTP webhook delivery (web)
 * - Supabase queue insert (edge function)
 * - In-memory recorder (tests)
 */
export interface EventDeliverySink {
  /**
   * Deliver one event envelope. Implementations should be idempotent on
   * `envelope.id` (if the receiver tracks delivery state) and should not
   * throw on transient failures — return a result object instead.
   */
  deliver<T extends EventType>(envelope: EventEnvelope<T>): Promise<EventDeliveryResult>;
}

/** Result of a single delivery attempt. */
export interface EventDeliveryResult {
  /** True if the sink accepted the event. */
  ok: boolean;
  /** Optional human description (HTTP status, queue id, error message). */
  detail?: string;
}

/** Minimal logger contract so dispatcher does not depend on a specific impl. */
export interface EventLogger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

const NOOP_LOGGER: EventLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * Centralised event dispatcher. Instantiate once per process and inject
 * the appropriate {@link EventDeliverySink} for the runtime environment.
 *
 * @example
 * ```ts
 * const dispatcher = new EventDispatcher({ sink: new HttpWebhookSink() });
 * await dispatcher.dispatch('session.created', {
 *   sessionId: '...',
 *   userId: '...',
 *   agentType: 'claude',
 *   startedAt: new Date().toISOString(),
 * });
 * ```
 */
export class EventDispatcher {
  private readonly sink: EventDeliverySink;
  private readonly logger: EventLogger;

  constructor(opts: { sink: EventDeliverySink; logger?: EventLogger }) {
    this.sink = opts.sink;
    this.logger = opts.logger ?? NOOP_LOGGER;
  }

  /**
   * Validate, envelope, and deliver an event.
   *
   * @param type - One of the registered event types.
   * @param payload - The payload; must match the registered schema.
   * @returns The delivery result returned by the sink.
   * @throws ZodError if `payload` does not match the registered schema.
   */
  async dispatch<T extends EventType>(
    type: T,
    payload: EventPayloadFor<T>,
  ): Promise<EventDeliveryResult> {
    const schema = EVENT_REGISTRY[type];
    if (!schema) {
      throw new Error(`EventDispatcher: unknown event type "${type}"`);
    }

    // Validate at the boundary. Throws ZodError on bad payload.
    const validated = schema.parse(payload) as EventPayloadFor<T>;

    const envelope: EventEnvelope<T> = {
      id: randomUUID(),
      type,
      occurredAt: new Date().toISOString(),
      payload: validated,
    };

    const result = await this.sink.deliver(envelope);
    if (result.ok) {
      this.logger.info('event.dispatched', {
        eventId: envelope.id,
        type,
        detail: result.detail,
      });
    } else {
      this.logger.warn('event.delivery_failed', {
        eventId: envelope.id,
        type,
        detail: result.detail,
      });
    }
    return result;
  }
}

/**
 * In-memory delivery sink for tests. Stores every dispatched envelope so
 * test assertions can introspect the delivery stream without standing up
 * an HTTP server.
 */
export class RecordingSink implements EventDeliverySink {
  /** Every envelope received, in dispatch order. */
  public readonly received: EventEnvelope[] = [];

  async deliver<T extends EventType>(envelope: EventEnvelope<T>): Promise<EventDeliveryResult> {
    this.received.push(envelope);
    return { ok: true, detail: 'recorded' };
  }
}
