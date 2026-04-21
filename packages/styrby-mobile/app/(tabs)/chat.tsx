/**
 * Chat Screen (Orchestrator)
 *
 * Main chat interface for communicating with AI agents. Owns state and
 * top-level layout only. Presentation lives in `src/components/chat/*`,
 * data-layer helpers live in `src/components/chat/chat-session.ts`, and
 * the heavier hooks live in `src/components/chat/hooks/*`.
 *
 * Session lifecycle: on mount we check for a sessionId in route params or
 * resume the most recent active session; on the first user message we
 * lazily create a session in Supabase; every sent/received message is E2E
 * encrypted and persisted to `session_messages`. The session stays active
 * for resumption when the user navigates away.
 *
 * E2E Encryption: messages are NaCl-box encrypted before being stored in
 * Supabase and re-encrypted in transit via Supabase Realtime. Falls back
 * to plaintext if keys are unavailable; decryption failures show
 * "[Unable to decrypt]".
 */

import { FlatList, KeyboardAvoidingView, Platform, View, Text } from 'react-native';
import { useState, useRef, useEffect, useCallback } from 'react';
import { useLocalSearchParams, router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as SecureStore from 'expo-secure-store';
import { useRelay } from '../../src/hooks/useRelay';
import type { ChatMessageData } from '../../src/components/ChatMessage';
import type { PermissionRequest } from '../../src/components/PermissionCard';
import type { AgentState } from '../../src/components/TypingIndicator';
import type { AgentType, VoiceInputConfig } from 'styrby-shared';
import type { ChatItem } from '../../src/types/chat';
import {
  ChatAgentPicker,
  ChatEmptyState,
  ChatInputBar,
  ChatMessageList,
  chatLogger as logger,
  loadActiveSession,
  useChatSend,
  useRelayMessageHandler,
} from '../../src/components/chat';

/**
 * Main chat screen component.
 *
 * Manages the full lifecycle of a chat session: history loading, session
 * creation, message persistence, typing indicators, stop/cancel control,
 * and permission approve/deny.
 *
 * @returns React element for the chat screen
 */
export default function ChatScreen() {
  const params = useLocalSearchParams<{ agent?: string; sessionId?: string }>();
  const { isConnected, isOnline, isCliOnline, pairingInfo, sendMessage, lastMessage } = useRelay();

  // --------------------------------------------------------------------------
  // State
  // --------------------------------------------------------------------------

  const [inputText, setInputText] = useState<string>('');
  const [messages, setMessages] = useState<ChatMessageData[]>([]);
  const [pendingPermissions, setPendingPermissions] = useState<PermissionRequest[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [selectedAgent, setSelectedAgent] = useState<AgentType | null>(
    (params.agent as AgentType) || null,
  );

  /**
   * Voice input configuration loaded from SecureStore.
   * WHY: Chat screen needs the config to show/hide the mic button and pass
   * it to VoiceInput. Config is device-local (SecureStore), not DB.
   */
  const [voiceConfig, setVoiceConfig] = useState<VoiceInputConfig | null>(null);

  /**
   * WHY: Track current session ID to persist messages to the right session.
   * Null means no session has been created yet — the first message triggers
   * lazy session creation.
   */
  const [sessionId, setSessionId] = useState<string | null>(params.sessionId ?? null);

  /**
   * WHY: Track agent state to show the correct typing-indicator variant
   * and control the stop-button visibility.
   */
  const [agentState, setAgentState] = useState<AgentState>('idle');

  /**
   * WHY: Track whether the agent is actively generating. Drives the
   * stop-button visibility in the input area.
   */
  const [isAgentThinking, setIsAgentThinking] = useState<boolean>(false);

  /**
   * WHY: Track whether we're loading messages from Supabase to show a
   * loading state and prevent duplicate loads.
   */
  const [isLoadingHistory, setIsLoadingHistory] = useState<boolean>(false);

  const flatListRef = useRef<FlatList>(null);

  /**
   * WHY: Prevent creating multiple sessions if the user sends messages
   * rapidly before the first session creation completes.
   */
  const sessionCreationLockRef = useRef<boolean>(false);

  // --------------------------------------------------------------------------
  // Session Persistence: Load on Mount
  // --------------------------------------------------------------------------

  useEffect(() => {
    /**
     * Loads the session and its messages from Supabase. If a sessionId is
     * provided via route params, loads that session; otherwise resumes the
     * most recent active session.
     */
    async function bootstrap(): Promise<void> {
      try {
        setIsLoadingHistory(true);
        const machineId = pairingInfo?.machineId ?? null;
        const result = await loadActiveSession(sessionId, machineId);

        if (result.sessionId && result.sessionId !== sessionId) {
          setSessionId(result.sessionId);
        }
        if (result.agentType) {
          setSelectedAgent(result.agentType);
        }
        if (result.messages.length > 0) {
          setMessages(result.messages);
        }
      } catch (error) {
        logger.error('Failed to load session history:', error);
      } finally {
        setIsLoadingHistory(false);
      }
    }

    void bootstrap();

    // Load voice input config from SecureStore alongside session history.
    // WHY: Config is device-local — loading here avoids a separate hook and
    // keeps the chat screen self-contained for voice support.
    SecureStore.getItemAsync('styrby_voice_input_config')
      .then((stored) => {
        if (stored) {
          try {
            setVoiceConfig(JSON.parse(stored) as VoiceInputConfig);
          } catch {
            // Malformed — keep null (mic button hidden)
          }
        }
      })
      .catch(() => {
        // SecureStore unavailable — silently disable voice
      });
    // WHY mount-only: We load history once when the screen opens, not on
    // every re-render. Adding `bootstrap` deps would cause redundant reloads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --------------------------------------------------------------------------
  // Incoming Relay Messages
  // --------------------------------------------------------------------------

  useRelayMessageHandler({
    lastMessage,
    sessionId,
    pairingInfo,
    setMessages,
    setPendingPermissions,
    setAgentState,
    setIsAgentThinking,
    setIsLoading,
  });

  // --------------------------------------------------------------------------
  // Scroll to Bottom
  // --------------------------------------------------------------------------

  useEffect(() => {
    if (messages.length > 0 || isAgentThinking) {
      setTimeout(() => {
        flatListRef.current?.scrollToEnd({ animated: true });
      }, 100);
    }
  }, [messages.length, pendingPermissions.length, isAgentThinking]);

  // --------------------------------------------------------------------------
  // Send Message
  // --------------------------------------------------------------------------

  const handleSend = useChatSend({
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
  });

  // --------------------------------------------------------------------------
  // Permission Handling
  // --------------------------------------------------------------------------

  /**
   * Approves a pending permission request through the relay.
   *
   * @param id - The permission request ID to approve
   */
  const handleApprovePermission = useCallback(
    async (id: string) => {
      const permission = pendingPermissions.find((p) => p.id === id);
      if (!permission) return;

      try {
        await sendMessage({
          type: 'permission_response',
          payload: {
            request_id: id,
            approved: true,
            request_nonce: permission.nonce,
          },
        });

        // WHY: After approving, the agent will likely start executing.
        // Update state preemptively so the UI feels responsive.
        setAgentState('executing');
        setIsAgentThinking(true);

        // WHY: Delay removal so the PermissionCard can show "Approved" feedback.
        setTimeout(() => {
          setPendingPermissions((prev) => prev.filter((p) => p.id !== id));
        }, 1500);
      } catch (error) {
        logger.error('Failed to approve permission:', error);
      }
    },
    [pendingPermissions, sendMessage],
  );

  /**
   * Denies a pending permission request through the relay.
   *
   * @param id - The permission request ID to deny
   */
  const handleDenyPermission = useCallback(
    async (id: string) => {
      const permission = pendingPermissions.find((p) => p.id === id);
      if (!permission) return;

      try {
        await sendMessage({
          type: 'permission_response',
          payload: {
            request_id: id,
            approved: false,
            request_nonce: permission.nonce,
          },
        });

        // WHY: After denying, the agent returns to idle (it can't proceed).
        setAgentState('idle');
        setIsAgentThinking(false);

        // WHY: Delay removal so the PermissionCard can show "Denied" feedback.
        setTimeout(() => {
          setPendingPermissions((prev) => prev.filter((p) => p.id !== id));
        }, 1500);
      } catch (error) {
        logger.error('Failed to deny permission:', error);
      }
    },
    [pendingPermissions, sendMessage],
  );

  // --------------------------------------------------------------------------
  // Stop / Cancel
  // --------------------------------------------------------------------------

  /**
   * Sends an interrupt command to the CLI agent to cancel the current operation.
   */
  const handleStop = useCallback(async () => {
    try {
      await sendMessage({
        type: 'command',
        payload: { action: 'interrupt' },
      });

      setAgentState('idle');
      setIsAgentThinking(false);
      setIsLoading(false);
    } catch (error) {
      logger.error('Failed to send interrupt:', error);
    }
  }, [sendMessage]);

  // --------------------------------------------------------------------------
  // Navigation
  // --------------------------------------------------------------------------

  /** Navigates to the QR code scanning screen for pairing. */
  const handlePairPress = () => {
    router.push('/(auth)/scan');
  };

  // --------------------------------------------------------------------------
  // Derived State
  // --------------------------------------------------------------------------

  /** Whether the send button should be enabled */
  const canSend = isConnected && inputText.trim().length > 0 && !isLoading;

  /** The currently resolved agent (for typing indicator) */
  const activeAgent: AgentType = selectedAgent ?? 'claude';

  /**
   * WHY: Combine messages and permissions into a single sorted list so they
   * appear in chronological order in the FlatList. The discriminated union
   * is used in renderItem to render the correct component.
   */
  const chatItems: ChatItem[] = [
    ...messages.map((m): ChatItem => ({ type: 'message', data: m })),
    ...pendingPermissions.map((p): ChatItem => ({ type: 'permission', data: p })),
  ].sort((a, b) => {
    const aTime = a.data.timestamp;
    const bTime = b.data.timestamp;
    return new Date(aTime).getTime() - new Date(bTime).getTime();
  });

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------

  return (
    <KeyboardAvoidingView
      className="flex-1 bg-background"
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={88}
    >
      {/* Connection Status Banner */}
      {isConnected && !isCliOnline && (
        <View className="bg-yellow-500/10 px-4 py-2 flex-row items-center justify-center">
          <Ionicons name="hourglass" size={16} color="#eab308" />
          <Text className="text-yellow-500 text-sm ml-2">Waiting for CLI to come online</Text>
        </View>
      )}

      {/* Agent Selector */}
      {isConnected && (
        <ChatAgentPicker selectedAgent={selectedAgent} onSelect={setSelectedAgent} />
      )}

      {/* Chat Messages */}
      {chatItems.length === 0 && !isAgentThinking ? (
        <ChatEmptyState
          isPaired={!!pairingInfo}
          isConnected={isConnected}
          isOnline={isOnline}
          isLoadingHistory={isLoadingHistory}
          onPairPress={handlePairPress}
        />
      ) : (
        <ChatMessageList
          ref={flatListRef}
          items={chatItems}
          isAgentThinking={isAgentThinking}
          activeAgent={activeAgent}
          agentState={agentState}
          onApprovePermission={handleApprovePermission}
          onDenyPermission={handleDenyPermission}
        />
      )}

      {/* Input Area */}
      <ChatInputBar
        inputText={inputText}
        onChangeText={setInputText}
        onSend={handleSend}
        onStop={handleStop}
        onVoiceTranscript={(text) => setInputText(text)}
        isConnected={isConnected}
        isAgentThinking={isAgentThinking}
        canSend={canSend}
        voiceConfig={voiceConfig}
      />
    </KeyboardAvoidingView>
  );
}
