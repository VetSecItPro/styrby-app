/**
 * Tests for useRelayMessageHandler hook.
 *
 * WHY: This hook is the single routing layer for all incoming relay messages
 * (agent responses, permission requests, session state updates). A bug here
 * means users see wrong state or lose messages silently.
 *
 * Strategy: drive the effect by passing different `lastMessage` values to
 * renderHook and asserting the correct setters were called.
 *
 * @module components/chat/hooks/__tests__/useRelayMessageHandler
 */

// ============================================================================
// Module mocks
// ============================================================================

jest.mock('@/lib/supabase', () => ({
  supabase: { auth: { getUser: jest.fn() }, from: jest.fn() },
}));

const mockDecryptMessage = jest.fn<Promise<any>, any[]>(async () => 'decrypted-content');
jest.mock('@/services/encryption', () => ({
  decryptMessage: (...args: unknown[]) => mockDecryptMessage(...args),
}));

const mockSaveMessageToDb = jest.fn<Promise<any>, any[]>(async () => {});
jest.mock('../../chat-session', () => ({
  saveMessageToDb: (...args: unknown[]) => mockSaveMessageToDb(...args),
  createSession: jest.fn<Promise<any>, any[]>(async () => null),
}));

jest.mock('../../agent-config', () => ({
  chatLogger: { error: jest.fn(), log: jest.fn(), warn: jest.fn() },
  DECRYPTION_FAILED_PLACEHOLDER: '[Decryption failed]',
}));

// ============================================================================
// Imports
// ============================================================================

import { act } from 'react';
import { renderHook } from '@testing-library/react-native';
import { useRelayMessageHandler } from '../useRelayMessageHandler';
import type { RelayMessageHandlerDeps } from '../useRelayMessageHandler';

// ============================================================================
// Helpers
// ============================================================================

function buildDeps(overrides: Partial<RelayMessageHandlerDeps> = {}): RelayMessageHandlerDeps {
  return {
    lastMessage: null,
    sessionId: 'session-1',
    pairingInfo: null,
    setMessages: jest.fn(),
    setPendingPermissions: jest.fn(),
    setAgentState: jest.fn(),
    setIsAgentThinking: jest.fn(),
    setIsLoading: jest.fn(),
    ...overrides,
  };
}

function buildAgentResponseMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg-1',
    type: 'agent_response',
    timestamp: '2026-04-20T00:00:00Z',
    payload: {
      content: 'Hello from agent',
      agent_type: 'claude',
      cost_usd: 0.005,
      duration_ms: 1200,
      is_complete: true,
      tokens: { input: 10, output: 20 },
      ...overrides,
    },
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('useRelayMessageHandler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // --------------------------------------------------------------------------
  // No-op guard
  // --------------------------------------------------------------------------

  it('does nothing when lastMessage is null', () => {
    const deps = buildDeps({ lastMessage: null });
    renderHook(() => useRelayMessageHandler(deps));

    expect(deps.setMessages).not.toHaveBeenCalled();
    expect(deps.setAgentState).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // agent_response — plaintext
  // --------------------------------------------------------------------------

  it('appends an assistant message on agent_response (plaintext)', async () => {
    const deps = buildDeps({
      lastMessage: buildAgentResponseMessage() as never,
    });
    const { rerender } = renderHook(() => useRelayMessageHandler(deps));
    await act(async () => { (rerender as () => void)(); });

    expect(deps.setMessages).toHaveBeenCalledWith(expect.any(Function));
    const updater = (deps.setMessages as jest.Mock).mock.calls[0][0];
    const next = updater([]);
    expect(next[0].role).toBe('assistant');
    expect(next[0].content[0].content).toBe('Hello from agent');
  });

  it('resets agent state to idle on complete response', async () => {
    const deps = buildDeps({
      lastMessage: buildAgentResponseMessage({ is_complete: true }) as never,
    });
    const { rerender } = renderHook(() => useRelayMessageHandler(deps));
    await act(async () => { (rerender as () => void)(); });

    expect(deps.setAgentState).toHaveBeenCalledWith('idle');
    expect(deps.setIsAgentThinking).toHaveBeenCalledWith(false);
    expect(deps.setIsLoading).toHaveBeenCalledWith(false);
  });

  it('does NOT reset state when is_complete is explicitly false (streaming chunk)', async () => {
    const deps = buildDeps({
      lastMessage: buildAgentResponseMessage({ is_complete: false }) as never,
    });
    const { rerender } = renderHook(() => useRelayMessageHandler(deps));
    await act(async () => { (rerender as () => void)(); });

    expect(deps.setAgentState).not.toHaveBeenCalledWith('idle');
  });

  it('persists the message to Supabase when sessionId is set', async () => {
    const deps = buildDeps({
      lastMessage: buildAgentResponseMessage() as never,
      sessionId: 'session-x',
    });
    const { rerender } = renderHook(() => useRelayMessageHandler(deps));
    await act(async () => { (rerender as () => void)(); });

    expect(mockSaveMessageToDb).toHaveBeenCalledWith(
      'session-x',
      'msg-1',
      'assistant',
      'Hello from agent',
      null,
      expect.objectContaining({ costUsd: 0.005 }),
    );
  });

  it('does not persist when sessionId is null', async () => {
    const deps = buildDeps({
      lastMessage: buildAgentResponseMessage() as never,
      sessionId: null,
    });
    const { rerender } = renderHook(() => useRelayMessageHandler(deps));
    await act(async () => { (rerender as () => void)(); });

    expect(mockSaveMessageToDb).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // agent_response — E2E decryption
  // --------------------------------------------------------------------------

  it('decrypts encrypted_content when pairingInfo is present', async () => {
    const deps = buildDeps({
      pairingInfo: { machineId: 'machine-1', userId: 'u1', deviceName: 'MBP', pairedAt: '' },
      lastMessage: buildAgentResponseMessage({
        encrypted_content: 'enc-data',
        nonce: 'nonce-val',
        content: '',
      }) as never,
    });
    const { rerender } = renderHook(() => useRelayMessageHandler(deps));
    await act(async () => { (rerender as () => void)(); });

    expect(mockDecryptMessage).toHaveBeenCalledWith('enc-data', 'nonce-val', 'machine-1');
    const updater = (deps.setMessages as jest.Mock).mock.calls[0][0];
    expect(updater([])[0].content[0].content).toBe('decrypted-content');
  });

  it('falls back to placeholder when decryption throws', async () => {
    mockDecryptMessage.mockRejectedValueOnce(new Error('bad key'));
    const deps = buildDeps({
      pairingInfo: { machineId: 'machine-1', userId: 'u1', deviceName: 'MBP', pairedAt: '' },
      lastMessage: buildAgentResponseMessage({
        encrypted_content: 'enc-data',
        nonce: 'nonce-val',
        content: '',
      }) as never,
    });
    const { rerender } = renderHook(() => useRelayMessageHandler(deps));
    await act(async () => { (rerender as () => void)(); });

    const updater = (deps.setMessages as jest.Mock).mock.calls[0][0];
    expect(updater([])[0].content[0].content).toBe('[Decryption failed]');
  });

  // --------------------------------------------------------------------------
  // permission_request
  // --------------------------------------------------------------------------

  it('appends a PermissionRequest and sets waiting_permission state', async () => {
    const deps = buildDeps({
      lastMessage: {
        id: 'perm-msg-1',
        type: 'permission_request',
        timestamp: '2026-04-20T00:00:00Z',
        payload: {
          request_id: 'req-1',
          session_id: 'session-1',
          agent: 'claude',
          tool_name: 'bash',
          description: 'Run npm test',
          risk_level: 'high',
          expires_at: '2026-04-20T01:00:00Z',
          affected_files: ['/src/index.ts'],
          nonce: 'nonce-x',
        },
      } as never,
    });
    const { rerender } = renderHook(() => useRelayMessageHandler(deps));
    await act(async () => { (rerender as () => void)(); });

    expect(deps.setPendingPermissions).toHaveBeenCalledWith(expect.any(Function));
    const permUpdater = (deps.setPendingPermissions as jest.Mock).mock.calls[0][0];
    const perms = permUpdater([]);
    expect(perms[0]).toMatchObject({
      id: 'req-1',
      type: 'bash',
      riskLevel: 'high',
      filePath: '/src/index.ts',
    });

    expect(deps.setAgentState).toHaveBeenCalledWith('waiting_permission');
  });

  // --------------------------------------------------------------------------
  // permission_response
  // --------------------------------------------------------------------------

  it('removes the permission card after 1500ms delay', async () => {
    const deps = buildDeps({
      lastMessage: {
        id: 'resp-1',
        type: 'permission_response',
        timestamp: '2026-04-20T00:00:00Z',
        payload: { request_id: 'req-1' },
      } as never,
    });
    const { rerender } = renderHook(() => useRelayMessageHandler(deps));
    await act(async () => { (rerender as () => void)(); });

    // Timer not fired yet
    expect(deps.setPendingPermissions).not.toHaveBeenCalled();

    // Advance timers
    await act(async () => { jest.advanceTimersByTime(1500); });
    expect(deps.setPendingPermissions).toHaveBeenCalledWith(expect.any(Function));
    const filterFn = (deps.setPendingPermissions as jest.Mock).mock.calls[0][0];
    const filtered = filterFn([{ id: 'req-1' }, { id: 'req-2' }]);
    expect(filtered).toEqual([{ id: 'req-2' }]);
  });

  // --------------------------------------------------------------------------
  // session_state
  // --------------------------------------------------------------------------

  it('updates agentState to thinking on session_state message', async () => {
    const deps = buildDeps({
      lastMessage: {
        id: 'ss-1',
        type: 'session_state',
        timestamp: '2026-04-20T00:00:00Z',
        payload: { state: 'thinking' },
      } as never,
    });
    const { rerender } = renderHook(() => useRelayMessageHandler(deps));
    await act(async () => { (rerender as () => void)(); });

    expect(deps.setAgentState).toHaveBeenCalledWith('thinking');
    expect(deps.setIsAgentThinking).toHaveBeenCalledWith(true);
  });

  it('clears loading state when session_state is idle', async () => {
    const deps = buildDeps({
      lastMessage: {
        id: 'ss-2',
        type: 'session_state',
        timestamp: '2026-04-20T00:00:00Z',
        payload: { state: 'idle' },
      } as never,
    });
    const { rerender } = renderHook(() => useRelayMessageHandler(deps));
    await act(async () => { (rerender as () => void)(); });

    expect(deps.setAgentState).toHaveBeenCalledWith('idle');
    expect(deps.setIsAgentThinking).toHaveBeenCalledWith(false);
    expect(deps.setIsLoading).toHaveBeenCalledWith(false);
  });

  it('sets isAgentThinking true for executing state', async () => {
    const deps = buildDeps({
      lastMessage: {
        id: 'ss-3',
        type: 'session_state',
        timestamp: '2026-04-20T00:00:00Z',
        payload: { state: 'executing' },
      } as never,
    });
    const { rerender } = renderHook(() => useRelayMessageHandler(deps));
    await act(async () => { (rerender as () => void)(); });

    expect(deps.setIsAgentThinking).toHaveBeenCalledWith(true);
  });
});
