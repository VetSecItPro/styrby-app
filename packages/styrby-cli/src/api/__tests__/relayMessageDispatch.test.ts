/**
 * Tests for the pure relay-message classifier (security-critical).
 *
 * Coverage target: 0% → ~100% on classifyRelayMessage.
 *
 * SECURITY: this classifier is the gate between mobile-sent messages and
 * the agent's tool-execution + sendPrompt surface. Bugs here are either
 * silent message loss (UX) OR — in the case of the nonce check —
 * compromised-account-key bypass of the approval gate (RCE-class).
 *
 * Test categories match the classifier's decision sequence:
 *   1. Schema validation (CLI-008)
 *   2. Nonce verification on permission_response (CLI-009)
 *   3. Cross-session protection on chat
 *   4. Type-specific routing for chat / permission-response / command
 *   5. Unhandled-type / unhandled-command catch-alls
 *
 * @module api/__tests__/relayMessageDispatch
 */

import { describe, it, expect, vi } from 'vitest';
import { classifyRelayMessage, type NonceVerifier } from '@/api/relayMessageDispatch';

const SESSION_ID = 'session-abc';

/** Always-true nonce verifier. Used in tests that don't focus on the nonce gate. */
const ALWAYS_OK: NonceVerifier = () => true;
/** Always-false nonce verifier — simulates a forged nonce. */
const ALWAYS_REJECT: NonceVerifier = () => false;

/** Required base fields that every relay message has per styrby-shared schema. */
const BASE = {
  id: 'msg-1',
  timestamp: '2026-05-05T20:00:00Z',
  sender_device_id: 'device-mobile-1',
  sender_type: 'mobile' as const,
};

/** Build a valid chat message with the given payload overrides. */
function chat(payload: { content: string; agent?: string; session_id?: string }) {
  return {
    ...BASE,
    type: 'chat' as const,
    payload: { agent: 'claude', ...payload },
  };
}

/** Build a valid permission_response with the given payload overrides. */
function permResponse(payload: { request_id: string; request_nonce: string; approved: boolean; agent?: string }) {
  return {
    ...BASE,
    type: 'permission_response' as const,
    payload: { agent: 'claude', ...payload },
  };
}

/** Build a valid command message, optionally scoped to a target session. */
function command(action: string, agent?: string, params?: Record<string, unknown>) {
  return {
    ...BASE,
    type: 'command' as const,
    payload: { agent: agent ?? 'claude', action, ...(params ? { params } : {}) },
  };
}

describe('classifyRelayMessage: schema validation (CLI-008)', () => {
  it('drops a non-object payload', () => {
    const verdict = classifyRelayMessage(SESSION_ID, 'just a string', ALWAYS_OK);
    expect(verdict.action).toBe('drop-schema-invalid');
  });

  it('drops a payload missing required `type` discriminator', () => {
    const verdict = classifyRelayMessage(SESSION_ID, { ...BASE, payload: { content: 'hi' } }, ALWAYS_OK);
    expect(verdict.action).toBe('drop-schema-invalid');
  });

  it('drops a payload with unknown `type` value', () => {
    const verdict = classifyRelayMessage(
      SESSION_ID,
      { ...BASE, type: 'bogus-type', payload: { content: 'x' } },
      ALWAYS_OK,
    );
    expect(verdict.action).toBe('drop-schema-invalid');
  });

  it('drops a chat with non-string content', () => {
    const verdict = classifyRelayMessage(
      SESSION_ID,
      { ...BASE, type: 'chat', payload: { content: 12345, agent: 'claude' } },
      ALWAYS_OK,
    );
    expect(verdict.action).toBe('drop-schema-invalid');
  });

  it('drops a chat missing required base fields (id/timestamp/etc)', () => {
    const verdict = classifyRelayMessage(
      SESSION_ID,
      { type: 'chat', payload: { content: 'hi', agent: 'claude' } },
      ALWAYS_OK,
    );
    expect(verdict.action).toBe('drop-schema-invalid');
  });

  it('captures issues array (limited to 5) on schema-invalid', () => {
    const verdict = classifyRelayMessage(SESSION_ID, { type: 'chat' /* missing all */ }, ALWAYS_OK);
    if (verdict.action !== 'drop-schema-invalid') throw new Error('expected schema invalid');
    expect(verdict.issues).toBeDefined();
    expect(Array.isArray(verdict.issues)).toBe(true);
    expect(verdict.issues.length).toBeLessThanOrEqual(5);
  });

  it('preserves the original (unverified) `type` in the drop verdict for logging', () => {
    const verdict = classifyRelayMessage(
      SESSION_ID,
      { ...BASE, type: 'sneaky-type', payload: {} },
      ALWAYS_OK,
    );
    if (verdict.action !== 'drop-schema-invalid') throw new Error('expected schema invalid');
    expect(verdict.type).toBe('sneaky-type');
  });
});

describe('classifyRelayMessage: nonce verification (CLI-009)', () => {
  const validPermissionResponse = permResponse({ request_id: 'req-123', request_nonce: 'nonce-abc', approved: true });

  it('drops permission_response when verifyNonce returns false', () => {
    const verdict = classifyRelayMessage(SESSION_ID, validPermissionResponse, ALWAYS_REJECT);
    expect(verdict.action).toBe('drop-nonce-mismatch');
    if (verdict.action === 'drop-nonce-mismatch') {
      expect(verdict.requestId).toBe('req-123');
    }
  });

  it('forwards permission_response when verifyNonce returns true', () => {
    const verdict = classifyRelayMessage(SESSION_ID, validPermissionResponse, ALWAYS_OK);
    expect(verdict.action).toBe('permission-response');
    if (verdict.action === 'permission-response') {
      expect(verdict.requestId).toBe('req-123');
      expect(verdict.approved).toBe(true);
    }
  });

  it('CALLS verifyNonce with request_id + request_nonce (consumes the nonce)', () => {
    const verifyMock = vi.fn(() => true);
    classifyRelayMessage(SESSION_ID, validPermissionResponse, verifyMock);
    expect(verifyMock).toHaveBeenCalledTimes(1);
    expect(verifyMock).toHaveBeenCalledWith('req-123', 'nonce-abc');
  });

  it('does NOT call verifyNonce on chat messages', () => {
    const verifyMock = vi.fn(() => true);
    classifyRelayMessage(SESSION_ID, chat({ content: 'hi' }), verifyMock);
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it('does NOT call verifyNonce on command messages', () => {
    const verifyMock = vi.fn(() => true);
    classifyRelayMessage(SESSION_ID, command('cancel'), verifyMock);
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it('passes denied=false through the verdict (only nonce gates the dispatch)', () => {
    const verdict = classifyRelayMessage(
      SESSION_ID,
      permResponse({ request_id: 'r', request_nonce: 'n', approved: false }),
      ALWAYS_OK,
    );
    expect(verdict.action).toBe('permission-response');
    if (verdict.action === 'permission-response') {
      expect(verdict.approved).toBe(false);
    }
  });
});

describe('classifyRelayMessage: chat routing + cross-session protection', () => {
  it('forwards chat with no session_id to the current session', () => {
    const verdict = classifyRelayMessage(SESSION_ID, chat({ content: 'hello agent' }), ALWAYS_OK);
    expect(verdict.action).toBe('chat');
    if (verdict.action === 'chat') {
      expect(verdict.sessionId).toBe(SESSION_ID);
      expect(verdict.content).toBe('hello agent');
    }
  });

  it('forwards chat targeted at the current session_id', () => {
    const verdict = classifyRelayMessage(SESSION_ID, chat({ content: 'hi', session_id: SESSION_ID }), ALWAYS_OK);
    expect(verdict.action).toBe('chat');
  });

  it('drops chat targeted at a different session_id', () => {
    const verdict = classifyRelayMessage(SESSION_ID, chat({ content: 'hi', session_id: 'session-other' }), ALWAYS_OK);
    expect(verdict.action).toBe('drop-wrong-session');
    if (verdict.action === 'drop-wrong-session') {
      expect(verdict.targetSession).toBe('session-other');
    }
  });
});

describe('classifyRelayMessage: command routing', () => {
  it('routes command:cancel to action=cancel', () => {
    expect(classifyRelayMessage(SESSION_ID, command('cancel'), ALWAYS_OK).action).toBe('cancel');
  });

  it('routes command:interrupt to action=cancel (alias)', () => {
    expect(classifyRelayMessage(SESSION_ID, command('interrupt'), ALWAYS_OK).action).toBe('cancel');
  });

  it('routes command:end_session to action=end-session', () => {
    expect(classifyRelayMessage(SESSION_ID, command('end_session'), ALWAYS_OK).action).toBe('end-session');
  });

  it('routes command:ping to action=ping (no-op)', () => {
    expect(classifyRelayMessage(SESSION_ID, command('ping'), ALWAYS_OK).action).toBe('ping');
  });

  it('drops unknown command actions with the action name preserved for logging', () => {
    const verdict = classifyRelayMessage(SESSION_ID, command('shutdown-everything'), ALWAYS_OK);
    // Unknown action may either be schema-rejected (if schema enums actions)
    // or fall through to drop-unhandled-command. Either is correct dropped
    // behavior — assert it's NOT a forwarded action.
    expect(verdict.action).toMatch(/drop-/);
  });
});

describe('classifyRelayMessage: cancel/end-session carry the current session_id', () => {
  it('cancel verdict carries sessionId', () => {
    const verdict = classifyRelayMessage(SESSION_ID, command('cancel'), ALWAYS_OK);
    if (verdict.action !== 'cancel') throw new Error('expected cancel');
    expect(verdict.sessionId).toBe(SESSION_ID);
  });

  it('end-session verdict carries sessionId', () => {
    const verdict = classifyRelayMessage(SESSION_ID, command('end_session'), ALWAYS_OK);
    if (verdict.action !== 'end-session') throw new Error('expected end-session');
    expect(verdict.sessionId).toBe(SESSION_ID);
  });
});

describe('classifyRelayMessage: command cross-session scoping (audit fix #9)', () => {
  // WHY: a cancel/interrupt/end_session command previously fanned out to EVERY
  // active session on the daemon because it had no session targeting. Cancelling
  // session A also killed session B. Commands now carry params.session_id and are
  // dropped when they target a DIFFERENT session than the one being processed,
  // mirroring the chat cross-session guard.

  it('drops a cancel targeted at a DIFFERENT session', () => {
    const verdict = classifyRelayMessage(
      SESSION_ID,
      command('cancel', 'claude', { session_id: 'some-other-session' }),
      ALWAYS_OK,
    );
    expect(verdict.action).toBe('drop-wrong-session');
    if (verdict.action !== 'drop-wrong-session') throw new Error('expected drop-wrong-session');
    expect(verdict.targetSession).toBe('some-other-session');
  });

  it('drops an interrupt targeted at a DIFFERENT session', () => {
    const verdict = classifyRelayMessage(
      SESSION_ID,
      command('interrupt', 'claude', { session_id: 'other' }),
      ALWAYS_OK,
    );
    expect(verdict.action).toBe('drop-wrong-session');
  });

  it('drops an end_session targeted at a DIFFERENT session', () => {
    const verdict = classifyRelayMessage(
      SESSION_ID,
      command('end_session', 'claude', { session_id: 'other' }),
      ALWAYS_OK,
    );
    expect(verdict.action).toBe('drop-wrong-session');
  });

  it('processes a cancel explicitly targeted at THIS session', () => {
    const verdict = classifyRelayMessage(
      SESSION_ID,
      command('cancel', 'claude', { session_id: SESSION_ID }),
      ALWAYS_OK,
    );
    expect(verdict.action).toBe('cancel');
    if (verdict.action !== 'cancel') throw new Error('expected cancel');
    expect(verdict.sessionId).toBe(SESSION_ID);
  });

  it('still processes a command with NO session_id (backward compatibility)', () => {
    // Single-session clients that omit session_id keep targeting the current
    // session — the fan-out fix must not break them.
    expect(classifyRelayMessage(SESSION_ID, command('cancel'), ALWAYS_OK).action).toBe('cancel');
    expect(classifyRelayMessage(SESSION_ID, command('end_session'), ALWAYS_OK).action).toBe(
      'end-session',
    );
  });

  it('ignores a non-string session_id and falls through to normal routing', () => {
    // A malformed numeric session_id must not match the string sessionId, but
    // also must not throw — it is simply not a targeting match, so the command
    // targets the current session (legacy behavior).
    const verdict = classifyRelayMessage(
      SESSION_ID,
      command('cancel', 'claude', { session_id: 12345 }),
      ALWAYS_OK,
    );
    expect(verdict.action).toBe('cancel');
  });
});
