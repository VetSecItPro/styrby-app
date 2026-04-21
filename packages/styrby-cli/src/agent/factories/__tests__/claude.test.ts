/**
 * Tests for the Claude factory helpers.
 *
 * Covers:
 * - `detectClaudeBillingModel` — reads ~/.claude/auth.json to determine billing
 * - `parseClaudeJsonlLine` — structured JSONL parser that emits CostReport
 *
 * The fs module is mocked so no real ~/.claude/auth.json is required.
 * Tests verify the full CostReport shape including billingModel, source,
 * subscriptionUsage (subscription path), and rawAgentPayload.
 *
 * @module factories/__tests__/claude.test.ts
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — declared before module imports so Vitest's hoisting replaces them
// ---------------------------------------------------------------------------

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Imports — after vi.mock declarations
// ---------------------------------------------------------------------------

import * as fs from 'node:fs';
import { detectClaudeBillingModel, parseClaudeJsonlLine } from '../claude';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockExistsSync = fs.existsSync as unknown as ReturnType<typeof vi.fn>;
const mockReadFileSync = fs.readFileSync as unknown as ReturnType<typeof vi.fn>;

/**
 * Configure the fs mock to return a specific auth.json content.
 *
 * @param content - Parsed object to serialize as auth.json
 */
function setAuthJson(content: Record<string, unknown>): void {
  mockExistsSync.mockReturnValue(true);
  mockReadFileSync.mockReturnValue(JSON.stringify(content));
}

/**
 * Configure the fs mock to simulate a missing auth.json.
 */
function setAuthJsonMissing(): void {
  mockExistsSync.mockReturnValue(false);
}

/**
 * Configure the fs mock to simulate a malformed auth.json.
 */
function setAuthJsonMalformed(): void {
  mockExistsSync.mockReturnValue(true);
  mockReadFileSync.mockReturnValue('{invalid json here');
}

/** Build a valid Claude JSONL assistant message with usage */
function claudeAssistantLine(opts: {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  model?: string;
  timestamp?: string;
}): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: opts.timestamp ?? new Date().toISOString(),
    message: {
      model: opts.model ?? 'claude-sonnet-4-20250514',
      usage: {
        input_tokens: opts.inputTokens ?? 0,
        output_tokens: opts.outputTokens ?? 0,
        cache_read_input_tokens: opts.cacheReadTokens,
        cache_creation_input_tokens: opts.cacheWriteTokens,
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.clearAllMocks();
});

// ===========================================================================
// detectClaudeBillingModel
// ===========================================================================

/**
 * Tests for `detectClaudeBillingModel` — auth.json detection logic.
 */
describe('detectClaudeBillingModel', () => {
  it('returns "api-key" when ~/.claude/auth.json does not exist', () => {
    setAuthJsonMissing();

    const result = detectClaudeBillingModel();

    expect(result).toBe('api-key');
  });

  it('returns "subscription" for subscriptionType="max"', () => {
    setAuthJson({ subscriptionType: 'max' });

    expect(detectClaudeBillingModel()).toBe('subscription');
  });

  it('returns "subscription" for subscriptionType="pro"', () => {
    setAuthJson({ subscriptionType: 'pro' });

    expect(detectClaudeBillingModel()).toBe('subscription');
  });

  it('returns "subscription" for subscriptionType="claude_max"', () => {
    setAuthJson({ subscriptionType: 'claude_max' });

    expect(detectClaudeBillingModel()).toBe('subscription');
  });

  it('returns "subscription" for subscriptionType="claude_pro"', () => {
    setAuthJson({ subscriptionType: 'claude_pro' });

    expect(detectClaudeBillingModel()).toBe('subscription');
  });

  it('returns "subscription" when subscriptionType is uppercase (MAX)', () => {
    setAuthJson({ subscriptionType: 'MAX' });

    expect(detectClaudeBillingModel()).toBe('subscription');
  });

  it('returns "api-key" for unknown subscriptionType', () => {
    setAuthJson({ subscriptionType: 'enterprise_unknown' });

    expect(detectClaudeBillingModel()).toBe('api-key');
  });

  it('returns "api-key" when subscriptionType field is absent', () => {
    setAuthJson({ userId: 'user-123', apiKey: 'sk-...' });

    expect(detectClaudeBillingModel()).toBe('api-key');
  });

  it('returns "api-key" when auth.json is malformed JSON', () => {
    setAuthJsonMalformed();

    expect(detectClaudeBillingModel()).toBe('api-key');
  });

  it('returns "api-key" when readFileSync throws', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation(() => { throw new Error('EACCES: permission denied'); });

    expect(detectClaudeBillingModel()).toBe('api-key');
  });
});

// ===========================================================================
// parseClaudeJsonlLine — api-key path
// ===========================================================================

/**
 * Tests for the structured JSONL parser in api-key billing mode.
 */
describe('parseClaudeJsonlLine — api-key billing model', () => {
  const SESSION_ID = 'sess-api-key-001';

  it('returns a CostReport with billingModel=api-key for a valid assistant line', () => {
    const line = claudeAssistantLine({ inputTokens: 1000, outputTokens: 400 });

    const report = parseClaudeJsonlLine(line, SESSION_ID, 'api-key');

    expect(report).not.toBeNull();
    expect(report!.billingModel).toBe('api-key');
    expect(report!.source).toBe('agent-reported');
    expect(report!.agentType).toBe('claude');
    expect(report!.sessionId).toBe(SESSION_ID);
  });

  it('maps input_tokens and output_tokens correctly', () => {
    const line = claudeAssistantLine({ inputTokens: 1500, outputTokens: 600 });

    const report = parseClaudeJsonlLine(line, SESSION_ID, 'api-key');

    expect(report!.inputTokens).toBe(1500);
    expect(report!.outputTokens).toBe(600);
  });

  it('maps cache_read_input_tokens to cacheReadTokens', () => {
    const line = claudeAssistantLine({ cacheReadTokens: 200 });

    const report = parseClaudeJsonlLine(line, SESSION_ID, 'api-key');

    expect(report!.cacheReadTokens).toBe(200);
  });

  it('maps cache_creation_input_tokens to cacheWriteTokens', () => {
    const line = claudeAssistantLine({ cacheWriteTokens: 80 });

    const report = parseClaudeJsonlLine(line, SESSION_ID, 'api-key');

    expect(report!.cacheWriteTokens).toBe(80);
  });

  it('uses model from message.model when present', () => {
    const line = claudeAssistantLine({ model: 'claude-opus-4-20260101' });

    const report = parseClaudeJsonlLine(line, SESSION_ID, 'api-key');

    expect(report!.model).toBe('claude-opus-4-20260101');
  });

  it('defaults model to "unknown" when message.model is absent', () => {
    const raw = JSON.stringify({
      type: 'assistant',
      message: { usage: { input_tokens: 10, output_tokens: 5 } },
    });

    const report = parseClaudeJsonlLine(raw, SESSION_ID, 'api-key');

    expect(report!.model).toBe('unknown');
  });

  it('sets rawAgentPayload to a non-null object', () => {
    const line = claudeAssistantLine({ inputTokens: 500 });

    const report = parseClaudeJsonlLine(line, SESSION_ID, 'api-key');

    expect(report!.rawAgentPayload).not.toBeNull();
    expect(typeof report!.rawAgentPayload).toBe('object');
  });

  it('uses line timestamp when present', () => {
    const ts = '2026-04-21T12:00:00.000Z';
    const line = claudeAssistantLine({ timestamp: ts });

    const report = parseClaudeJsonlLine(line, SESSION_ID, 'api-key');

    expect(report!.timestamp).toBe(ts);
  });

  it('falls back to current ISO timestamp when line has no timestamp', () => {
    const raw = JSON.stringify({
      type: 'assistant',
      message: { usage: { input_tokens: 10 } },
    });
    const before = Date.now();
    const report = parseClaudeJsonlLine(raw, SESSION_ID, 'api-key');
    const after = Date.now();

    expect(report).not.toBeNull();
    const t = new Date(report!.timestamp).getTime();
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(after);
  });

  it('returns null for non-assistant message types', () => {
    const line = JSON.stringify({ type: 'user', message: { content: 'hello' } });

    expect(parseClaudeJsonlLine(line, SESSION_ID, 'api-key')).toBeNull();
  });

  it('returns null when message.usage is absent', () => {
    const line = JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-4' } });

    expect(parseClaudeJsonlLine(line, SESSION_ID, 'api-key')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseClaudeJsonlLine('', SESSION_ID, 'api-key')).toBeNull();
  });

  it('returns null for whitespace-only string', () => {
    expect(parseClaudeJsonlLine('   ', SESSION_ID, 'api-key')).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(parseClaudeJsonlLine('{broken', SESSION_ID, 'api-key')).toBeNull();
  });

  it('returns null for non-JSON text line', () => {
    expect(parseClaudeJsonlLine('Loading claude...', SESSION_ID, 'api-key')).toBeNull();
  });

  it('messageId is null (not exposed in JSONL)', () => {
    const line = claudeAssistantLine({ inputTokens: 100 });

    const report = parseClaudeJsonlLine(line, SESSION_ID, 'api-key');

    expect(report!.messageId).toBeNull();
  });

  it('does NOT include subscriptionUsage for api-key billing', () => {
    const line = claudeAssistantLine({ inputTokens: 100 });

    const report = parseClaudeJsonlLine(line, SESSION_ID, 'api-key');

    expect((report as any).subscriptionUsage).toBeUndefined();
  });
});

// ===========================================================================
// parseClaudeJsonlLine — subscription path
// ===========================================================================

/**
 * Tests for the parser in subscription billing mode (Claude Max/Pro).
 *
 * WHY: Subscription users must see costUsd=0 and subscriptionUsage populated.
 * The CostReport must still carry token counts for usage monitoring even though
 * the cost is $0.
 */
describe('parseClaudeJsonlLine — subscription billing model', () => {
  const SESSION_ID = 'sess-sub-001';

  it('returns costUsd=0 for subscription billing', () => {
    const line = claudeAssistantLine({ inputTokens: 2000, outputTokens: 800 });

    const report = parseClaudeJsonlLine(line, SESSION_ID, 'subscription');

    expect(report!.costUsd).toBe(0);
  });

  it('returns billingModel=subscription', () => {
    const line = claudeAssistantLine({ inputTokens: 500 });

    const report = parseClaudeJsonlLine(line, SESSION_ID, 'subscription');

    expect(report!.billingModel).toBe('subscription');
  });

  it('includes subscriptionUsage block with fractionUsed=null', () => {
    const line = claudeAssistantLine({ inputTokens: 300, outputTokens: 100 });

    const report = parseClaudeJsonlLine(line, SESSION_ID, 'subscription');

    expect(report!.subscriptionUsage).toBeDefined();
    expect(report!.subscriptionUsage!.fractionUsed).toBeNull();
  });

  it('still records token counts for usage monitoring', () => {
    const line = claudeAssistantLine({ inputTokens: 1200, outputTokens: 500, cacheReadTokens: 100 });

    const report = parseClaudeJsonlLine(line, SESSION_ID, 'subscription');

    expect(report!.inputTokens).toBe(1200);
    expect(report!.outputTokens).toBe(500);
    expect(report!.cacheReadTokens).toBe(100);
  });

  it('source is agent-reported even for subscription billing', () => {
    const line = claudeAssistantLine({ inputTokens: 400 });

    const report = parseClaudeJsonlLine(line, SESSION_ID, 'subscription');

    expect(report!.source).toBe('agent-reported');
  });
});
