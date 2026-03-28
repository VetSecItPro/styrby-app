/**
 * Per-Message Cost Extraction Tests (Phase 7.9)
 *
 * Tests for the MessageCostRecord type and the addUsageForMessage() method
 * on CostExtractor, which emits both 'cost' and 'messageCost' events.
 *
 * WHY: Per-message granularity is the foundation of the cost pill UI.
 * These tests verify that the message ID is correctly associated with the
 * cost record, that both events fire, and that the summary is unaffected.
 */

import { describe, it, expect, vi } from 'vitest';

// ============================================================================
// Mocks
// ============================================================================

/**
 * Mock the @styrby/shared/pricing module.
 * WHY: litellm-pricing uses Node.js builtins (node:path, node:os, node:fs,
 * node:crypto) which are unavailable in the Vitest browser-ish environment.
 * We return static Sonnet-4 pricing for test purposes.
 */
vi.mock('@styrby/shared/pricing', () => ({
  getModelPriceSync: vi.fn(() => ({
    inputPer1k: 0.003,
    outputPer1k: 0.015,
    cachePer1k: 0.0003,
    cacheWritePer1k: 0.00375,
  })),
  getModelPrice: vi.fn(async () => ({
    inputPer1k: 0.003,
    outputPer1k: 0.015,
    cachePer1k: 0.0003,
    cacheWritePer1k: 0.00375,
  })),
}));

import { CostExtractor, type MessageCostRecord } from '../cost-extractor.js';
import type { TokenUsage } from '../jsonl-parser.js';

// ============================================================================
// Fixtures
// ============================================================================

/**
 * A token usage fixture representing a mid-size Claude Sonnet 4 response.
 */
const USAGE_FIXTURE: TokenUsage = {
  inputTokens: 1200,
  outputTokens: 350,
  cacheReadTokens: 800,
  cacheWriteTokens: 0,
  model: 'claude-sonnet-4-20250514',
  timestamp: new Date('2026-03-27T10:00:00Z'),
};

/**
 * A session ID used across test cases.
 */
const SESSION_ID = 'session-test-001';

/**
 * A message ID used across test cases.
 */
const MESSAGE_ID = 'msg-uuid-abc123';

// ============================================================================
// Tests
// ============================================================================

describe('CostExtractor.addUsageForMessage', () => {
  it('emits both cost and messageCost events', () => {
    const extractor = new CostExtractor({
      agentType: 'claude',
      sessionId: SESSION_ID,
    });

    const costHandler = vi.fn();
    const messageCostHandler = vi.fn();

    extractor.on('cost', costHandler);
    extractor.on('messageCost', messageCostHandler);

    extractor.addUsageForMessage(USAGE_FIXTURE, MESSAGE_ID);

    expect(costHandler).toHaveBeenCalledTimes(1);
    expect(messageCostHandler).toHaveBeenCalledTimes(1);
  });

  it('attaches the correct message ID to the emitted record', () => {
    const extractor = new CostExtractor({
      agentType: 'claude',
      sessionId: SESSION_ID,
    });

    let emittedRecord: MessageCostRecord | null = null;
    extractor.on('messageCost', (record: MessageCostRecord) => {
      emittedRecord = record;
    });

    extractor.addUsageForMessage(USAGE_FIXTURE, MESSAGE_ID);

    expect(emittedRecord).not.toBeNull();
    expect(emittedRecord!.messageId).toBe(MESSAGE_ID);
  });

  it('returns a record with the expected token counts', () => {
    const extractor = new CostExtractor({
      agentType: 'claude',
      sessionId: SESSION_ID,
    });

    const record = extractor.addUsageForMessage(USAGE_FIXTURE, MESSAGE_ID);

    expect(record.inputTokens).toBe(USAGE_FIXTURE.inputTokens);
    expect(record.outputTokens).toBe(USAGE_FIXTURE.outputTokens);
    expect(record.cacheReadTokens).toBe(USAGE_FIXTURE.cacheReadTokens);
    expect(record.cacheWriteTokens).toBe(USAGE_FIXTURE.cacheWriteTokens);
    expect(record.model).toBe(USAGE_FIXTURE.model);
  });

  it('calculates a positive USD cost', () => {
    const extractor = new CostExtractor({
      agentType: 'claude',
      sessionId: SESSION_ID,
    });

    const record = extractor.addUsageForMessage(USAGE_FIXTURE, MESSAGE_ID);

    expect(record.costUsd).toBeGreaterThan(0);
    // Rough sanity check: 1200 input + 350 output at Sonnet 4 pricing
    // should be in the $0.001 – $0.01 range
    expect(record.costUsd).toBeLessThan(0.01);
  });

  it('adds the record to the extractor records list', () => {
    const extractor = new CostExtractor({
      agentType: 'claude',
      sessionId: SESSION_ID,
    });

    expect(extractor.getRecords()).toHaveLength(0);

    extractor.addUsageForMessage(USAGE_FIXTURE, MESSAGE_ID);

    expect(extractor.getRecords()).toHaveLength(1);
  });

  it('includes the message-cost record in the session summary', () => {
    const extractor = new CostExtractor({
      agentType: 'claude',
      sessionId: SESSION_ID,
    });

    extractor.addUsageForMessage(USAGE_FIXTURE, MESSAGE_ID);

    const summary = extractor.getSummary();

    expect(summary.totalInputTokens).toBe(USAGE_FIXTURE.inputTokens);
    expect(summary.totalOutputTokens).toBe(USAGE_FIXTURE.outputTokens);
    expect(summary.totalCostUsd).toBeGreaterThan(0);
    expect(summary.recordCount).toBe(1);
  });

  it('handles multiple messages with distinct message IDs', () => {
    const extractor = new CostExtractor({
      agentType: 'claude',
      sessionId: SESSION_ID,
    });

    const emittedIds: (string | null)[] = [];
    extractor.on('messageCost', (record: MessageCostRecord) => {
      emittedIds.push(record.messageId);
    });

    extractor.addUsageForMessage(USAGE_FIXTURE, 'msg-001');
    extractor.addUsageForMessage(USAGE_FIXTURE, 'msg-002');
    extractor.addUsageForMessage(USAGE_FIXTURE, 'msg-003');

    expect(emittedIds).toEqual(['msg-001', 'msg-002', 'msg-003']);
    expect(extractor.getRecords()).toHaveLength(3);
  });

  it('does not affect records added via addUsage() — they have no messageId', () => {
    const extractor = new CostExtractor({
      agentType: 'claude',
      sessionId: SESSION_ID,
    });

    // Standard addUsage — no messageId
    extractor.addUsage(USAGE_FIXTURE);
    // Per-message addUsageForMessage — has messageId
    extractor.addUsageForMessage(USAGE_FIXTURE, MESSAGE_ID);

    const records = extractor.getRecords();
    expect(records).toHaveLength(2);

    // The first record (from addUsage) should not have messageId
    expect((records[0] as MessageCostRecord).messageId).toBeUndefined();
    // The second record (from addUsageForMessage) has messageId
    expect((records[1] as MessageCostRecord).messageId).toBe(MESSAGE_ID);
  });

  it('resets all records including message-cost records', () => {
    const extractor = new CostExtractor({
      agentType: 'claude',
      sessionId: SESSION_ID,
    });

    extractor.addUsageForMessage(USAGE_FIXTURE, MESSAGE_ID);
    expect(extractor.getRecords()).toHaveLength(1);

    extractor.reset();
    expect(extractor.getRecords()).toHaveLength(0);
  });
});

// ============================================================================
// MessageCost type shape validation
// ============================================================================

describe('MessageCostRecord structure', () => {
  it('contains all required MessageCost fields', () => {
    const extractor = new CostExtractor({
      agentType: 'claude',
      sessionId: SESSION_ID,
    });

    const record = extractor.addUsageForMessage(USAGE_FIXTURE, MESSAGE_ID);

    // All fields from MessageCost interface should be present
    expect(typeof record.messageId).toBe('string');
    expect(typeof record.inputTokens).toBe('number');
    expect(typeof record.outputTokens).toBe('number');
    expect(typeof record.cacheReadTokens).toBe('number');
    expect(typeof record.cacheWriteTokens).toBe('number');
    expect(typeof record.costUsd).toBe('number');
    expect(typeof record.model).toBe('string');
    // Base CostRecord fields also present
    expect(typeof record.sessionId).toBe('string');
    expect(typeof record.agentType).toBe('string');
  });
});
