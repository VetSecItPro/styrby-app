/**
 * Tests for useChatSend hook.
 *
 * WHY: useChatSend is the critical send-flow hook — it gates on connection state,
 * creates sessions, builds optimistic messages, optionally encrypts, and dispatches
 * via the relay. Bugs here silently drop user messages or corrupt session state.
 *
 * Strategy: inject all deps as jest mocks so the callback path is exercised
 * without rendering any React Native UI. renderHook from @testing-library/react-native
 * is not available in node env, but useChatSend only wraps useCallback — we call it
 * via renderHook polyfilled via React's act.
 *
 * @module components/chat/hooks/__tests__/useChatSend
 */

// ============================================================================
// Module mocks (must be before imports)
// ============================================================================

jest.mock('@/lib/supabase', () => ({
  supabase: {
    auth: { getUser: jest.fn(), getSession: jest.fn() },
    from: jest.fn(),
  },
}));

// WHY: The source file imports from '../../../services/encryption' (relative from hooks/).
// Jest resolves jest.mock paths relative to the test file, so we use the @/ alias which
// maps to src/ — same absolute destination as the source file's relative import.
jest.mock('@/services/encryption', () => ({
  encryptMessage: jest.fn<Promise<any>, any[]>(async () => ({ encrypted: 'enc-base64', nonce: 'nonce-base64' })),
}));

/** Capture createSession / saveMessageToDb calls for assertion. */
const mockCreateSession = jest.fn<Promise<any>, any[]>(async () => 'session-abc');
const mockSaveMessageToDb = jest.fn<Promise<any>, any[]>(async () => {});

jest.mock('../../chat-session', () => ({
  createSession: (...args: unknown[]) => mockCreateSession(...args),
  saveMessageToDb: (...args: unknown[]) => mockSaveMessageToDb(...args),
}));

jest.mock('../../agent-config', () => ({
  chatLogger: { error: jest.fn(), log: jest.fn(), warn: jest.fn() },
}));

// ============================================================================
// Imports
// ============================================================================

import React from 'react';
import { act } from 'react';
import { renderHook } from '@testing-library/react-native';
import { useChatSend } from '../useChatSend';
import { encryptMessage } from '@/services/encryption';
import type { UseChatSendDeps } from '../useChatSend';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Builds a full deps object with sensible defaults. Override per-test with
 * spread syntax.
 */
function buildDeps(overrides: Partial<UseChatSendDeps> = {}): UseChatSendDeps {
  return {
    inputText: 'hello world',
    isConnected: true,
    selectedAgent: 'claude',
    sessionId: null,
    pairingInfo: null,
    sendMessage: jest.fn<Promise<any>, any[]>(async () => {}),
    sessionCreationLockRef: { current: false },
    setMessages: jest.fn(),
    setInputText: jest.fn(),
    setIsLoading: jest.fn(),
    setAgentState: jest.fn(),
    setIsAgentThinking: jest.fn(),
    setSessionId: jest.fn(),
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('useChatSend', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // Guard rails
  // --------------------------------------------------------------------------

  it('does nothing when inputText is empty', async () => {
    const deps = buildDeps({ inputText: '' });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current();
    });

    expect(deps.sendMessage).not.toHaveBeenCalled();
    expect(deps.setMessages).not.toHaveBeenCalled();
  });

  it('does nothing when inputText is only whitespace', async () => {
    const deps = buildDeps({ inputText: '   ' });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current();
    });

    expect(deps.sendMessage).not.toHaveBeenCalled();
  });

  it('does nothing when not connected', async () => {
    const deps = buildDeps({ isConnected: false });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current();
    });

    expect(deps.sendMessage).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // Happy path — no existing session
  // --------------------------------------------------------------------------

  it('appends an optimistic user message immediately', async () => {
    const deps = buildDeps();
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current();
    });

    expect(deps.setMessages).toHaveBeenCalledWith(expect.any(Function));
    // Extract the updater and check what it returns
    const updater = (deps.setMessages as jest.Mock).mock.calls[0][0];
    const next = updater([]);
    expect(next).toHaveLength(1);
    expect(next[0].role).toBe('user');
    expect(next[0].content[0].content).toBe('hello world');
  });

  it('clears the input immediately', async () => {
    const deps = buildDeps();
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current();
    });

    expect(deps.setInputText).toHaveBeenCalledWith('');
  });

  it('sets loading and agent state to thinking', async () => {
    const deps = buildDeps();
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current();
    });

    expect(deps.setIsLoading).toHaveBeenCalledWith(true);
    expect(deps.setAgentState).toHaveBeenCalledWith('thinking');
    expect(deps.setIsAgentThinking).toHaveBeenCalledWith(true);
  });

  it('creates a new session when sessionId is null', async () => {
    const deps = buildDeps({ sessionId: null });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current();
    });

    expect(mockCreateSession).toHaveBeenCalledWith(
      'claude', 'hello world', null, null, deps.sessionCreationLockRef,
    );
    expect(deps.setSessionId).toHaveBeenCalledWith('session-abc');
  });

  it('does NOT create a session when sessionId already exists', async () => {
    const deps = buildDeps({ sessionId: 'existing-session' });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current();
    });

    expect(mockCreateSession).not.toHaveBeenCalled();
    expect(deps.setSessionId).not.toHaveBeenCalled();
  });

  it('persists the user message after session creation', async () => {
    const deps = buildDeps({ sessionId: null });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current();
    });

    expect(mockSaveMessageToDb).toHaveBeenCalledWith(
      'session-abc',
      expect.stringMatching(/^msg_/),
      'user',
      'hello world',
      null,
    );
  });

  it('sends a relay message with trimmed content', async () => {
    const deps = buildDeps({ inputText: '  trimmed  ' });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current();
    });

    expect(deps.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'chat',
        payload: expect.objectContaining({ content: 'trimmed' }),
      }),
    );
  });

  it('includes session_id in the relay payload', async () => {
    const deps = buildDeps({ sessionId: 'existing-session' });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current();
    });

    expect(deps.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ session_id: 'existing-session' }),
      }),
    );
  });

  // --------------------------------------------------------------------------
  // E2E encryption path
  // --------------------------------------------------------------------------

  it('encrypts the relay payload when pairingInfo is present', async () => {
    const deps = buildDeps({
      pairingInfo: { machineId: 'machine-1', userId: 'u1', deviceName: 'MBP', pairedAt: '' },
    });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current();
    });

    expect(encryptMessage).toHaveBeenCalledWith('hello world', 'machine-1');
    expect(deps.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          encrypted_content: 'enc-base64',
          nonce: 'nonce-base64',
          content: '', // cleared when encrypted
        }),
      }),
    );
  });

  it('falls back to plaintext when encryption throws', async () => {
    (encryptMessage as jest.Mock).mockRejectedValueOnce(new Error('encrypt fail'));
    const deps = buildDeps({
      pairingInfo: { machineId: 'machine-1', userId: 'u1', deviceName: 'MBP', pairedAt: '' },
    });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current();
    });

    // Should still call sendMessage with plaintext content
    expect(deps.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ content: 'hello world' }),
      }),
    );
  });

  // --------------------------------------------------------------------------
  // Error path
  // --------------------------------------------------------------------------

  it('appends an error message and resets state when sendMessage throws', async () => {
    const deps = buildDeps({
      sendMessage: jest.fn<Promise<any>, any[]>(async () => { throw new Error('relay down'); }),
    });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current();
    });

    // setMessages is called twice: once for optimistic, once for error
    const calls = (deps.setMessages as jest.Mock).mock.calls;
    expect(calls.length).toBe(2);

    const errorUpdater = calls[1][0];
    const errorMessages = errorUpdater([]);
    expect(errorMessages[0].role).toBe('error');
    expect(errorMessages[0].content[0].content).toContain('Failed to send');

    expect(deps.setAgentState).toHaveBeenCalledWith('idle');
    expect(deps.setIsAgentThinking).toHaveBeenCalledWith(false);
    expect(deps.setIsLoading).toHaveBeenCalledWith(false);
  });

  // --------------------------------------------------------------------------
  // Agent fallback
  // --------------------------------------------------------------------------

  it('defaults to claude agent when selectedAgent is null', async () => {
    const deps = buildDeps({ selectedAgent: null });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current();
    });

    expect(deps.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ agent: 'claude' }),
      }),
    );
  });
});
