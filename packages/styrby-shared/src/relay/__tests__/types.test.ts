/**
 * Tests for relay type helpers (relay/types.ts).
 *
 * Covers: getChannelName, deriveChannelSuffix, generateMessageId,
 * createBaseMessage, and RelayMessageSchema Zod validation.
 *
 * WHY: The relay channel name and Zod schema are security boundaries.
 * getChannelName guards against channel enumeration; RelayMessageSchema
 * prevents malformed broadcast payloads from reaching application code
 * (SEC-RELAY-002).
 *
 * @module relay/__tests__/types
 */

import { describe, it, expect } from 'vitest';
import {
  getChannelName,
  deriveChannelSuffix,
  generateMessageId,
  createBaseMessage,
  RelayMessageSchema,
} from '../types.js';

// ============================================================================
// getChannelName
// ============================================================================

describe('getChannelName', () => {
  it('returns relay:{userId} without a suffix (legacy format)', () => {
    expect(getChannelName('abc-123')).toBe('relay:abc-123');
  });

  it('returns relay:{userId}:{suffix} with a channel suffix', () => {
    expect(getChannelName('abc-123', 'a3f8c2d1e4b07f91')).toBe('relay:abc-123:a3f8c2d1e4b07f91');
  });

  it('starts with "relay:" prefix in both forms', () => {
    expect(getChannelName('user-1').startsWith('relay:')).toBe(true);
    expect(getChannelName('user-1', 'suffix').startsWith('relay:')).toBe(true);
  });
});

// ============================================================================
// deriveChannelSuffix
// ============================================================================

describe('deriveChannelSuffix', () => {
  it('returns a 16-character lowercase hex string', async () => {
    const suffix = await deriveChannelSuffix('shared-secret');
    expect(suffix).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic for the same input', async () => {
    const a = await deriveChannelSuffix('my-secret');
    const b = await deriveChannelSuffix('my-secret');
    expect(a).toBe(b);
  });

  it('produces different suffixes for different secrets', async () => {
    const a = await deriveChannelSuffix('secret-a');
    const b = await deriveChannelSuffix('secret-b');
    expect(a).not.toBe(b);
  });

  it('accepts a Uint8Array input', async () => {
    const bytes = new TextEncoder().encode('secret-bytes');
    const suffix = await deriveChannelSuffix(bytes);
    expect(suffix).toMatch(/^[0-9a-f]{16}$/);
  });

  it('Uint8Array and string encoding of same content produce the same suffix', async () => {
    const str = 'same-secret';
    const bytes = new TextEncoder().encode(str);
    const fromStr = await deriveChannelSuffix(str);
    const fromBytes = await deriveChannelSuffix(bytes);
    expect(fromStr).toBe(fromBytes);
  });
});

// ============================================================================
// generateMessageId
// ============================================================================

describe('generateMessageId', () => {
  it('starts with "msg_"', () => {
    expect(generateMessageId().startsWith('msg_')).toBe(true);
  });

  it('produces unique IDs', () => {
    const ids = new Set(Array.from({ length: 50 }, generateMessageId));
    expect(ids.size).toBe(50);
  });
});

// ============================================================================
// createBaseMessage
// ============================================================================

describe('createBaseMessage', () => {
  it('returns an object with id, timestamp, sender_device_id, sender_type', () => {
    const base = createBaseMessage('device-1', 'cli');
    expect(base.id.startsWith('msg_')).toBe(true);
    expect(base.sender_device_id).toBe('device-1');
    expect(base.sender_type).toBe('cli');
    expect(typeof base.timestamp).toBe('string');
  });

  it('timestamp is a valid ISO 8601 string', () => {
    const base = createBaseMessage('device-1', 'mobile');
    expect(() => new Date(base.timestamp)).not.toThrow();
    expect(new Date(base.timestamp).toISOString()).toBe(base.timestamp);
  });
});

// ============================================================================
// RelayMessageSchema — valid messages
// ============================================================================

describe('RelayMessageSchema — valid messages parse successfully', () => {
  function baseFields() {
    return {
      id: generateMessageId(),
      timestamp: new Date().toISOString(),
      sender_device_id: 'device-1',
      sender_type: 'cli' as const,
    };
  }

  it('parses a valid chat message', () => {
    const msg = {
      ...baseFields(),
      type: 'chat',
      payload: { content: 'hello', agent: 'claude' },
    };
    const result = RelayMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it('parses a valid permission_request message', () => {
    const msg = {
      ...baseFields(),
      type: 'permission_request',
      payload: {
        request_id: 'req-1',
        session_id: 'sess-1',
        agent: 'claude',
        tool_name: 'bash',
        tool_args: { command: 'ls' },
        risk_level: 'high',
        description: 'Run ls command',
        expires_at: new Date(Date.now() + 30_000).toISOString(),
        nonce: crypto.randomUUID(),
      },
    };
    const result = RelayMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it('parses a valid permission_response message', () => {
    const msg = {
      ...baseFields(),
      type: 'permission_response',
      payload: {
        request_id: 'req-1',
        approved: true,
        request_nonce: 'nonce-abc',
      },
    };
    const result = RelayMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it('parses a valid command message', () => {
    const msg = {
      ...baseFields(),
      type: 'command',
      payload: { action: 'cancel' },
    };
    const result = RelayMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it('parses a valid ack message', () => {
    const msg = {
      ...baseFields(),
      type: 'ack',
      payload: { ack_id: 'msg_1', success: true },
    };
    const result = RelayMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });
});

// ============================================================================
// RelayMessageSchema — invalid messages are rejected (SEC-RELAY-002)
// ============================================================================

describe('RelayMessageSchema — invalid messages fail (SEC-RELAY-002)', () => {
  it('rejects a message with unknown type', () => {
    const result = RelayMessageSchema.safeParse({
      id: 'msg_1',
      timestamp: new Date().toISOString(),
      sender_device_id: 'dev',
      sender_type: 'cli',
      type: 'malicious_type',
      payload: {},
    });
    expect(result.success).toBe(false);
  });

  it('rejects a chat message with invalid agent type', () => {
    const result = RelayMessageSchema.safeParse({
      id: 'msg_1',
      timestamp: new Date().toISOString(),
      sender_device_id: 'dev',
      sender_type: 'cli',
      type: 'chat',
      payload: { content: 'hello', agent: 'invalid_agent' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects null input', () => {
    expect(RelayMessageSchema.safeParse(null).success).toBe(false);
  });

  it('rejects missing required fields', () => {
    const result = RelayMessageSchema.safeParse({
      type: 'chat',
      payload: { content: 'hello', agent: 'claude' },
      // Missing id, timestamp, sender_device_id, sender_type
    });
    expect(result.success).toBe(false);
  });

  it('rejects permission_request missing the nonce field', () => {
    const result = RelayMessageSchema.safeParse({
      id: 'msg_1',
      timestamp: new Date().toISOString(),
      sender_device_id: 'dev',
      sender_type: 'cli',
      type: 'permission_request',
      payload: {
        request_id: 'req-1',
        session_id: 'sess-1',
        agent: 'claude',
        tool_name: 'bash',
        tool_args: {},
        risk_level: 'high',
        description: 'test',
        expires_at: new Date().toISOString(),
        // nonce is MISSING — should fail
      },
    });
    expect(result.success).toBe(false);
  });
});
