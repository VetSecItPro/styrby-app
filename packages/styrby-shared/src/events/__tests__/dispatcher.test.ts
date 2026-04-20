/**
 * Tests for the EventDispatcher (Phase 0.10).
 *
 * Uses {@link RecordingSink} so the tests stay fully in-memory and assert
 * on the validated envelope rather than any specific transport.
 *
 * @module events/__tests__/dispatcher
 */

import { describe, it, expect } from 'vitest';
import { ZodError } from 'zod';
import { EventDispatcher, RecordingSink } from '../dispatcher.js';
import { EVENT_REGISTRY } from '../registry.js';

const isoNow = () => new Date().toISOString();
const uuid = () => '11111111-2222-3333-4444-555555555555';

describe('EventDispatcher', () => {
  it('validates and delivers a session.created event', async () => {
    const sink = new RecordingSink();
    const dispatcher = new EventDispatcher({ sink });

    const result = await dispatcher.dispatch('session.created', {
      sessionId: uuid(),
      userId: uuid(),
      agentType: 'claude',
      startedAt: isoNow(),
    });

    expect(result.ok).toBe(true);
    expect(sink.received).toHaveLength(1);
    expect(sink.received[0].type).toBe('session.created');
    expect(sink.received[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(sink.received[0].occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('throws ZodError when payload does not match the schema', async () => {
    const dispatcher = new EventDispatcher({ sink: new RecordingSink() });

    await expect(
      dispatcher.dispatch('session.created', {
        // missing required fields
        sessionId: 'not-a-uuid',
      } as never),
    ).rejects.toBeInstanceOf(ZodError);
  });

  it('throws on unknown event type', async () => {
    const dispatcher = new EventDispatcher({ sink: new RecordingSink() });
    await expect(
      dispatcher.dispatch('not.a.real.event' as never, {} as never),
    ).rejects.toThrow(/unknown event type/);
  });

  it('logs delivery failure when sink returns ok:false', async () => {
    const failingSink = {
      async deliver() {
        return { ok: false, detail: 'http 500' };
      },
    };
    const warnings: Array<{ msg: string }> = [];
    const logger = {
      info: () => {},
      warn: (msg: string) => warnings.push({ msg }),
      error: () => {},
    };
    const dispatcher = new EventDispatcher({ sink: failingSink, logger });

    const result = await dispatcher.dispatch('tool.approved', {
      sessionId: uuid(),
      userId: uuid(),
      toolName: 'Read',
      approvedAt: isoNow(),
      approvalSource: 'user',
    });

    expect(result.ok).toBe(false);
    expect(warnings.some((w) => w.msg === 'event.delivery_failed')).toBe(true);
  });

  it('the registry covers the five Phase 0.10 event types', () => {
    expect(Object.keys(EVENT_REGISTRY).sort()).toEqual([
      'budget.threshold_hit',
      'cost.weekly_summary',
      'session.completed',
      'session.created',
      'tool.approved',
    ]);
  });
});
