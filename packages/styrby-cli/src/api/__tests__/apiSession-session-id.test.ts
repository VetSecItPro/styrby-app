/**
 * Regression test: ApiSessionManager addresses the backend by ITS OWN session id.
 *
 * WHY this exists (2026-06-10, found by live verification): the manager mints a
 * canonical session id (written to Supabase + addressed by mobile), but a
 * backend mints a DIFFERENT id in startSession() and validates against it in
 * sendPrompt()/cancel(). The relay dispatcher previously forwarded the manager
 * id to agent.sendPrompt(), so every chat failed with "Invalid session ID:
 * <managerId>" and no prompt ever reached the agent. The fix threads the
 * backend's real id (startResult.sessionId) onto the agent calls.
 *
 * This test drives a managed session with a fake agent whose startSession()
 * returns a distinct id, fires a relay chat through the captured handler, and
 * asserts sendPrompt was called with the BACKEND id — not the manager id.
 *
 * @module api/__tests__/apiSession-session-id
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@/ui/logger', () => ({
  logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { ApiSessionManager } from '../apiSession';
import type { RelayMessage } from 'styrby-shared';

const BACKEND_ID = 'backend-mint-0000-0000-000000000000';

function makeSupabaseOk() {
  const ok = { error: null };
  const chain = {
    insert: vi.fn(async () => ok),
    update: vi.fn(() => ({ eq: vi.fn(async () => ok) })),
  };
  return { from: vi.fn(() => chain) } as any;
}

function makeFakeAgent() {
  return {
    // The backend mints its OWN id, deliberately != the manager's.
    startSession: vi.fn(async () => ({ sessionId: BACKEND_ID })),
    sendPrompt: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    onMessage: vi.fn(),
    offMessage: vi.fn(),
    dispose: vi.fn(async () => {}),
  } as any;
}

function makeFakeApi() {
  const state: { relayHandler?: (m: RelayMessage) => void } = {};
  const api = {
    onRelayMessage: vi.fn((h: (m: RelayMessage) => void) => { state.relayHandler = h; }),
    offRelayMessage: vi.fn(),
    sendSessionState: vi.fn(async () => {}),
    endSession: vi.fn(async () => {}),
    verifyAndConsumePermissionNonce: vi.fn(() => false),
  } as any;
  return { api, state };
}

function chatMessage(content: string): RelayMessage {
  // No session_id in the payload => the dispatcher forwards to the active
  // session (it only drops on a PRESENT-but-mismatched session_id).
  return {
    id: 'msg-1',
    timestamp: new Date().toISOString(),
    sender_device_id: 'dev-1',
    sender_type: 'web',
    type: 'chat',
    payload: { content, agent: 'claude' },
  } as unknown as RelayMessage;
}

describe('ApiSessionManager session-id threading', () => {
  it('forwards relay chat to agent.sendPrompt using the BACKEND session id', async () => {
    const supabase = makeSupabaseOk();
    const agent = makeFakeAgent();
    const { api, state } = makeFakeApi();

    const mgr = new ApiSessionManager();
    const active = await mgr.startManagedSession({
      supabase,
      api,
      agent,
      agentType: 'claude',
      userId: 'user-1',
      machineId: 'machine-1',
      projectPath: '/tmp/project',
    });

    // The manager's canonical id (returned to mobile) is NOT the backend id.
    expect(active.sessionId).not.toBe(BACKEND_ID);
    expect(state.relayHandler).toBeTypeOf('function');

    // Fire a chat through the captured relay handler.
    state.relayHandler!(chatMessage('do the thing'));
    // Let the async dispatch settle.
    await new Promise((r) => setImmediate(r));

    // The fix: sendPrompt must receive the BACKEND id, not the manager id.
    expect(agent.sendPrompt).toHaveBeenCalledWith(BACKEND_ID, 'do the thing');
    expect(agent.sendPrompt).not.toHaveBeenCalledWith(active.sessionId, 'do the thing');

    await active.stop();
  });
});
