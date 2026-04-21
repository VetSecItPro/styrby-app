/**
 * Tests for agent/adapters/MessageAdapter.ts
 *
 * Covers:
 * - MessageAdapter.toMobile: wraps normalized payload in MobileAgentMessage shell
 * - MessageAdapter.normalize: every AgentMessage type is mapped to the
 *   correct NormalizedMobilePayload fields
 * - createMessageAdapter: convenience factory function
 * - adapters: pre-configured singleton instances
 * - includeRaw option: _raw field present/absent
 *
 * WHY: MessageAdapter is the boundary between internal AgentMessage events and
 * the mobile app wire format. A silent field-mapping bug here causes "blank"
 * or "stuck" messages on the mobile UI without any thrown error.
 *
 * @module agent/adapters/__tests__/MessageAdapter
 */

import { describe, it, expect } from 'vitest';
import {
  MessageAdapter,
  createMessageAdapter,
  adapters,
} from '../MessageAdapter';
import type { AgentMessage } from '../../core/AgentMessage';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/** Build an adapter for a standard test agent type. */
function makeAdapter() {
  return new MessageAdapter({ agentType: 'gemini' });
}

// ===========================================================================
// MessageAdapter.toMobile — shell structure
// ===========================================================================

describe('MessageAdapter.toMobile', () => {
  it('wraps the normalized payload in a MobileAgentMessage with role "agent"', () => {
    const adapter = makeAdapter();
    const msg: AgentMessage = { type: 'status', status: 'idle' };

    const result = adapter.toMobile(msg);

    expect(result.role).toBe('agent');
    expect(result.content.type).toBe('gemini');
    expect(result.content.data).toBeDefined();
  });

  it('sets the correct agentType in content.type', () => {
    const adapter = new MessageAdapter({ agentType: 'aider' });
    const msg: AgentMessage = { type: 'status', status: 'idle' };

    const result = adapter.toMobile(msg);

    expect(result.content.type).toBe('aider');
  });

  it('includes meta.sentFrom = "cli"', () => {
    const result = makeAdapter().toMobile({ type: 'status', status: 'idle' });
    expect(result.meta?.sentFrom).toBe('cli');
  });
});

// ===========================================================================
// MessageAdapter.normalize — model-output
// ===========================================================================

describe('MessageAdapter.normalize — model-output', () => {
  it('maps textDelta to text field', () => {
    const payload = makeAdapter().normalize({
      type: 'model-output',
      textDelta: 'Hello',
    });
    expect(payload.type).toBe('model-output');
    expect(payload.text).toBe('Hello');
  });

  it('falls back to fullText when textDelta is absent', () => {
    const payload = makeAdapter().normalize({
      type: 'model-output',
      fullText: 'Full response text',
    });
    expect(payload.text).toBe('Full response text');
  });
});

// ===========================================================================
// MessageAdapter.normalize — status
// ===========================================================================

describe('MessageAdapter.normalize — status', () => {
  it('maps status and detail to statusDetail', () => {
    const payload = makeAdapter().normalize({
      type: 'status',
      status: 'error',
      detail: 'something broke',
    });
    expect(payload.status).toBe('error');
    expect(payload.statusDetail).toBe('something broke');
  });

  it('status without detail has undefined statusDetail', () => {
    const payload = makeAdapter().normalize({ type: 'status', status: 'idle' });
    expect(payload.status).toBe('idle');
    expect(payload.statusDetail).toBeUndefined();
  });
});

// ===========================================================================
// MessageAdapter.normalize — tool-call
// ===========================================================================

describe('MessageAdapter.normalize — tool-call', () => {
  it('maps toolName, args, and callId to payload fields', () => {
    const payload = makeAdapter().normalize({
      type: 'tool-call',
      toolName: 'read_file',
      args: { path: '/etc/hosts' },
      callId: 'call-123',
    } as AgentMessage);

    expect(payload.toolName).toBe('read_file');
    expect(payload.toolArgs).toEqual({ path: '/etc/hosts' });
    expect(payload.toolCallId).toBe('call-123');
  });
});

// ===========================================================================
// MessageAdapter.normalize — tool-result
// ===========================================================================

describe('MessageAdapter.normalize — tool-result', () => {
  it('maps toolName, result, and callId', () => {
    const payload = makeAdapter().normalize({
      type: 'tool-result',
      toolName: 'read_file',
      result: { content: 'file content' },
      callId: 'call-123',
    } as AgentMessage);

    expect(payload.toolName).toBe('read_file');
    expect(payload.toolResult).toEqual({ content: 'file content' });
    expect(payload.toolCallId).toBe('call-123');
  });
});

// ===========================================================================
// MessageAdapter.normalize — permission-request
// ===========================================================================

describe('MessageAdapter.normalize — permission-request', () => {
  it('maps id, reason, and payload', () => {
    const payload = makeAdapter().normalize({
      type: 'permission-request',
      id: 'req-001',
      reason: 'needs write access',
      payload: { tool: 'write_file' },
    } as AgentMessage);

    expect(payload.permissionId).toBe('req-001');
    expect(payload.permissionReason).toBe('needs write access');
    expect(payload.permissionPayload).toEqual({ tool: 'write_file' });
  });
});

// ===========================================================================
// MessageAdapter.normalize — permission-response
// ===========================================================================

describe('MessageAdapter.normalize — permission-response', () => {
  it('maps id and approved', () => {
    const payload = makeAdapter().normalize({
      type: 'permission-response',
      id: 'req-001',
      approved: true,
    } as AgentMessage);

    expect(payload.permissionId).toBe('req-001');
    expect(payload.permissionApproved).toBe(true);
  });
});

// ===========================================================================
// MessageAdapter.normalize — fs-edit
// ===========================================================================

describe('MessageAdapter.normalize — fs-edit', () => {
  it('maps description, diff, and path', () => {
    const payload = makeAdapter().normalize({
      type: 'fs-edit',
      description: 'Added function',
      diff: '+ function foo() {}',
      path: 'src/utils.ts',
    } as AgentMessage);

    expect(payload.editDescription).toBe('Added function');
    expect(payload.editDiff).toBe('+ function foo() {}');
    expect(payload.editPath).toBe('src/utils.ts');
  });
});

// ===========================================================================
// MessageAdapter.normalize — terminal-output
// ===========================================================================

describe('MessageAdapter.normalize — terminal-output', () => {
  it('maps data to terminalData', () => {
    const payload = makeAdapter().normalize({
      type: 'terminal-output',
      data: 'npm install done',
    } as AgentMessage);

    expect(payload.terminalData).toBe('npm install done');
  });
});

// ===========================================================================
// MessageAdapter.normalize — event
// ===========================================================================

describe('MessageAdapter.normalize — event', () => {
  it('maps name and payload to eventName / eventPayload', () => {
    const payload = makeAdapter().normalize({
      type: 'event',
      name: 'session-start',
      payload: { context: 'ci' },
    } as AgentMessage);

    expect(payload.eventName).toBe('session-start');
    expect(payload.eventPayload).toEqual({ context: 'ci' });
  });
});

// ===========================================================================
// MessageAdapter.normalize — token-count
// ===========================================================================

describe('MessageAdapter.normalize — token-count', () => {
  it('places the token-count message under tokenCount field', () => {
    const msg: AgentMessage = {
      type: 'token-count',
      inputTokens: 100,
      outputTokens: 200,
      estimatedCostUsd: 0.001,
    } as AgentMessage;

    const payload = makeAdapter().normalize(msg);

    expect(payload.type).toBe('token-count');
    expect(payload.tokenCount).toBeDefined();
    expect((payload.tokenCount as any).inputTokens).toBe(100);
  });
});

// ===========================================================================
// MessageAdapter.normalize — includeRaw option
// ===========================================================================

describe('MessageAdapter — includeRaw option', () => {
  it('attaches _raw when includeRaw is true', () => {
    const adapter = new MessageAdapter({ agentType: 'claude', includeRaw: true });
    const msg: AgentMessage = { type: 'status', status: 'idle' };

    const payload = adapter.normalize(msg);
    expect(payload._raw).toEqual(msg);
  });

  it('does NOT attach _raw when includeRaw is false (default)', () => {
    const payload = makeAdapter().normalize({ type: 'status', status: 'idle' });
    expect(payload._raw).toBeUndefined();
  });
});

// ===========================================================================
// createMessageAdapter
// ===========================================================================

describe('createMessageAdapter', () => {
  it('returns a MessageAdapter with the specified agentType', () => {
    const adapter = createMessageAdapter('opencode');
    expect(adapter.agentType).toBe('opencode');
  });

  it('respects optional config overrides', () => {
    const adapter = createMessageAdapter('codex', { includeRaw: true });
    const payload = adapter.normalize({ type: 'status', status: 'idle' });
    expect(payload._raw).toBeDefined();
  });
});

// ===========================================================================
// adapters singleton
// ===========================================================================

describe('adapters singleton', () => {
  it('exposes a pre-configured adapter for each core agent type', () => {
    expect(adapters.gemini.agentType).toBe('gemini');
    expect(adapters.codex.agentType).toBe('codex');
    expect(adapters.claude.agentType).toBe('claude');
    expect(adapters.opencode.agentType).toBe('opencode');
    expect(adapters.aider.agentType).toBe('aider');
  });

  it('all singleton adapters produce valid toMobile output', () => {
    const msg: AgentMessage = { type: 'status', status: 'idle' };
    for (const adapter of Object.values(adapters)) {
      const result = adapter.toMobile(msg);
      expect(result.role).toBe('agent');
      expect(result.content.data).toBeDefined();
    }
  });
});
