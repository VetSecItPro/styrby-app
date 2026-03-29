/**
 * Tests for agent/acp/sessionUpdateHandlers.ts
 *
 * Covers all exported pure functions and the handler functions:
 * - parseArgsFromContent: array, object, null, primitives
 * - extractErrorDetail: string, object with error field, nested error.message,
 *   status/reason fallback, array fallback, null/undefined
 * - formatDuration: with startTime, undefined startTime
 * - formatDurationMinutes: with startTime, undefined startTime
 * - handleAgentMessageChunk: thinking vs. model-output, idle timeout management
 * - handleAgentThoughtChunk: emits thinking event
 * - handleToolCallUpdate: in_progress, completed, failed, cancelled, no toolCallId
 * - handleToolCall: in_progress, duplicate, no toolCallId
 * - handleLegacyMessageChunk: textDelta present, absent, no messageChunk
 * - handlePlanUpdate: with plan, without plan
 * - handleThinkingUpdate: with thinking, without thinking
 * - Constants: DEFAULT_IDLE_TIMEOUT_MS, DEFAULT_TOOL_CALL_TIMEOUT_MS
 *
 * WHY: These handlers are the heart of real-time agent communication. Bugs
 * in tool-call tracking cause "stuck" UI states on mobile (spinner that
 * never stops). Testing each status transition explicitly catches regressions
 * when ACP protocol versions change.
 *
 * @module agent/acp/__tests__/sessionUpdateHandlers
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentMessage } from '../../core';
import type { TransportHandler } from '../../transport';
import {
  parseArgsFromContent,
  extractErrorDetail,
  formatDuration,
  formatDurationMinutes,
  handleAgentMessageChunk,
  handleAgentThoughtChunk,
  handleToolCallUpdate,
  handleToolCall,
  handleLegacyMessageChunk,
  handlePlanUpdate,
  handleThinkingUpdate,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_TOOL_CALL_TIMEOUT_MS,
  type SessionUpdate,
  type HandlerContext,
} from '../sessionUpdateHandlers';

// ============================================================================
// Mocks
// ============================================================================

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ============================================================================
// Helpers
// ============================================================================

/**
 * Create a minimal HandlerContext with all dependencies mocked.
 * Tests that need specific behavior can override individual properties.
 */
function makeContext(overrides: Partial<HandlerContext> = {}): HandlerContext {
  return {
    transport: {
      getIdleTimeout: vi.fn(() => DEFAULT_IDLE_TIMEOUT_MS),
      getToolCallTimeout: vi.fn(() => DEFAULT_TOOL_CALL_TIMEOUT_MS),
      isInvestigationTool: vi.fn(() => false),
      extractToolNameFromId: vi.fn(() => undefined),
    } as unknown as TransportHandler,
    activeToolCalls: new Set<string>(),
    toolCallStartTimes: new Map<string, number>(),
    toolCallTimeouts: new Map<string, NodeJS.Timeout>(),
    toolCallIdToNameMap: new Map<string, string>(),
    idleTimeout: null,
    toolCallCountSincePrompt: 0,
    emit: vi.fn(),
    emitIdleStatus: vi.fn(),
    clearIdleTimeout: vi.fn(),
    setIdleTimeout: vi.fn(),
    ...overrides,
  };
}

/**
 * Collect all messages passed to ctx.emit into a typed array.
 *
 * @param ctx - Handler context with mocked emit
 */
function getEmitted(ctx: HandlerContext): AgentMessage[] {
  return (ctx.emit as ReturnType<typeof vi.fn>).mock.calls.map(
    ([msg]: [AgentMessage]) => msg
  );
}

// ============================================================================
// Constants
// ============================================================================

describe('constants', () => {
  it('DEFAULT_IDLE_TIMEOUT_MS is 500', () => {
    expect(DEFAULT_IDLE_TIMEOUT_MS).toBe(500);
  });

  it('DEFAULT_TOOL_CALL_TIMEOUT_MS is 120000', () => {
    expect(DEFAULT_TOOL_CALL_TIMEOUT_MS).toBe(120_000);
  });
});

// ============================================================================
// parseArgsFromContent
// ============================================================================

describe('parseArgsFromContent', () => {
  it('wraps an array in { items: [...] }', () => {
    const result = parseArgsFromContent([1, 2, 3]);

    expect(result).toEqual({ items: [1, 2, 3] });
  });

  it('returns a plain object as-is', () => {
    const obj = { foo: 'bar', count: 42 };
    const result = parseArgsFromContent(obj);

    expect(result).toEqual(obj);
  });

  it('returns empty object for null', () => {
    expect(parseArgsFromContent(null)).toEqual({});
  });

  it('returns empty object for undefined', () => {
    expect(parseArgsFromContent(undefined)).toEqual({});
  });

  it('returns empty object for a string', () => {
    expect(parseArgsFromContent('not an object')).toEqual({});
  });

  it('returns empty object for a number', () => {
    expect(parseArgsFromContent(42)).toEqual({});
  });

  it('returns empty object for a boolean', () => {
    expect(parseArgsFromContent(true)).toEqual({});
  });

  it('returns the object for nested objects', () => {
    const nested = { a: { b: { c: 'deep' } } };
    expect(parseArgsFromContent(nested)).toEqual(nested);
  });

  it('handles an empty array', () => {
    expect(parseArgsFromContent([])).toEqual({ items: [] });
  });

  it('handles an empty object', () => {
    expect(parseArgsFromContent({})).toEqual({});
  });
});

// ============================================================================
// extractErrorDetail
// ============================================================================

describe('extractErrorDetail', () => {
  it('returns undefined for null', () => {
    expect(extractErrorDetail(null)).toBeUndefined();
  });

  it('returns undefined for undefined', () => {
    expect(extractErrorDetail(undefined)).toBeUndefined();
  });

  it('returns the string directly when content is a string', () => {
    expect(extractErrorDetail('Error: something went wrong')).toBe(
      'Error: something went wrong'
    );
  });

  it('returns obj.error when it is a string', () => {
    expect(extractErrorDetail({ error: 'permission denied' })).toBe('permission denied');
  });

  it('returns obj.error.message when error is an object with message', () => {
    expect(extractErrorDetail({ error: { message: 'rate limit exceeded' } })).toBe(
      'rate limit exceeded'
    );
  });

  it('JSON-stringifies error when it is an object without message', () => {
    const result = extractErrorDetail({ error: { code: 429, details: 'quota' } });

    expect(result).toBe(JSON.stringify({ code: 429, details: 'quota' }));
  });

  it('returns obj.message when there is no error field', () => {
    expect(extractErrorDetail({ message: 'unexpected EOF' })).toBe('unexpected EOF');
  });

  it('returns obj.status as fallback', () => {
    expect(extractErrorDetail({ status: 'failed', unknownField: true })).toBe('failed');
  });

  it('returns obj.reason as fallback when status is absent', () => {
    expect(extractErrorDetail({ reason: 'timeout' })).toBe('timeout');
  });

  it('JSON-stringifies the object when no known fields are present', () => {
    const obj = { unknownKey: 'unknownValue' };
    const result = extractErrorDetail(obj);

    expect(result).toBe(JSON.stringify(obj));
  });

  it('truncates JSON stringify to 500 characters for large objects', () => {
    const large = { data: 'x'.repeat(1000) };
    const result = extractErrorDetail(large);

    expect(result!.length).toBeLessThanOrEqual(500);
  });

  it('returns undefined for an empty string (falsy)', () => {
    expect(extractErrorDetail('')).toBeUndefined();
  });

  it('returns undefined for arrays (treated as no-match path, falls back to JSON stringify)', () => {
    // Arrays are objects but the function only matches non-array objects for field extraction
    const result = extractErrorDetail([1, 2, 3]);
    // Arrays are not objects that match the inner branch — expect undefined per the code
    expect(result).toBeUndefined();
  });
});

// ============================================================================
// formatDuration
// ============================================================================

describe('formatDuration', () => {
  it('returns "unknown" when startTime is undefined', () => {
    expect(formatDuration(undefined)).toBe('unknown');
  });

  it('returns a string ending in "s"', () => {
    const startTime = Date.now() - 2500;
    const result = formatDuration(startTime);

    expect(result).toMatch(/^\d+\.\d+s$/);
  });

  it('returns approximately the correct duration', () => {
    const startTime = Date.now() - 3000;
    const result = formatDuration(startTime);

    const seconds = parseFloat(result.replace('s', ''));
    expect(seconds).toBeGreaterThanOrEqual(2.9);
    expect(seconds).toBeLessThan(3.5);
  });

  it('formats sub-second durations correctly', () => {
    const startTime = Date.now() - 250;
    const result = formatDuration(startTime);

    const seconds = parseFloat(result.replace('s', ''));
    expect(seconds).toBeGreaterThanOrEqual(0.2);
    expect(seconds).toBeLessThan(0.6);
  });
});

// ============================================================================
// formatDurationMinutes
// ============================================================================

describe('formatDurationMinutes', () => {
  it('returns "unknown" when startTime is undefined', () => {
    expect(formatDurationMinutes(undefined)).toBe('unknown');
  });

  it('returns a string representing minutes as a decimal', () => {
    const startTime = Date.now() - 90_000; // 1.5 minutes
    const result = formatDurationMinutes(startTime);

    const minutes = parseFloat(result);
    expect(minutes).toBeGreaterThanOrEqual(1.4);
    expect(minutes).toBeLessThan(1.7);
  });

  it('formats sub-minute durations as a small decimal', () => {
    const startTime = Date.now() - 30_000; // 30 seconds
    const result = formatDurationMinutes(startTime);

    const minutes = parseFloat(result);
    expect(minutes).toBeGreaterThanOrEqual(0.4);
    expect(minutes).toBeLessThan(0.6);
  });
});

// ============================================================================
// handleAgentMessageChunk
// ============================================================================

describe('handleAgentMessageChunk', () => {
  it('returns handled=false when content is missing', () => {
    const ctx = makeContext();
    const result = handleAgentMessageChunk({}, ctx);

    expect(result.handled).toBe(false);
  });

  it('returns handled=false when content has no text property', () => {
    const ctx = makeContext();
    const result = handleAgentMessageChunk({ content: { other: 'data' } }, ctx);

    expect(result.handled).toBe(false);
  });

  it('returns handled=false when content.text is not a string', () => {
    const ctx = makeContext();
    const result = handleAgentMessageChunk({ content: { text: 42 } }, ctx);

    expect(result.handled).toBe(false);
  });

  it('emits model-output for regular text', () => {
    const ctx = makeContext();
    const update: SessionUpdate = { content: { text: 'Here is the answer.' } };

    const result = handleAgentMessageChunk(update, ctx);

    expect(result.handled).toBe(true);
    const messages = getEmitted(ctx);
    const output = messages.find((m) => m.type === 'model-output');
    expect(output).toBeDefined();
    expect((output as { type: 'model-output'; textDelta: string }).textDelta).toBe(
      'Here is the answer.'
    );
  });

  it('emits thinking event for text matching **...**\\n pattern', () => {
    const ctx = makeContext();
    const update: SessionUpdate = { content: { text: '**Thinking step**\nMore content' } };

    handleAgentMessageChunk(update, ctx);

    const messages = getEmitted(ctx);
    const thinking = messages.find((m) => m.type === 'event');
    expect(thinking).toBeDefined();
    expect((thinking as { type: 'event'; name: string }).name).toBe('thinking');
  });

  it('calls clearIdleTimeout then setIdleTimeout for non-thinking text', () => {
    const ctx = makeContext();
    handleAgentMessageChunk({ content: { text: 'response text' } }, ctx);

    expect(ctx.clearIdleTimeout).toHaveBeenCalled();
    expect(ctx.setIdleTimeout).toHaveBeenCalled();
  });

  it('does not call setIdleTimeout for thinking text', () => {
    const ctx = makeContext();
    handleAgentMessageChunk({ content: { text: '**Think**\nstep' } }, ctx);

    expect(ctx.setIdleTimeout).not.toHaveBeenCalled();
  });

  it('idle timeout callback emits idle when no active tool calls', () => {
    const ctx = makeContext();
    // Capture the idle timeout callback
    let capturedCallback: (() => void) | null = null;
    (ctx.setIdleTimeout as ReturnType<typeof vi.fn>).mockImplementation(
      (cb: () => void) => { capturedCallback = cb; }
    );

    handleAgentMessageChunk({ content: { text: 'text' } }, ctx);

    expect(capturedCallback).not.toBeNull();
    capturedCallback!();

    expect(ctx.emitIdleStatus).toHaveBeenCalled();
  });

  it('idle timeout callback does NOT emit idle when tool calls are active', () => {
    const ctx = makeContext();
    ctx.activeToolCalls.add('tool-call-001');

    let capturedCallback: (() => void) | null = null;
    (ctx.setIdleTimeout as ReturnType<typeof vi.fn>).mockImplementation(
      (cb: () => void) => { capturedCallback = cb; }
    );

    handleAgentMessageChunk({ content: { text: 'text' } }, ctx);
    capturedCallback!();

    expect(ctx.emitIdleStatus).not.toHaveBeenCalled();
  });
});

// ============================================================================
// handleAgentThoughtChunk
// ============================================================================

describe('handleAgentThoughtChunk', () => {
  it('returns handled=false when content is missing', () => {
    const ctx = makeContext();
    expect(handleAgentThoughtChunk({}, ctx).handled).toBe(false);
  });

  it('returns handled=false when content.text is not a string', () => {
    const ctx = makeContext();
    expect(handleAgentThoughtChunk({ content: { text: 123 } }, ctx).handled).toBe(false);
  });

  it('emits thinking event with text payload', () => {
    const ctx = makeContext();
    handleAgentThoughtChunk({ content: { text: 'I am thinking...' } }, ctx);

    const messages = getEmitted(ctx);
    const thinking = messages.find((m) => m.type === 'event') as { type: 'event'; name: string; payload: { text: string } } | undefined;

    expect(thinking).toBeDefined();
    expect(thinking!.name).toBe('thinking');
    expect(thinking!.payload.text).toBe('I am thinking...');
  });

  it('returns handled=true on success', () => {
    const ctx = makeContext();
    const result = handleAgentThoughtChunk({ content: { text: 'thought' } }, ctx);

    expect(result.handled).toBe(true);
  });
});

// ============================================================================
// handleToolCallUpdate
// ============================================================================

describe('handleToolCallUpdate', () => {
  it('returns handled=false when toolCallId is missing', () => {
    const ctx = makeContext();
    const result = handleToolCallUpdate({ status: 'in_progress' }, ctx);

    expect(result.handled).toBe(false);
  });

  it('adds tool call to activeToolCalls on in_progress status', () => {
    const ctx = makeContext();
    handleToolCallUpdate(
      { toolCallId: 'tc-001', status: 'in_progress', kind: 'bash' },
      ctx
    );

    expect(ctx.activeToolCalls.has('tc-001')).toBe(true);
  });

  it('adds tool call to activeToolCalls on pending status', () => {
    const ctx = makeContext();
    handleToolCallUpdate(
      { toolCallId: 'tc-002', status: 'pending', kind: 'read_file' },
      ctx
    );

    expect(ctx.activeToolCalls.has('tc-002')).toBe(true);
  });

  it('increments toolCallCountSincePrompt for new tool calls', () => {
    const ctx = makeContext();
    const result = handleToolCallUpdate(
      { toolCallId: 'tc-003', status: 'in_progress', kind: 'bash' },
      ctx
    );

    expect(result.toolCallCountSincePrompt).toBe(1);
  });

  it('does not double-count an already-tracked tool call', () => {
    const ctx = makeContext();
    ctx.activeToolCalls.add('tc-004');

    const result = handleToolCallUpdate(
      { toolCallId: 'tc-004', status: 'in_progress', kind: 'bash' },
      ctx
    );

    // Count should not increase because tc-004 was already tracked
    expect(result.toolCallCountSincePrompt).toBe(0);
  });

  it('removes tool call from activeToolCalls on completed status', () => {
    const ctx = makeContext();
    ctx.activeToolCalls.add('tc-005');
    ctx.toolCallStartTimes.set('tc-005', Date.now() - 100);

    handleToolCallUpdate({ toolCallId: 'tc-005', status: 'completed', kind: 'bash' }, ctx);

    expect(ctx.activeToolCalls.has('tc-005')).toBe(false);
  });

  it('emits tool-result message on completed status', () => {
    const ctx = makeContext();
    ctx.activeToolCalls.add('tc-006');
    ctx.toolCallStartTimes.set('tc-006', Date.now() - 100);

    handleToolCallUpdate(
      { toolCallId: 'tc-006', status: 'completed', kind: 'bash', content: { output: 'done' } },
      ctx
    );

    const messages = getEmitted(ctx);
    const result = messages.find((m) => m.type === 'tool-result');
    expect(result).toBeDefined();
  });

  it('removes tool call from activeToolCalls on failed status', () => {
    const ctx = makeContext();
    ctx.activeToolCalls.add('tc-007');
    ctx.toolCallStartTimes.set('tc-007', Date.now() - 100);

    handleToolCallUpdate({ toolCallId: 'tc-007', status: 'failed', kind: 'bash' }, ctx);

    expect(ctx.activeToolCalls.has('tc-007')).toBe(false);
  });

  it('removes tool call from activeToolCalls on cancelled status', () => {
    const ctx = makeContext();
    ctx.activeToolCalls.add('tc-008');
    ctx.toolCallStartTimes.set('tc-008', Date.now() - 100);

    handleToolCallUpdate({ toolCallId: 'tc-008', status: 'cancelled', kind: 'bash' }, ctx);

    expect(ctx.activeToolCalls.has('tc-008')).toBe(false);
  });

  it('emits idle status when last tool call completes', () => {
    const ctx = makeContext();
    ctx.activeToolCalls.add('tc-last');
    ctx.toolCallStartTimes.set('tc-last', Date.now() - 100);

    handleToolCallUpdate({ toolCallId: 'tc-last', status: 'completed', kind: 'bash' }, ctx);

    expect(ctx.emitIdleStatus).toHaveBeenCalled();
  });

  it('returns handled=true in all valid status cases', () => {
    for (const status of ['in_progress', 'pending', 'completed', 'failed', 'cancelled']) {
      const ctx = makeContext();
      if (status !== 'in_progress' && status !== 'pending') {
        ctx.activeToolCalls.add(`tc-${status}`);
        ctx.toolCallStartTimes.set(`tc-${status}`, Date.now());
      }
      const result = handleToolCallUpdate(
        { toolCallId: `tc-${status}`, status, kind: 'test' },
        ctx
      );
      expect(result.handled).toBe(true);
    }
  });
});

// ============================================================================
// handleToolCall
// ============================================================================

describe('handleToolCall', () => {
  it('returns handled=false when toolCallId is missing', () => {
    const ctx = makeContext();
    const result = handleToolCall({ status: 'in_progress', kind: 'bash' }, ctx);

    expect(result.handled).toBe(false);
  });

  it('adds tool call to active set when in_progress', () => {
    const ctx = makeContext();
    handleToolCall({ toolCallId: 'direct-001', kind: 'bash' }, ctx);

    expect(ctx.activeToolCalls.has('direct-001')).toBe(true);
  });

  it('treats missing status as in_progress (implicit start)', () => {
    const ctx = makeContext();
    handleToolCall({ toolCallId: 'direct-002', kind: 'write_file' }, ctx);

    expect(ctx.activeToolCalls.has('direct-002')).toBe(true);
  });

  it('returns handled=true and skips re-tracking already active tool call', () => {
    const ctx = makeContext();
    ctx.activeToolCalls.add('direct-003');

    const result = handleToolCall({ toolCallId: 'direct-003', kind: 'bash' }, ctx);

    expect(result.handled).toBe(true);
    // Should not call startToolCall (emit should still have the initial count from add above)
  });

  it('returns handled=false for non-in_progress status', () => {
    const ctx = makeContext();
    const result = handleToolCall({ toolCallId: 'direct-004', status: 'completed' }, ctx);

    expect(result.handled).toBe(false);
  });
});

// ============================================================================
// handleLegacyMessageChunk
// ============================================================================

describe('handleLegacyMessageChunk', () => {
  it('returns handled=false when messageChunk is absent', () => {
    const ctx = makeContext();
    expect(handleLegacyMessageChunk({}, ctx).handled).toBe(false);
  });

  it('returns handled=false when messageChunk has no textDelta', () => {
    const ctx = makeContext();
    expect(handleLegacyMessageChunk({ messageChunk: {} }, ctx).handled).toBe(false);
  });

  it('emits model-output when textDelta is present', () => {
    const ctx = makeContext();
    handleLegacyMessageChunk(
      { messageChunk: { textDelta: 'legacy chunk text' } },
      ctx
    );

    const messages = getEmitted(ctx);
    const output = messages.find((m) => m.type === 'model-output') as { type: 'model-output'; textDelta: string } | undefined;

    expect(output).toBeDefined();
    expect(output!.textDelta).toBe('legacy chunk text');
  });

  it('returns handled=true when textDelta is present', () => {
    const ctx = makeContext();
    const result = handleLegacyMessageChunk(
      { messageChunk: { textDelta: 'text' } },
      ctx
    );

    expect(result.handled).toBe(true);
  });
});

// ============================================================================
// handlePlanUpdate
// ============================================================================

describe('handlePlanUpdate', () => {
  it('returns handled=false when plan is absent', () => {
    const ctx = makeContext();
    expect(handlePlanUpdate({}, ctx).handled).toBe(false);
  });

  it('emits event with name "plan" and the plan payload', () => {
    const ctx = makeContext();
    const plan = { steps: ['step 1', 'step 2'], title: 'Refactor auth' };
    handlePlanUpdate({ plan }, ctx);

    const messages = getEmitted(ctx);
    const planEvent = messages.find((m) => m.type === 'event') as { type: 'event'; name: string; payload: unknown } | undefined;

    expect(planEvent).toBeDefined();
    expect(planEvent!.name).toBe('plan');
    expect(planEvent!.payload).toEqual(plan);
  });

  it('returns handled=true when plan is present', () => {
    const ctx = makeContext();
    const result = handlePlanUpdate({ plan: { steps: [] } }, ctx);

    expect(result.handled).toBe(true);
  });
});

// ============================================================================
// handleThinkingUpdate
// ============================================================================

describe('handleThinkingUpdate', () => {
  it('returns handled=false when thinking is absent', () => {
    const ctx = makeContext();
    expect(handleThinkingUpdate({}, ctx).handled).toBe(false);
  });

  it('emits event with name "thinking" and the thinking payload', () => {
    const ctx = makeContext();
    const thinking = { text: 'I am reasoning about the problem...' };
    handleThinkingUpdate({ thinking }, ctx);

    const messages = getEmitted(ctx);
    const thinkEvent = messages.find((m) => m.type === 'event') as { type: 'event'; name: string; payload: unknown } | undefined;

    expect(thinkEvent).toBeDefined();
    expect(thinkEvent!.name).toBe('thinking');
    expect(thinkEvent!.payload).toEqual(thinking);
  });

  it('returns handled=true when thinking is present', () => {
    const ctx = makeContext();
    const result = handleThinkingUpdate({ thinking: 'reasoning' }, ctx);

    expect(result.handled).toBe(true);
  });

  it('handles thinking as a plain string', () => {
    const ctx = makeContext();
    handleThinkingUpdate({ thinking: 'plain string thought' }, ctx);

    const messages = getEmitted(ctx);
    const thinkEvent = messages.find((m) => m.type === 'event') as { type: 'event'; name: string; payload: unknown } | undefined;

    expect(thinkEvent).toBeDefined();
    expect(thinkEvent!.payload).toBe('plain string thought');
  });
});
