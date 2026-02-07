/**
 * Tests for the Offline Command Queue Utilities
 *
 * Validates queue item creation, message priority assignment,
 * queue ID generation, retry delay calculation, and retry eligibility.
 *
 * This module tests the shared types and helper functions only --
 * platform-specific queue implementations (SQLite, IndexedDB) are
 * tested in their respective packages.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createQueuedCommand,
  getMessagePriority,
  generateQueueId,
  getRetryDelay,
  shouldRetry,
  QueuePriority,
  DEFAULT_QUEUE_TTL_MS,
  DEFAULT_MAX_ATTEMPTS,
  RETRY_BASE_DELAY_MS,
} from '../../src/relay/offline-queue';
import type { RelayMessage } from '../../src/relay/types';

// ==========================================================================
// Test Helpers
// ==========================================================================

/**
 * Creates a minimal RelayMessage of the given type for testing.
 * Only includes the fields required by the type discriminator.
 */
function createTestMessage(
  type: RelayMessage['type'],
  payloadOverrides?: Record<string, unknown>
): RelayMessage {
  const base = {
    id: 'msg_test_123',
    timestamp: new Date().toISOString(),
    sender_device_id: 'device_test',
    sender_type: 'mobile' as const,
  };

  switch (type) {
    case 'permission_response':
      return {
        ...base,
        type: 'permission_response',
        payload: {
          request_id: 'req_123',
          approved: true,
          ...payloadOverrides,
        },
      };
    case 'command':
      return {
        ...base,
        type: 'command',
        payload: {
          action: 'ping' as const,
          ...payloadOverrides,
        },
      };
    case 'chat':
      return {
        ...base,
        type: 'chat',
        payload: {
          content: 'Hello',
          agent: 'claude' as const,
          ...payloadOverrides,
        },
      };
    case 'ack':
      return {
        ...base,
        type: 'ack',
        payload: {
          ack_id: 'msg_acked',
          success: true,
          ...payloadOverrides,
        },
      };
    case 'agent_response':
      return {
        ...base,
        type: 'agent_response',
        payload: {
          content: 'Response',
          agent: 'claude' as const,
          session_id: 'session_123',
          is_streaming: false,
          is_complete: true,
          ...payloadOverrides,
        },
      };
    case 'session_state':
      return {
        ...base,
        type: 'session_state',
        payload: {
          session_id: 'session_123',
          agent: 'claude' as const,
          state: 'idle' as const,
          ...payloadOverrides,
        },
      };
    case 'cost_update':
      return {
        ...base,
        type: 'cost_update',
        payload: {
          session_id: 'session_123',
          agent: 'claude' as const,
          cost_usd: 0.05,
          session_total_usd: 0.25,
          tokens: { input: 100, output: 50 },
          model: 'claude-sonnet-4',
          ...payloadOverrides,
        },
      };
    default:
      return {
        ...base,
        type: 'chat',
        payload: {
          content: 'Default',
          agent: 'claude' as const,
        },
      };
  }
}

describe('Offline Queue Utilities', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // createQueuedCommand()
  // ==========================================================================

  describe('createQueuedCommand()', () => {
    it('creates a valid QueuedCommand with default options', () => {
      const message = createTestMessage('chat');
      const command = createQueuedCommand(message);

      expect(command).toHaveProperty('id');
      expect(command).toHaveProperty('message');
      expect(command).toHaveProperty('status');
      expect(command).toHaveProperty('attempts');
      expect(command).toHaveProperty('maxAttempts');
      expect(command).toHaveProperty('createdAt');
      expect(command).toHaveProperty('expiresAt');
      expect(command).toHaveProperty('priority');
    });

    it('sets status to pending', () => {
      const message = createTestMessage('chat');
      const command = createQueuedCommand(message);
      expect(command.status).toBe('pending');
    });

    it('sets attempts to 0', () => {
      const message = createTestMessage('chat');
      const command = createQueuedCommand(message);
      expect(command.attempts).toBe(0);
    });

    it('uses default maxAttempts of 3', () => {
      const message = createTestMessage('chat');
      const command = createQueuedCommand(message);
      expect(command.maxAttempts).toBe(DEFAULT_MAX_ATTEMPTS);
      expect(command.maxAttempts).toBe(3);
    });

    it('stores the original message', () => {
      const message = createTestMessage('chat');
      const command = createQueuedCommand(message);
      expect(command.message).toBe(message);
    });

    it('sets expiresAt to 5 minutes after createdAt by default', () => {
      const message = createTestMessage('chat');
      const command = createQueuedCommand(message);

      const createdAt = new Date(command.createdAt).getTime();
      const expiresAt = new Date(command.expiresAt).getTime();
      const diff = expiresAt - createdAt;

      expect(diff).toBe(DEFAULT_QUEUE_TTL_MS);
      expect(diff).toBe(5 * 60 * 1000);
    });

    it('assigns priority based on message type', () => {
      const chatMessage = createTestMessage('chat');
      const chatCommand = createQueuedCommand(chatMessage);
      expect(chatCommand.priority).toBe(QueuePriority.HIGH);

      const permMessage = createTestMessage('permission_response');
      const permCommand = createQueuedCommand(permMessage);
      expect(permCommand.priority).toBe(QueuePriority.CRITICAL);
    });

    it('overrides maxAttempts with custom options', () => {
      const message = createTestMessage('chat');
      const command = createQueuedCommand(message, { maxAttempts: 10 });
      expect(command.maxAttempts).toBe(10);
    });

    it('overrides TTL with custom options', () => {
      const message = createTestMessage('chat');
      const customTtl = 60 * 1000; // 1 minute
      const command = createQueuedCommand(message, { ttl: customTtl });

      const createdAt = new Date(command.createdAt).getTime();
      const expiresAt = new Date(command.expiresAt).getTime();
      const diff = expiresAt - createdAt;

      expect(diff).toBe(customTtl);
    });

    it('overrides priority with custom options', () => {
      const message = createTestMessage('chat');
      const command = createQueuedCommand(message, { priority: 999 });
      expect(command.priority).toBe(999);
    });

    it('generates a unique id for each command', () => {
      const message = createTestMessage('chat');
      const ids = new Set<string>();
      for (let i = 0; i < 20; i++) {
        const command = createQueuedCommand(message);
        ids.add(command.id);
      }
      expect(ids.size).toBe(20);
    });
  });

  // ==========================================================================
  // getMessagePriority()
  // ==========================================================================

  describe('getMessagePriority()', () => {
    it('returns CRITICAL (100) for permission_response', () => {
      const message = createTestMessage('permission_response');
      expect(getMessagePriority(message)).toBe(QueuePriority.CRITICAL);
      expect(getMessagePriority(message)).toBe(100);
    });

    it('returns CRITICAL (100) for cancel command', () => {
      const message = createTestMessage('command', { action: 'cancel' });
      expect(getMessagePriority(message)).toBe(QueuePriority.CRITICAL);
    });

    it('returns CRITICAL (100) for interrupt command', () => {
      const message = createTestMessage('command', { action: 'interrupt' });
      expect(getMessagePriority(message)).toBe(QueuePriority.CRITICAL);
    });

    it('returns HIGH (50) for chat messages', () => {
      const message = createTestMessage('chat');
      expect(getMessagePriority(message)).toBe(QueuePriority.HIGH);
      expect(getMessagePriority(message)).toBe(50);
    });

    it('returns LOW (-50) for ack messages', () => {
      const message = createTestMessage('ack');
      expect(getMessagePriority(message)).toBe(QueuePriority.LOW);
      expect(getMessagePriority(message)).toBe(-50);
    });

    it('returns NORMAL (0) for regular commands (ping, new_session, etc)', () => {
      const pingMessage = createTestMessage('command', { action: 'ping' });
      expect(getMessagePriority(pingMessage)).toBe(QueuePriority.NORMAL);

      const newSessionMessage = createTestMessage('command', { action: 'new_session' });
      expect(getMessagePriority(newSessionMessage)).toBe(QueuePriority.NORMAL);

      const switchMessage = createTestMessage('command', { action: 'switch_agent' });
      expect(getMessagePriority(switchMessage)).toBe(QueuePriority.NORMAL);
    });

    it('returns NORMAL (0) for agent_response messages', () => {
      const message = createTestMessage('agent_response');
      expect(getMessagePriority(message)).toBe(QueuePriority.NORMAL);
    });

    it('returns NORMAL (0) for session_state messages', () => {
      const message = createTestMessage('session_state');
      expect(getMessagePriority(message)).toBe(QueuePriority.NORMAL);
    });

    it('returns NORMAL (0) for cost_update messages', () => {
      const message = createTestMessage('cost_update');
      expect(getMessagePriority(message)).toBe(QueuePriority.NORMAL);
    });
  });

  // ==========================================================================
  // generateQueueId()
  // ==========================================================================

  describe('generateQueueId()', () => {
    it('returns a string starting with "queue_"', () => {
      const id = generateQueueId();
      expect(id.startsWith('queue_')).toBe(true);
    });

    it('returns unique IDs on repeated calls', () => {
      const ids = new Set<string>();
      for (let i = 0; i < 50; i++) {
        ids.add(generateQueueId());
      }
      expect(ids.size).toBe(50);
    });

    it('contains a timestamp component', () => {
      const before = Date.now();
      const id = generateQueueId();
      const after = Date.now();

      // Extract the timestamp part (between first and second underscore)
      const parts = id.split('_');
      expect(parts.length).toBe(3);

      const timestamp = parseInt(parts[1], 10);
      expect(timestamp).toBeGreaterThanOrEqual(before);
      expect(timestamp).toBeLessThanOrEqual(after);
    });

    it('contains a random suffix component', () => {
      const id = generateQueueId();
      const parts = id.split('_');
      // The random suffix should be alphanumeric
      expect(parts[2]).toMatch(/^[a-z0-9]+$/);
      expect(parts[2].length).toBeGreaterThan(0);
    });
  });

  // ==========================================================================
  // getRetryDelay()
  // ==========================================================================

  describe('getRetryDelay()', () => {
    it('returns base delay (1000ms) for 0 attempts', () => {
      expect(getRetryDelay(0)).toBe(RETRY_BASE_DELAY_MS);
      expect(getRetryDelay(0)).toBe(1000);
    });

    it('implements exponential backoff', () => {
      expect(getRetryDelay(0)).toBe(1000);   // 1s
      expect(getRetryDelay(1)).toBe(2000);   // 2s
      expect(getRetryDelay(2)).toBe(4000);   // 4s
      expect(getRetryDelay(3)).toBe(8000);   // 8s
      expect(getRetryDelay(4)).toBe(16000);  // 16s
    });

    it('caps delay at 30 seconds', () => {
      expect(getRetryDelay(5)).toBe(30000);  // Would be 32000, capped at 30000
      expect(getRetryDelay(10)).toBe(30000); // Way beyond cap
      expect(getRetryDelay(100)).toBe(30000); // Extreme value
    });

    it('returns values increasing with attempt count up to cap', () => {
      let prevDelay = 0;
      for (let i = 0; i < 5; i++) {
        const delay = getRetryDelay(i);
        expect(delay).toBeGreaterThan(prevDelay);
        prevDelay = delay;
      }
    });
  });

  // ==========================================================================
  // shouldRetry()
  // ==========================================================================

  describe('shouldRetry()', () => {
    it('returns true for a failed item within attempt limit and not expired', () => {
      const item = createQueuedCommand(createTestMessage('chat'));
      // Simulate: mark as failed with 1 attempt made, not at max
      item.status = 'failed';
      item.attempts = 1;
      // Ensure not expired (default TTL is 5 minutes in the future)

      expect(shouldRetry(item)).toBe(true);
    });

    it('returns false for a pending item (not failed)', () => {
      const item = createQueuedCommand(createTestMessage('chat'));
      // Status is 'pending' by default
      expect(shouldRetry(item)).toBe(false);
    });

    it('returns false for a sent item', () => {
      const item = createQueuedCommand(createTestMessage('chat'));
      item.status = 'sent';
      expect(shouldRetry(item)).toBe(false);
    });

    it('returns false for an expired item', () => {
      const item = createQueuedCommand(createTestMessage('chat'));
      item.status = 'failed';
      item.attempts = 1;
      // Set expiration to the past
      item.expiresAt = new Date(Date.now() - 1000).toISOString();

      expect(shouldRetry(item)).toBe(false);
    });

    it('returns false when attempts have been exhausted', () => {
      const item = createQueuedCommand(createTestMessage('chat'));
      item.status = 'failed';
      item.attempts = item.maxAttempts; // Reached max

      expect(shouldRetry(item)).toBe(false);
    });

    it('returns false when attempts exceed maxAttempts', () => {
      const item = createQueuedCommand(createTestMessage('chat'));
      item.status = 'failed';
      item.attempts = item.maxAttempts + 5;

      expect(shouldRetry(item)).toBe(false);
    });

    it('returns true when attempts are at maxAttempts - 1 (one more try available)', () => {
      const item = createQueuedCommand(createTestMessage('chat'));
      item.status = 'failed';
      item.attempts = item.maxAttempts - 1;

      expect(shouldRetry(item)).toBe(true);
    });

    it('returns false for an expired item even if attempts remain', () => {
      const item = createQueuedCommand(createTestMessage('chat'));
      item.status = 'failed';
      item.attempts = 0;
      item.expiresAt = new Date(Date.now() - 60000).toISOString();

      expect(shouldRetry(item)).toBe(false);
    });
  });

  // ==========================================================================
  // Constants
  // ==========================================================================

  describe('Queue Constants', () => {
    it('DEFAULT_QUEUE_TTL_MS is 5 minutes', () => {
      expect(DEFAULT_QUEUE_TTL_MS).toBe(5 * 60 * 1000);
    });

    it('DEFAULT_MAX_ATTEMPTS is 3', () => {
      expect(DEFAULT_MAX_ATTEMPTS).toBe(3);
    });

    it('RETRY_BASE_DELAY_MS is 1000', () => {
      expect(RETRY_BASE_DELAY_MS).toBe(1000);
    });

    it('QueuePriority has expected values', () => {
      expect(QueuePriority.CRITICAL).toBe(100);
      expect(QueuePriority.HIGH).toBe(50);
      expect(QueuePriority.NORMAL).toBe(0);
      expect(QueuePriority.LOW).toBe(-50);
    });
  });
});
