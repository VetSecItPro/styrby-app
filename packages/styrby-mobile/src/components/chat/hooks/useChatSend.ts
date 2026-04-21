/**
 * useChatSend
 *
 * Builds the `handleSend` callback used by the chat input bar. Handles
 * session lazy-creation, optimistic message append, optional E2E encryption
 * of the relay payload, and Supabase persistence.
 *
 * WHY a dedicated hook: `handleSend` is ~90 LOC of branching logic. Pulling
 * it into a hook drops complexity from the orchestrator and gives us a
 * single import surface for the entire send flow.
 */

import { useCallback } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { AgentType } from 'styrby-shared';
import type { ChatMessageData } from '../../ChatMessage';
import type { AgentState } from '../../TypingIndicator';
import type { PairingInfo, UseRelayReturn } from '../../../hooks/useRelay';
import { encryptMessage } from '../../../services/encryption';
import { chatLogger as logger } from '../agent-config';
import { createSession, saveMessageToDb } from '../chat-session';

/**
 * Dependencies for {@link useChatSend}.
 */
export interface UseChatSendDeps {
  /** Current input text */
  inputText: string;
  /** Whether the relay socket is connected (gate for sending) */
  isConnected: boolean;
  /** The currently selected agent (used for relay payload + session creation) */
  selectedAgent: AgentType | null;
  /** Current session ID (null until first message) */
  sessionId: string | null;
  /** Pairing info (used for E2E encryption) */
  pairingInfo: PairingInfo | null;
  /** Send function from useRelay */
  sendMessage: UseRelayReturn['sendMessage'];
  /** Lock ref to serialize concurrent session-creation attempts */
  sessionCreationLockRef: MutableRefObject<boolean>;
  setMessages: Dispatch<SetStateAction<ChatMessageData[]>>;
  setInputText: Dispatch<SetStateAction<string>>;
  setIsLoading: Dispatch<SetStateAction<boolean>>;
  setAgentState: Dispatch<SetStateAction<AgentState>>;
  setIsAgentThinking: Dispatch<SetStateAction<boolean>>;
  setSessionId: Dispatch<SetStateAction<string | null>>;
}

/**
 * Returns a memoized `handleSend` callback bound to the supplied deps.
 *
 * @returns Async callback wired to the send button
 */
export function useChatSend(deps: UseChatSendDeps): () => Promise<void> {
  const {
    inputText,
    isConnected,
    selectedAgent,
    sessionId,
    pairingInfo,
    sendMessage,
    sessionCreationLockRef,
    setMessages,
    setInputText,
    setIsLoading,
    setAgentState,
    setIsAgentThinking,
    setSessionId,
  } = deps;

  return useCallback(async () => {
    if (!inputText.trim() || !isConnected) return;

    const content = inputText.trim();
    // WHY: crypto.randomUUID() is available in Hermes (React Native) and
    // provides cryptographic uniqueness — Math.random() is not CSPRNG.
    const messageId = `msg_${crypto.randomUUID()}`;

    const userMessage: ChatMessageData = {
      id: messageId,
      role: 'user',
      content: [{ type: 'text', content }],
      timestamp: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInputText('');
    setIsLoading(true);
    setAgentState('thinking');
    setIsAgentThinking(true);

    const machineId = pairingInfo?.machineId ?? null;

    // Ensure we have a session
    let currentSessionId = sessionId;
    if (!currentSessionId) {
      currentSessionId = await createSession(
        selectedAgent,
        content,
        machineId,
        sessionId,
        sessionCreationLockRef,
      );
      if (currentSessionId) setSessionId(currentSessionId);
    }

    // Persist the user message
    if (currentSessionId) {
      void saveMessageToDb(currentSessionId, messageId, 'user', content, machineId);
    }

    try {
      // WHY: When a paired machine is available, encrypt the relay payload
      // so the message content is protected in transit via Supabase Realtime.
      // The CLI will decrypt using its secret key + mobile's public key.
      // If encryption fails, fall back to plaintext relay (CLI handles both).
      let relayPayload: {
        content: string;
        agent: AgentType;
        session_id?: string;
        encrypted_content?: string;
        nonce?: string;
      } = {
        content,
        agent: selectedAgent ?? 'claude',
        session_id: currentSessionId ?? undefined,
      };

      if (machineId) {
        try {
          const encrypted = await encryptMessage(content, machineId);
          relayPayload = {
            ...relayPayload,
            encrypted_content: encrypted.encrypted,
            nonce: encrypted.nonce,
            // WHY: Set content to empty to signal encryption to the CLI.
            // The CLI checks for encrypted_content first.
            content: '',
          };
        } catch (encryptError) {
          // WHY: Relay-encryption failure is non-fatal. Send plaintext so
          // the message reaches the CLI. Common during initial pairing.
          logger.error('Relay encryption failed, sending plaintext:', encryptError);
        }
      }

      await sendMessage({
        type: 'chat',
        payload: relayPayload,
      });
    } catch {
      const errorId = `error_${Date.now()}`;
      const errorContent = 'Failed to send message. Please try again.';

      setMessages((prev) => [
        ...prev,
        {
          id: errorId,
          role: 'error',
          content: [{ type: 'text', content: errorContent }],
          timestamp: new Date().toISOString(),
        },
      ]);

      // WHY: Reset agent state on send failure so the typing indicator and
      // stop button return to their default states.
      setAgentState('idle');
      setIsAgentThinking(false);
      setIsLoading(false);
    }
  }, [
    inputText,
    isConnected,
    selectedAgent,
    sendMessage,
    sessionId,
    pairingInfo,
    sessionCreationLockRef,
    setMessages,
    setInputText,
    setIsLoading,
    setAgentState,
    setIsAgentThinking,
    setSessionId,
  ]);
}
