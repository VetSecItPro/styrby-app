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

// ============================================================================
// Mock node:fs for detectGeminiBillingModel (reads ~/.gemini/*.json)
// ============================================================================

/**
 * WHY: detectGeminiBillingModel reads OAuth credential files from the user's
 * home directory. We mock fs.readFileSync so tests are hermetic and don't
 * depend on the developer's actual Gemini auth state.
 */
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return {
    ...original,
    readFileSync: vi.fn((_path: unknown) => { throw new Error('ENOENT: mock'); }),
  };
});
import * as fs from 'node:fs';
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
  handleGeminiUsageMetadata,
  detectGeminiBillingModel,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_TOOL_CALL_TIMEOUT_MS,
  type SessionUpdate,
  type HandlerContext,
  type GeminiUsageContext,
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

// ============================================================================
// detectGeminiBillingModel — Phase 1.6.1 Gap 3
// ============================================================================

/**
 * Tests for the Gemini billing-mode detector.
 *
 * WHY: The billing model drives whether `costUsd` appears on the dashboard.
 * For subscription / free modes the schema requires costUsd === 0. A wrong
 * detection would either silence real costs or fabricate fake charges.
 */
describe('detectGeminiBillingModel', () => {
  const mockReadFileSync = fs.readFileSync as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: all credential files throw ENOENT (no auth found).
    mockReadFileSync.mockImplementation(() => { throw new Error('ENOENT: mock'); });
  });

  it('returns "api-key" when apiKey is provided (highest priority)', () => {
    // WHY: If the user explicitly passed an API key, billing is per-token
    // regardless of any OAuth files that may be present.
    expect(detectGeminiBillingModel('sk-abc123')).toBe('api-key');
  });

  it('returns "free" when no apiKey and no OAuth files exist', () => {
    expect(detectGeminiBillingModel(undefined)).toBe('free');
  });

  it('returns "subscription" when oauth_creds.json has access_token', () => {
    mockReadFileSync.mockImplementationOnce(() =>
      JSON.stringify({ access_token: 'ya29.some_token' })
    );

    expect(detectGeminiBillingModel(undefined)).toBe('subscription');
  });

  it('returns "subscription" when auth.json has token field', () => {
    // First path (oauth_creds.json) throws; second path (auth.json) hits.
    mockReadFileSync
      .mockImplementationOnce(() => { throw new Error('ENOENT'); })
      .mockImplementationOnce(() => JSON.stringify({ token: 'ya29.legacy_token' }));

    expect(detectGeminiBillingModel(undefined)).toBe('subscription');
  });

  it('returns "free" when credential files exist but contain no token', () => {
    mockReadFileSync.mockImplementationOnce(() =>
      JSON.stringify({ some_other_key: 'value' })
    );

    expect(detectGeminiBillingModel(undefined)).toBe('free');
  });
});

// ============================================================================
// handleGeminiUsageMetadata — Phase 1.6.1 Gap 3
// ============================================================================

/**
 * Tests for the Gemini ACP usage event handler.
 *
 * WHY: This is the primary path for surfacing Gemini token counts in the cost
 * dashboard. Every Gemini session previously wrote $0 cost_records; these tests
 * verify that usage is now correctly extracted and emitted.
 */
describe('handleGeminiUsageMetadata', () => {
  const mockReadFileSync = fs.readFileSync as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockReadFileSync.mockImplementation(() => { throw new Error('ENOENT: mock'); });
  });

  /**
   * Build a GeminiUsageContext with the Gemini-specific fields set.
   */
  function makeGeminiContext(overrides: Partial<GeminiUsageContext> = {}): GeminiUsageContext {
    return {
      ...makeContext(),
      styrbySssionId: 'test-session-gemini-001',
      geminiApiKey: undefined,
      geminiModel: 'gemini-2.5-pro',
      ...overrides,
    } as GeminiUsageContext;
  }

  it('returns handled=false when usageMetadata is absent', () => {
    const ctx = makeGeminiContext();
    const result = handleGeminiUsageMetadata({}, ctx);

    expect(result.handled).toBe(false);
  });

  it('returns handled=false when usageMetadata is not an object', () => {
    const ctx = makeGeminiContext();
    const update = { usageMetadata: 'not-an-object' } as unknown as SessionUpdate;

    expect(handleGeminiUsageMetadata(update, ctx).handled).toBe(false);
  });

  it('returns handled=false when all token counts are zero', () => {
    const ctx = makeGeminiContext();
    const update = {
      usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0 },
    } as unknown as SessionUpdate;

    expect(handleGeminiUsageMetadata(update, ctx).handled).toBe(false);
  });

  it('emits cost-report with api-key billing when geminiApiKey is set', () => {
    const ctx = makeGeminiContext({ geminiApiKey: 'sk-test-123' });
    const update = {
      usageMetadata: {
        promptTokenCount: 2000,
        candidatesTokenCount: 800,
        cachedContentTokenCount: 100,
        model: 'gemini-2.5-pro',
      },
    } as unknown as SessionUpdate;

    handleGeminiUsageMetadata(update, ctx);

    const messages = getEmitted(ctx);
    const costReport = messages.find((m: any) => m.type === 'cost-report') as any;

    expect(costReport).toBeDefined();
    expect(costReport.report.billingModel).toBe('api-key');
    expect(costReport.report.inputTokens).toBe(2000);
    expect(costReport.report.outputTokens).toBe(800);
    expect(costReport.report.cacheReadTokens).toBe(100);
    expect(costReport.report.source).toBe('agent-reported');
    expect(costReport.report.agentType).toBe('gemini');
    expect(costReport.report.rawAgentPayload).not.toBeNull();
  });

  it('emits cost-report with subscription billing when OAuth file found', () => {
    // WHY: OAuth presence signals Gemini Workspace plan → subscription billing → costUsd=0.
    mockReadFileSync.mockImplementationOnce(() =>
      JSON.stringify({ access_token: 'ya29.workspace_token' })
    );

    const ctx = makeGeminiContext({ geminiApiKey: undefined });
    const update = {
      usageMetadata: {
        promptTokenCount: 1500,
        candidatesTokenCount: 600,
      },
    } as unknown as SessionUpdate;

    handleGeminiUsageMetadata(update, ctx);

    const messages = getEmitted(ctx);
    const costReport = messages.find((m: any) => m.type === 'cost-report') as any;

    expect(costReport).toBeDefined();
    expect(costReport.report.billingModel).toBe('subscription');
    expect(costReport.report.costUsd).toBe(0);
    expect(costReport.report.subscriptionUsage).toBeDefined();
    expect(costReport.report.subscriptionUsage.fractionUsed).toBeNull();
  });

  it('emits cost-report with free billing when no API key and no OAuth', () => {
    const ctx = makeGeminiContext({ geminiApiKey: undefined });
    const update = {
      usageMetadata: {
        promptTokenCount: 500,
        candidatesTokenCount: 200,
      },
    } as unknown as SessionUpdate;

    handleGeminiUsageMetadata(update, ctx);

    const messages = getEmitted(ctx);
    const costReport = messages.find((m: any) => m.type === 'cost-report') as any;

    expect(costReport).toBeDefined();
    expect(costReport.report.billingModel).toBe('free');
    expect(costReport.report.costUsd).toBe(0);
  });

  it('also emits legacy token-count event alongside cost-report', () => {
    const ctx = makeGeminiContext({ geminiApiKey: 'sk-test' });
    const update = {
      usageMetadata: {
        promptTokenCount: 1000,
        candidatesTokenCount: 400,
      },
    } as unknown as SessionUpdate;

    handleGeminiUsageMetadata(update, ctx);

    const messages = getEmitted(ctx);
    // WHY: Existing consumers may still listen for token-count events.
    const tokenCount = messages.find((m: any) => m.type === 'token-count');
    expect(tokenCount).toBeDefined();
    expect((tokenCount as any).inputTokens).toBe(1000);
    expect((tokenCount as any).outputTokens).toBe(400);
  });

  it('returns handled=true on success', () => {
    const ctx = makeGeminiContext({ geminiApiKey: 'sk-test' });
    const update = {
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 },
    } as unknown as SessionUpdate;

    const result = handleGeminiUsageMetadata(update, ctx);

    expect(result.handled).toBe(true);
  });
});
