import { describe, expect, it, vi } from 'vitest';
import type { SessionNotification } from '@agentclientprotocol/sdk';
import { dispatchSessionUpdate } from '../sessionUpdateDispatcher';
import type { HandlerContext } from '../sessionUpdateHandlers';
import type { TransportHandler } from '../../transport';

/**
 * dispatchSessionUpdate is the routing layer between raw ACP notifications
 * and the per-type handlers. We verify routing correctness without re-testing
 * the handler internals (those are covered by sessionUpdateHandlers.test.ts).
 */

function makeCtx(overrides: Partial<HandlerContext> = {}): HandlerContext {
  const transport: TransportHandler = {
    agentName: 'test',
    getInitTimeout: () => 1000,
  } as TransportHandler;
  return {
    transport,
    activeToolCalls: new Set(),
    toolCallStartTimes: new Map(),
    toolCallTimeouts: new Map(),
    toolCallIdToNameMap: new Map(),
    idleTimeout: null,
    toolCallCountSincePrompt: 0,
    emit: vi.fn(),
    emitIdleStatus: vi.fn(),
    clearIdleTimeout: vi.fn(),
    setIdleTimeout: vi.fn(),
    ...overrides,
  };
}

function makeNotification(update: Record<string, unknown> | undefined): SessionNotification {
  return { sessionId: 's1', update } as unknown as SessionNotification;
}

describe('dispatchSessionUpdate', () => {
  it('returns empty result and emits nothing when notification has no update field', () => {
    const ctx = makeCtx();
    const result = dispatchSessionUpdate(makeNotification(undefined), ctx);
    expect(result).toEqual({});
    expect(ctx.emit).not.toHaveBeenCalled();
  });

  it('routes agent_message_chunk to the chunk handler (resets idle timer)', () => {
    const ctx = makeCtx();
    const result = dispatchSessionUpdate(
      makeNotification({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'hello' },
      }),
      ctx
    );
    expect(result).toEqual({});
    // The chunk handler emits a message and arms an idle timeout.
    expect(ctx.emit).toHaveBeenCalled();
    expect(ctx.setIdleTimeout).toHaveBeenCalled();
  });

  it('routes tool_call_update and surfaces toolCallCountSincePrompt back to caller', () => {
    const ctx = makeCtx({
      activeToolCalls: new Set(['call-1']),
      toolCallIdToNameMap: new Map([['call-1', 'shell']]),
      toolCallStartTimes: new Map([['call-1', Date.now()]]),
    });
    const result = dispatchSessionUpdate(
      makeNotification({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-1',
        status: 'completed',
      }),
      ctx
    );
    // Either undefined (handler made no change) or a number — but the key
    // must be present in the dispatcher's response shape regardless.
    expect(result).toHaveProperty('toolCallCountSincePrompt');
  });

  it('routes agent_thought_chunk without surfacing tool-call state', () => {
    const ctx = makeCtx();
    const result = dispatchSessionUpdate(
      makeNotification({
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'thinking' },
      }),
      ctx
    );
    expect(result).toEqual({});
  });

  it('routes tool_call to the tool-call handler', () => {
    const ctx = makeCtx();
    const result = dispatchSessionUpdate(
      makeNotification({
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-1',
        kind: 'read',
        content: {},
      }),
      ctx
    );
    expect(result).toEqual({});
    // tool_call handler emits at least one message.
    expect(ctx.emit).toHaveBeenCalled();
  });

  it('falls through to legacy/plan/thinking handlers for unknown update types', () => {
    const ctx = makeCtx();
    // No primary type matches → all three legacy handlers are invoked.
    // None of them emit when their respective fields are absent, so this
    // should be a clean no-op that simply logs.
    const result = dispatchSessionUpdate(
      makeNotification({ sessionUpdate: 'totally_unknown' }),
      ctx
    );
    expect(result).toEqual({});
    expect(ctx.emit).not.toHaveBeenCalled();
  });
});
