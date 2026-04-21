/**
 * Tests for offline queue helpers (relay/offline-queue.ts).
 *
 * Tests pure helper functions: getMessagePriority, generateQueueId,
 * getRetryDelay, shouldRetry, createQueuedCommand.
 *
 * WHY: The offline queue is critical for mobile UX when connectivity drops.
 * Bugs in priority, retry logic, or expiry detection cause lost or
 * duplicate commands reaching the CLI agent.
 *
 * @module relay/__tests__/offline-queue
 */

import { describe, it, expect } from 'vitest';
import {
  getMessagePriority,
  generateQueueId,
  getRetryDelay,
  shouldRetry,
  createQueuedCommand,
  QueuePriority,
  DEFAULT_QUEUE_TTL_MS,
  DEFAULT_MAX_ATTEMPTS,
  RETRY_BASE_DELAY_MS,
} from '../offline-queue.js';
import type { RelayMessage, CommandMessage } from '../types.js';

// ============================================================================
// Helpers for building minimal RelayMessages
// ============================================================================

function makeBase() {
  return {
    id: 'msg_test',
    timestamp: new Date().toISOString(),
    sender_device_id: 'device-1',
    sender_type: 'mobile' as const,
  };
}

function makeChatMessage(): RelayMessage {
  return {
    ...makeBase(),
    type: 'chat',
    payload: { content: 'hello', agent: 'claude' },
  };
}

function makeCommandMessage(action: CommandMessage['payload']['action']): RelayMessage {
  return {
    ...makeBase(),
    type: 'command',
    payload: { action },
  };
}

function makePermissionResponse(): RelayMessage {
  return {
    ...makeBase(),
    type: 'permission_response',
    payload: {
      request_id: 'req-1',
      approved: true,
      request_nonce: 'nonce-abc',
    },
  };
}

function makeAckMessage(): RelayMessage {
  return {
    ...makeBase(),
    type: 'ack',
    payload: { ack_id: 'msg_1', success: true },
  };
}

// ============================================================================
// getMessagePriority
// ============================================================================

describe('getMessagePriority', () => {
  it('permission_response → CRITICAL', () => {
    expect(getMessagePriority(makePermissionResponse())).toBe(QueuePriority.CRITICAL);
  });

  it('cancel command → CRITICAL', () => {
    expect(getMessagePriority(makeCommandMessage('cancel'))).toBe(QueuePriority.CRITICAL);
  });

  it('interrupt command → CRITICAL', () => {
    expect(getMessagePriority(makeCommandMessage('interrupt'))).toBe(QueuePriority.CRITICAL);
  });

  it('non-critical command (ping) → NORMAL', () => {
    expect(getMessagePriority(makeCommandMessage('ping'))).toBe(QueuePriority.NORMAL);
  });

  it('chat message → HIGH', () => {
    expect(getMessagePriority(makeChatMessage())).toBe(QueuePriority.HIGH);
  });

  it('ack message → LOW', () => {
    expect(getMessagePriority(makeAckMessage())).toBe(QueuePriority.LOW);
  });

  it('unknown type falls back to NORMAL', () => {
    // Force-cast to exercise the default branch
    const unknown = { ...makeBase(), type: 'unknown_future_type', payload: {} } as unknown as RelayMessage;
    expect(getMessagePriority(unknown)).toBe(QueuePriority.NORMAL);
  });
});

// ============================================================================
// generateQueueId
// ============================================================================

describe('generateQueueId', () => {
  it('starts with "queue_"', () => {
    expect(generateQueueId().startsWith('queue_')).toBe(true);
  });

  it('produces unique IDs', () => {
    const ids = new Set(Array.from({ length: 50 }, generateQueueId));
    expect(ids.size).toBe(50);
  });
});

// ============================================================================
// getRetryDelay — exponential backoff
// ============================================================================

describe('getRetryDelay', () => {
  it('returns RETRY_BASE_DELAY_MS on first attempt (0)', () => {
    expect(getRetryDelay(0)).toBe(RETRY_BASE_DELAY_MS);
  });

  it('doubles the delay on each additional attempt', () => {
    expect(getRetryDelay(1)).toBe(RETRY_BASE_DELAY_MS * 2);
    expect(getRetryDelay(2)).toBe(RETRY_BASE_DELAY_MS * 4);
    expect(getRetryDelay(3)).toBe(RETRY_BASE_DELAY_MS * 8);
  });

  it('caps at 30 seconds', () => {
    expect(getRetryDelay(100)).toBe(30_000);
  });

  it('does not exceed 30s for any large attempt count', () => {
    for (let i = 0; i < 20; i++) {
      expect(getRetryDelay(i)).toBeLessThanOrEqual(30_000);
    }
  });
});

// ============================================================================
// shouldRetry
// ============================================================================

describe('shouldRetry', () => {
  function makeItem(overrides: Partial<Parameters<typeof shouldRetry>[0]> = {}) {
    return {
      id: 'q_1',
      message: makeChatMessage(),
      status: 'failed' as const,
      attempts: 1,
      maxAttempts: DEFAULT_MAX_ATTEMPTS,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      priority: 0,
      ...overrides,
    };
  }

  it('returns true when status=failed, attempts < maxAttempts, not expired', () => {
    expect(shouldRetry(makeItem())).toBe(true);
  });

  it('returns false when status is not "failed"', () => {
    expect(shouldRetry(makeItem({ status: 'pending' }))).toBe(false);
    expect(shouldRetry(makeItem({ status: 'sent' }))).toBe(false);
  });

  it('returns false when attempts >= maxAttempts', () => {
    expect(shouldRetry(makeItem({ attempts: DEFAULT_MAX_ATTEMPTS }))).toBe(false);
    expect(shouldRetry(makeItem({ attempts: DEFAULT_MAX_ATTEMPTS + 1 }))).toBe(false);
  });

  it('returns false when item is expired', () => {
    expect(shouldRetry(makeItem({ expiresAt: new Date(Date.now() - 1000).toISOString() }))).toBe(false);
  });
});

// ============================================================================
// createQueuedCommand
// ============================================================================

describe('createQueuedCommand', () => {
  it('creates a QueuedCommand with status "pending"', () => {
    const cmd = createQueuedCommand(makeChatMessage());
    expect(cmd.status).toBe('pending');
  });

  it('starts with 0 attempts', () => {
    const cmd = createQueuedCommand(makeChatMessage());
    expect(cmd.attempts).toBe(0);
  });

  it('uses DEFAULT_MAX_ATTEMPTS when not specified', () => {
    const cmd = createQueuedCommand(makeChatMessage());
    expect(cmd.maxAttempts).toBe(DEFAULT_MAX_ATTEMPTS);
  });

  it('respects a custom maxAttempts', () => {
    const cmd = createQueuedCommand(makeChatMessage(), { maxAttempts: 5 });
    expect(cmd.maxAttempts).toBe(5);
  });

  it('sets expiresAt to now + DEFAULT_QUEUE_TTL_MS by default', () => {
    const before = Date.now();
    const cmd = createQueuedCommand(makeChatMessage());
    const after = Date.now();
    const expires = new Date(cmd.expiresAt).getTime();
    expect(expires).toBeGreaterThanOrEqual(before + DEFAULT_QUEUE_TTL_MS - 50);
    expect(expires).toBeLessThanOrEqual(after + DEFAULT_QUEUE_TTL_MS + 50);
  });

  it('respects a custom ttl', () => {
    const before = Date.now();
    const cmd = createQueuedCommand(makeChatMessage(), { ttl: 10_000 });
    const expires = new Date(cmd.expiresAt).getTime();
    expect(expires).toBeGreaterThanOrEqual(before + 10_000 - 50);
    expect(expires).toBeLessThanOrEqual(before + 10_000 + 200);
  });

  it('assigns priority from getMessagePriority when none provided', () => {
    const chatCmd = createQueuedCommand(makeChatMessage());
    expect(chatCmd.priority).toBe(QueuePriority.HIGH);
  });

  it('respects an explicit priority override', () => {
    const cmd = createQueuedCommand(makeChatMessage(), { priority: QueuePriority.CRITICAL });
    expect(cmd.priority).toBe(QueuePriority.CRITICAL);
  });

  it('assigns a unique ID prefixed with "queue_"', () => {
    const cmd = createQueuedCommand(makeChatMessage());
    expect(cmd.id.startsWith('queue_')).toBe(true);
  });

  it('sets createdAt to current ISO timestamp', () => {
    const before = new Date().toISOString();
    const cmd = createQueuedCommand(makeChatMessage());
    expect(cmd.createdAt >= before).toBe(true);
  });
});

// ============================================================================
// QueuePriority constants
// ============================================================================

describe('QueuePriority constants', () => {
  it('CRITICAL > HIGH > NORMAL > LOW', () => {
    expect(QueuePriority.CRITICAL).toBeGreaterThan(QueuePriority.HIGH);
    expect(QueuePriority.HIGH).toBeGreaterThan(QueuePriority.NORMAL);
    expect(QueuePriority.NORMAL).toBeGreaterThan(QueuePriority.LOW);
  });

  it('CRITICAL is 100', () => {
    expect(QueuePriority.CRITICAL).toBe(100);
  });

  it('LOW is negative (below normal)', () => {
    expect(QueuePriority.LOW).toBeLessThan(0);
  });
});
