/**
 * useRelayMessageHandler
 *
 * React hook that subscribes to incoming relay messages and dispatches
 * them into chat state: agent responses, permission requests/responses,
 * and session-state updates.
 *
 * WHY a dedicated hook: This effect is the single largest piece of logic
 * in the chat screen. Extracting it to a hook drops ~120 LOC from the
 * orchestrator and lets the message-routing semantics be reasoned about
 * in isolation. The hook accepts only setters and primitives so it can
 * be unit-tested with simple jest mocks.
 */

import { useEffect } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { AgentType, RelayMessage } from 'styrby-shared';
import type { PairingInfo } from '../../../hooks/useRelay';
import type { ChatMessageData } from '../../ChatMessage';
import type { PermissionRequest } from '../../PermissionCard';
import type { AgentState } from '../../TypingIndicator';
import { decryptMessage } from '../../../services/encryption';
import { DECRYPTION_FAILED_PLACEHOLDER, chatLogger as logger } from '../agent-config';
import { saveMessageToDb } from '../chat-session';

/**
 * Dependencies passed in by the orchestrator.
 *
 * WHY: Setters and refs are exposed as deps rather than baked in so the
 * hook stays pure and the orchestrator owns React state.
 */
export interface RelayMessageHandlerDeps {
  /** Most recently received relay message (driver of the effect) */
  lastMessage: RelayMessage | null;
  /** Current persisted session ID, or null if none */
  sessionId: string | null;
  /** Pairing info (used for E2E decryption) */
  pairingInfo: PairingInfo | null;
  setMessages: Dispatch<SetStateAction<ChatMessageData[]>>;
  setPendingPermissions: Dispatch<SetStateAction<PermissionRequest[]>>;
  setAgentState: Dispatch<SetStateAction<AgentState>>;
  setIsAgentThinking: Dispatch<SetStateAction<boolean>>;
  setIsLoading: Dispatch<SetStateAction<boolean>>;
}

/**
 * Subscribes to `lastMessage` and routes each relay payload to the right
 * state update.
 *
 * WHY async IIFE inside the effect: React effects can't be async, but we
 * need `await` for decrypting incoming messages. The IIFE pattern is the
 * standard workaround.
 */
export function useRelayMessageHandler(deps: RelayMessageHandlerDeps): void {
  const {
    lastMessage,
    sessionId,
    pairingInfo,
    setMessages,
    setPendingPermissions,
    setAgentState,
    setIsAgentThinking,
    setIsLoading,
  } = deps;

  useEffect(() => {
    if (!lastMessage) return;

    void (async () => {
      switch (lastMessage.type) {
        case 'agent_response': {
          await handleAgentResponse(lastMessage, {
            sessionId,
            pairingInfo,
            setMessages,
            setAgentState,
            setIsAgentThinking,
            setIsLoading,
          });
          break;
        }

        case 'permission_request': {
          // WHY: Relay payload uses snake_case (request_id, session_id, etc.)
          // but PermissionRequest uses camelCase. Map between them.
          const p = lastMessage.payload;
          const permData: PermissionRequest = {
            id: p.request_id,
            sessionId: p.session_id,
            agentType: p.agent,
            type: p.tool_name,
            description: p.description,
            riskLevel: p.risk_level,
            timestamp: p.expires_at,
            filePath: p.affected_files?.[0],
            nonce: p.nonce,
          };
          setPendingPermissions((prev) => [...prev, permData]);

          // WHY: When a permission is requested, the agent is waiting —
          // update state to reflect this in the typing indicator.
          setAgentState('waiting_permission');
          break;
        }

        case 'permission_response': {
          const requestId = lastMessage.payload.request_id;
          // WHY: Keep the card in the list briefly so the user sees the
          // approved/denied feedback animation (handled by PermissionCard).
          setTimeout(() => {
            setPendingPermissions((prev) => prev.filter((perm) => perm.id !== requestId));
          }, 1500);
          break;
        }

        case 'session_state': {
          const stateData = lastMessage.payload as {
            state: 'idle' | 'thinking' | 'executing' | 'waiting_permission' | 'error';
          };

          setAgentState(stateData.state as AgentState);
          setIsAgentThinking(stateData.state === 'thinking' || stateData.state === 'executing');

          // WHY: Clear loading state when the agent returns to idle.
          if (stateData.state === 'idle') {
            setIsLoading(false);
          }
          break;
        }
      }
    })();
  }, [
    lastMessage,
    sessionId,
    pairingInfo,
    setMessages,
    setPendingPermissions,
    setAgentState,
    setIsAgentThinking,
    setIsLoading,
  ]);
}

/**
 * Internal helper: handles the `agent_response` relay variant. Decrypts the
 * payload if needed, appends a new ChatMessageData to the list, resets agent
 * state on completion, and persists the message to Supabase.
 */
async function handleAgentResponse(
  lastMessage: RelayMessage,
  ctx: {
    sessionId: string | null;
    pairingInfo: PairingInfo | null;
    setMessages: Dispatch<SetStateAction<ChatMessageData[]>>;
    setAgentState: Dispatch<SetStateAction<AgentState>>;
    setIsAgentThinking: Dispatch<SetStateAction<boolean>>;
    setIsLoading: Dispatch<SetStateAction<boolean>>;
  },
): Promise<void> {
  const responseData = lastMessage.payload as {
    content: string;
    agent_type?: AgentType;
    agent?: AgentType;
    cost_usd?: number;
    duration_ms?: number;
    is_complete?: boolean;
    tokens?: { input: number; output: number };
    /** Base64-encoded encrypted content (set by CLI when E2E is active) */
    encrypted_content?: string;
    /** Base64-encoded nonce for decryption */
    nonce?: string;
  };

  const agentType = responseData.agent_type ?? responseData.agent;

  // WHY: The CLI may send relay messages with E2E encrypted content. If
  // encrypted_content + nonce are present, decrypt the payload. Otherwise
  // use the plaintext content field (backward compatibility).
  let displayContent: string;
  if (responseData.encrypted_content && responseData.nonce && ctx.pairingInfo?.machineId) {
    try {
      displayContent = await decryptMessage(
        responseData.encrypted_content,
        responseData.nonce,
        ctx.pairingInfo.machineId,
      );
    } catch (decryptError) {
      logger.error('Failed to decrypt relay message:', decryptError);
      displayContent = DECRYPTION_FAILED_PLACEHOLDER;
    }
  } else {
    displayContent = responseData.content;
  }

  const responseMessage: ChatMessageData = {
    id: lastMessage.id,
    role: 'assistant',
    agentType,
    content: [{ type: 'text', content: displayContent }],
    timestamp: lastMessage.timestamp,
    costUsd: responseData.cost_usd,
    durationMs: responseData.duration_ms,
  };

  ctx.setMessages((prev) => [...prev, responseMessage]);

  // WHY: Reset agent state when the response is complete so the typing
  // indicator hides and the stop button disappears.
  if (responseData.is_complete !== false) {
    ctx.setAgentState('idle');
    ctx.setIsAgentThinking(false);
    ctx.setIsLoading(false);
  }

  // Persist the assistant message (re-encrypted by saveMessageToDb)
  if (ctx.sessionId) {
    void saveMessageToDb(
      ctx.sessionId,
      lastMessage.id,
      'assistant',
      displayContent,
      ctx.pairingInfo?.machineId ?? null,
      {
        inputTokens: responseData.tokens?.input,
        outputTokens: responseData.tokens?.output,
        costUsd: responseData.cost_usd,
      },
    );
  }
}
