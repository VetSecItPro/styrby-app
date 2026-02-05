/**
 * Chat Screen
 *
 * Main chat interface for communicating with AI agents.
 * Provides session persistence (Supabase), typing indicators,
 * stop/cancel controls, and permission approval feedback.
 *
 * Session lifecycle:
 * 1. On mount, checks for an existing sessionId in route params or resumes the most recent active session
 * 2. On first user message (if no active session), creates a new session in Supabase
 * 3. Every sent/received message is persisted to session_messages
 * 4. When the user navigates away, the session stays active for later resumption
 */

import { View, Text, FlatList, TextInput, Pressable, KeyboardAvoidingView, Platform } from 'react-native';
import { useState, useRef, useEffect, useCallback } from 'react';
import { useLocalSearchParams, router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useRelay } from '../../src/hooks/useRelay';
import { ChatMessage, type ChatMessageData } from '../../src/components/ChatMessage';
import { PermissionCard, type PermissionRequest } from '../../src/components/PermissionCard';
import { TypingIndicatorInline, type AgentState } from '../../src/components/TypingIndicator';
import { StopButtonIcon } from '../../src/components/StopButton';
import { supabase } from '../../src/lib/supabase';
import type { AgentType } from 'styrby-shared';

// ============================================================================
// Types
// ============================================================================

/**
 * Supabase session_messages row shape matching the `session_messages` table.
 * Used for persisting and loading chat messages.
 */
interface SessionMessageRow {
  /** UUID primary key */
  id: string;
  /** Foreign key to sessions.id */
  session_id: string;
  /** Message role: user, assistant, system, or tool */
  role: 'user' | 'assistant' | 'system' | 'tool';
  /** Plaintext message content (E2E encryption comes later) */
  content: string | null;
  /** Encrypted content blob (not used yet) */
  encrypted_content: string | null;
  /** Encryption nonce (not used yet) */
  nonce: string | null;
  /** Input tokens consumed by this message */
  input_tokens: number | null;
  /** Output tokens produced by this message */
  output_tokens: number | null;
  /** Cost in USD for this message */
  cost_usd: number | null;
  /** Model used for this message */
  model: string | null;
  /** When the message was created */
  created_at: string;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Visual configuration for each supported agent type.
 */
const AGENT_CONFIG: Record<AgentType, { name: string; color: string; bgColor: string }> = {
  claude: { name: 'Claude', color: '#f97316', bgColor: 'rgba(249, 115, 22, 0.1)' },
  codex: { name: 'Codex', color: '#22c55e', bgColor: 'rgba(34, 197, 94, 0.1)' },
  gemini: { name: 'Gemini', color: '#3b82f6', bgColor: 'rgba(59, 130, 246, 0.1)' },
  opencode: { name: 'OpenCode', color: '#8b5cf6', bgColor: 'rgba(139, 92, 246, 0.1)' },
  aider: { name: 'Aider', color: '#ec4899', bgColor: 'rgba(236, 72, 153, 0.1)' },
};

/**
 * Only these agents are shown in the selector bar for now.
 * WHY: opencode and aider are not yet integrated into the CLI relay.
 */
const SELECTABLE_AGENTS: AgentType[] = ['claude', 'codex', 'gemini'];

// ============================================================================
// Dev Logger
// ============================================================================

/**
 * Development-only logger that suppresses output in production.
 * WHY: Prevents session and message data from appearing in production logs.
 */
const logger = {
  log: (...args: unknown[]) => { if (__DEV__) console.log('[Chat]', ...args); },
  error: (...args: unknown[]) => { if (__DEV__) console.error('[Chat]', ...args); },
};

// ============================================================================
// Component
// ============================================================================

/**
 * Main chat screen component.
 *
 * Manages the full lifecycle of a chat session:
 * - Loads existing messages from Supabase on mount
 * - Creates a new session on first message if none exists
 * - Persists every message to session_messages
 * - Integrates the typing indicator and stop button
 * - Handles permission request approve/deny with visual feedback
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
    (params.agent as AgentType) || null
  );

  /**
   * WHY: Track the current session ID so we can persist messages to the
   * correct session. Null means no session has been created yet -- the first
   * message will trigger session creation.
   */
  const [sessionId, setSessionId] = useState<string | null>(params.sessionId ?? null);

  /**
   * WHY: Track the agent state so we can show the correct typing indicator
   * variant and control the stop button visibility.
   */
  const [agentState, setAgentState] = useState<AgentState>('idle');

  /**
   * WHY: Track whether the agent is actively generating a response.
   * This drives the stop button visibility in the input area.
   */
  const [isAgentThinking, setIsAgentThinking] = useState<boolean>(false);

  /**
   * WHY: Track whether we are currently loading messages from Supabase
   * to show a loading state and prevent duplicate loads.
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

  /**
   * On mount, loads the session and its messages from Supabase.
   * If a sessionId is provided via route params, loads that specific session.
   * Otherwise, attempts to resume the most recent active session.
   */
  useEffect(() => {
    loadSessionHistory();
  }, []);

  /**
   * Loads the session history from Supabase.
   * If sessionId is set (from params), loads messages for that session.
   * If no sessionId, tries to find and resume the most recent active session.
   *
   * @returns void
   */
  async function loadSessionHistory(): Promise<void> {
    try {
      setIsLoadingHistory(true);

      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        logger.log('No authenticated user, skipping session load');
        return;
      }

      let targetSessionId = sessionId;

      // If no session ID from route params, find the most recent active session
      if (!targetSessionId) {
        const { data: recentSession, error: sessionError } = await supabase
          .from('sessions')
          .select('id, agent, status')
          .eq('user_id', user.id)
          .eq('status', 'active')
          .order('updated_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (sessionError) {
          logger.error('Failed to find recent session:', sessionError.message);
          return;
        }

        if (recentSession) {
          targetSessionId = recentSession.id;
          setSessionId(recentSession.id);

          // WHY: Restore the agent selection to match the resumed session
          // so the UI is consistent with what the user last used.
          if (recentSession.agent && recentSession.agent in AGENT_CONFIG) {
            setSelectedAgent(recentSession.agent as AgentType);
          }

          logger.log('Resuming active session:', recentSession.id);
        }
      }

      // Load messages for the session
      if (targetSessionId) {
        await loadMessagesForSession(targetSessionId);
      }
    } catch (error) {
      logger.error('Failed to load session history:', error);
    } finally {
      setIsLoadingHistory(false);
    }
  }

  /**
   * Fetches all messages for a given session from the session_messages table
   * and populates the local messages state.
   *
   * @param targetSessionId - The session ID to load messages for
   * @returns void
   */
  async function loadMessagesForSession(targetSessionId: string): Promise<void> {
    const { data: messageRows, error } = await supabase
      .from('session_messages')
      .select('*')
      .eq('session_id', targetSessionId)
      .order('created_at', { ascending: true });

    if (error) {
      logger.error('Failed to load messages:', error.message);
      return;
    }

    if (messageRows && messageRows.length > 0) {
      const loadedMessages: ChatMessageData[] = (messageRows as SessionMessageRow[]).map((row) => ({
        id: row.id,
        role: row.role === 'tool' ? 'system' : row.role as ChatMessageData['role'],
        content: [{ type: 'text' as const, content: row.content ?? '' }],
        timestamp: row.created_at,
        costUsd: row.cost_usd ?? undefined,
      }));

      setMessages(loadedMessages);
      logger.log(`Loaded ${loadedMessages.length} messages for session ${targetSessionId}`);
    }
  }

  // --------------------------------------------------------------------------
  // Session Persistence: Create Session
  // --------------------------------------------------------------------------

  /**
   * Creates a new session row in the Supabase `sessions` table.
   * Called lazily on the first message if no session exists yet.
   *
   * WHY: We create sessions lazily (not on screen mount) because opening
   * the chat screen without sending a message should not litter the database
   * with empty sessions.
   *
   * @param agent - The agent type for this session
   * @param firstMessageContent - The content of the first message (used for session title)
   * @returns The new session ID, or null if creation failed
   */
  async function createSession(agent: AgentType | null, firstMessageContent: string): Promise<string | null> {
    // WHY: Prevent race condition if user taps send rapidly
    if (sessionCreationLockRef.current) {
      logger.log('Session creation already in progress, waiting...');
      // Wait for existing creation to complete
      await new Promise<void>((resolve) => {
        const interval = setInterval(() => {
          if (!sessionCreationLockRef.current) {
            clearInterval(interval);
            resolve();
          }
        }, 50);
      });
      return sessionId;
    }

    // Double-check: session may have been created while we waited
    if (sessionId) return sessionId;

    sessionCreationLockRef.current = true;

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        logger.error('Cannot create session: no authenticated user');
        return null;
      }

      // WHY: Generate a short title from the first message so the session
      // is identifiable in the session list/history screen.
      const title = firstMessageContent.length > 80
        ? firstMessageContent.substring(0, 77) + '...'
        : firstMessageContent;

      const { data: newSession, error } = await supabase
        .from('sessions')
        .insert({
          user_id: user.id,
          machine_id: pairingInfo?.machineId ?? null,
          agent: agent ?? 'claude',
          status: 'active',
          title,
          total_input_tokens: 0,
          total_output_tokens: 0,
          total_cost_usd: 0,
          started_at: new Date().toISOString(),
        })
        .select('id')
        .single();

      if (error) {
        logger.error('Failed to create session:', error.message);
        return null;
      }

      const newId = newSession.id;
      setSessionId(newId);
      logger.log('Created new session:', newId);
      return newId;
    } finally {
      sessionCreationLockRef.current = false;
    }
  }

  // --------------------------------------------------------------------------
  // Session Persistence: Save Message
  // --------------------------------------------------------------------------

  /**
   * Persists a message to the Supabase `session_messages` table.
   *
   * @param targetSessionId - The session this message belongs to
   * @param messageId - Unique message ID (used as the PK)
   * @param role - The message role (user, assistant, system, tool)
   * @param content - Plaintext message content
   * @param tokenData - Optional token usage and cost data
   * @returns void
   */
  async function saveMessageToDb(
    targetSessionId: string,
    messageId: string,
    role: 'user' | 'assistant' | 'system' | 'tool',
    content: string,
    tokenData?: {
      inputTokens?: number;
      outputTokens?: number;
      costUsd?: number;
      model?: string;
    }
  ): Promise<void> {
    const { error } = await supabase
      .from('session_messages')
      .insert({
        id: messageId,
        session_id: targetSessionId,
        role,
        content,
        encrypted_content: null,
        nonce: null,
        input_tokens: tokenData?.inputTokens ?? null,
        output_tokens: tokenData?.outputTokens ?? null,
        cost_usd: tokenData?.costUsd ?? null,
        model: tokenData?.model ?? null,
      });

    if (error) {
      logger.error('Failed to save message:', error.message);
    }
  }

  // --------------------------------------------------------------------------
  // Incoming Message Handling
  // --------------------------------------------------------------------------

  /**
   * Processes incoming relay messages and updates local state.
   * Handles agent responses, permission requests, permission responses,
   * and session state updates.
   */
  useEffect(() => {
    if (!lastMessage) return;

    switch (lastMessage.type) {
      case 'agent_response': {
        const responseData = lastMessage.payload as {
          content: string;
          agent_type?: AgentType;
          agent?: AgentType;
          cost_usd?: number;
          duration_ms?: number;
          is_complete?: boolean;
          tokens?: {
            input: number;
            output: number;
          };
        };

        const agentType = responseData.agent_type ?? responseData.agent;

        const responseMessage: ChatMessageData = {
          id: lastMessage.id,
          role: 'assistant',
          agentType,
          content: [{ type: 'text', content: responseData.content }],
          timestamp: lastMessage.timestamp,
          costUsd: responseData.cost_usd,
          durationMs: responseData.duration_ms,
        };

        setMessages((prev) => [...prev, responseMessage]);

        // WHY: Reset the agent state when the response is complete so the
        // typing indicator hides and the stop button disappears.
        if (responseData.is_complete !== false) {
          setAgentState('idle');
          setIsAgentThinking(false);
          setIsLoading(false);
        }

        // Persist the assistant message to Supabase
        if (sessionId) {
          saveMessageToDb(
            sessionId,
            lastMessage.id,
            'assistant',
            responseData.content,
            {
              inputTokens: responseData.tokens?.input,
              outputTokens: responseData.tokens?.output,
              costUsd: responseData.cost_usd,
            }
          );
        }
        break;
      }

      case 'permission_request': {
        const permData = lastMessage.payload as PermissionRequest;
        setPendingPermissions((prev) => [...prev, permData]);

        // WHY: When a permission is requested, the agent is waiting --
        // update the state to reflect this in the typing indicator.
        setAgentState('waiting_permission');
        break;
      }

      case 'permission_response': {
        const { id } = lastMessage.payload as { id: string };
        // WHY: Keep the card in the list briefly so the user sees the
        // approved/denied feedback animation (handled by PermissionCard internally).
        // The card is removed after a short delay.
        setTimeout(() => {
          setPendingPermissions((prev) => prev.filter((p) => p.id !== id));
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
  }, [lastMessage, sessionId]);

  // --------------------------------------------------------------------------
  // Scroll to Bottom
  // --------------------------------------------------------------------------

  /**
   * Scrolls to the bottom of the message list when new messages arrive
   * or when the typing indicator appears.
   */
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

  /**
   * Handles sending a user message through the relay.
   * Creates a session on first message, persists the message to Supabase,
   * and sends it through the relay channel.
   *
   * @returns void
   */
  const handleSend = useCallback(async () => {
    if (!inputText.trim() || !isConnected) return;

    const content = inputText.trim();
    const messageId = `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

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

    // Ensure we have a session
    let currentSessionId = sessionId;
    if (!currentSessionId) {
      currentSessionId = await createSession(selectedAgent, content);
    }

    // Persist the user message
    if (currentSessionId) {
      saveMessageToDb(currentSessionId, messageId, 'user', content);
    }

    try {
      await sendMessage({
        type: 'chat',
        payload: {
          content,
          agent_type: selectedAgent,
        },
      });
    } catch (error) {
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

      // WHY: Reset agent state on send failure so the typing indicator
      // and stop button return to their default states.
      setAgentState('idle');
      setIsAgentThinking(false);
      setIsLoading(false);
    }
  }, [inputText, isConnected, selectedAgent, sendMessage, sessionId, pairingInfo]);

  // --------------------------------------------------------------------------
  // Permission Handling
  // --------------------------------------------------------------------------

  /**
   * Approves a pending permission request by sending the approval through the relay.
   *
   * @param id - The permission request ID to approve
   * @returns void
   */
  const handleApprovePermission = useCallback(
    async (id: string) => {
      const permission = pendingPermissions.find((p) => p.id === id);
      if (!permission) return;

      try {
        await sendMessage({
          type: 'permission_response',
          payload: {
            id,
            session_id: permission.sessionId,
            approved: true,
          },
        });

        // WHY: After approving, the agent will likely start executing.
        // Update state preemptively so the UI feels responsive.
        setAgentState('executing');
        setIsAgentThinking(true);

        // WHY: Delay removal so the PermissionCard can show the "Approved" feedback.
        setTimeout(() => {
          setPendingPermissions((prev) => prev.filter((p) => p.id !== id));
        }, 1500);
      } catch (error) {
        logger.error('Failed to approve permission:', error);
      }
    },
    [pendingPermissions, sendMessage]
  );

  /**
   * Denies a pending permission request by sending the denial through the relay.
   *
   * @param id - The permission request ID to deny
   * @returns void
   */
  const handleDenyPermission = useCallback(
    async (id: string) => {
      const permission = pendingPermissions.find((p) => p.id === id);
      if (!permission) return;

      try {
        await sendMessage({
          type: 'permission_response',
          payload: {
            id,
            session_id: permission.sessionId,
            approved: false,
          },
        });

        // WHY: After denying, the agent returns to idle (it can't proceed).
        setAgentState('idle');
        setIsAgentThinking(false);

        // WHY: Delay removal so the PermissionCard can show the "Denied" feedback.
        setTimeout(() => {
          setPendingPermissions((prev) => prev.filter((p) => p.id !== id));
        }, 1500);
      } catch (error) {
        logger.error('Failed to deny permission:', error);
      }
    },
    [pendingPermissions, sendMessage]
  );

  // --------------------------------------------------------------------------
  // Stop / Cancel
  // --------------------------------------------------------------------------

  /**
   * Sends an interrupt command to the CLI agent to cancel the current operation.
   * Called by the StopButton when the user wants to stop generation.
   *
   * @returns void
   */
  const handleStop = useCallback(async () => {
    try {
      await sendMessage({
        type: 'command',
        payload: {
          action: 'interrupt',
        },
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

  /**
   * Navigates to the QR code scanning screen for pairing.
   */
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

  // --------------------------------------------------------------------------
  // Empty State
  // --------------------------------------------------------------------------

  /**
   * Renders the appropriate empty state based on connection status.
   * Shows different UI for: not paired, not connected, and ready to chat.
   *
   * @returns React element for the empty state
   */
  const renderEmptyState = () => {
    if (!pairingInfo) {
      return (
        <View className="flex-1 items-center justify-center px-8">
          <View className="w-16 h-16 rounded-2xl bg-brand/20 items-center justify-center mb-4">
            <Ionicons name="link" size={32} color="#f97316" />
          </View>
          <Text className="text-white text-xl font-semibold text-center mb-2">
            Connect Your CLI
          </Text>
          <Text className="text-zinc-500 text-center mb-6">
            Pair your CLI to start chatting with your AI coding agents
          </Text>
          <Pressable
            onPress={handlePairPress}
            className="bg-brand px-6 py-3 rounded-xl flex-row items-center"
            accessibilityRole="button"
            accessibilityLabel="Scan QR code to pair CLI"
          >
            <Ionicons name="qr-code" size={20} color="white" />
            <Text className="text-white font-semibold ml-2">Scan QR Code</Text>
          </Pressable>
        </View>
      );
    }

    if (!isConnected) {
      return (
        <View className="flex-1 items-center justify-center px-8">
          <View className="w-16 h-16 rounded-2xl bg-yellow-500/20 items-center justify-center mb-4">
            <Ionicons name="cloud-offline" size={32} color="#eab308" />
          </View>
          <Text className="text-white text-xl font-semibold text-center mb-2">
            {isOnline ? 'Connecting...' : 'Offline'}
          </Text>
          <Text className="text-zinc-500 text-center">
            {isOnline
              ? 'Establishing connection to your CLI'
              : 'Check your internet connection'}
          </Text>
        </View>
      );
    }

    if (isLoadingHistory) {
      return (
        <View className="flex-1 items-center justify-center px-8">
          <View className="w-16 h-16 rounded-2xl bg-brand/20 items-center justify-center mb-4">
            <Ionicons name="chatbubbles" size={32} color="#f97316" />
          </View>
          <Text className="text-white text-xl font-semibold text-center mb-2">
            Loading Messages...
          </Text>
          <Text className="text-zinc-500 text-center">
            Restoring your conversation
          </Text>
        </View>
      );
    }

    return (
      <View className="flex-1 items-center justify-center px-8">
        <View className="w-16 h-16 rounded-2xl bg-brand/20 items-center justify-center mb-4">
          <Ionicons name="chatbubbles" size={32} color="#f97316" />
        </View>
        <Text className="text-white text-xl font-semibold text-center mb-2">
          Start a Conversation
        </Text>
        <Text className="text-zinc-500 text-center">
          Send a message to begin chatting with your AI agent
        </Text>
      </View>
    );
  };

  // --------------------------------------------------------------------------
  // Chat Items (messages + permissions merged and sorted)
  // --------------------------------------------------------------------------

  /**
   * WHY: Combine messages and permissions into a single sorted list so they
   * appear in chronological order in the FlatList. The type discriminator
   * is used in renderItem to render the correct component.
   */
  const chatItems = [
    ...messages.map((m) => ({ type: 'message' as const, data: m })),
    ...pendingPermissions.map((p) => ({ type: 'permission' as const, data: p })),
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
        <View className="flex-row px-4 py-2 border-b border-zinc-800">
          {SELECTABLE_AGENTS.map((agent) => {
            const config = AGENT_CONFIG[agent];
            const isSelected = selectedAgent === agent;
            return (
              <Pressable
                key={agent}
                onPress={() => setSelectedAgent(agent)}
                className={`flex-row items-center px-3 py-1.5 rounded-full mr-2 ${
                  isSelected ? '' : 'opacity-50'
                }`}
                style={{ backgroundColor: isSelected ? config.bgColor : 'transparent' }}
                accessibilityRole="button"
                accessibilityLabel={`Select ${config.name} agent`}
                accessibilityState={{ selected: isSelected }}
              >
                <View
                  style={{ backgroundColor: config.color }}
                  className="w-4 h-4 rounded-md items-center justify-center"
                >
                  <Text className="text-white text-xs font-bold">{config.name[0]}</Text>
                </View>
                <Text
                  style={{ color: isSelected ? config.color : '#71717a' }}
                  className="text-sm font-medium ml-2"
                >
                  {config.name}
                </Text>
              </Pressable>
            );
          })}
        </View>
      )}

      {/* Chat Messages */}
      {chatItems.length === 0 && !isAgentThinking ? (
        renderEmptyState()
      ) : (
        <FlatList
          ref={flatListRef}
          data={chatItems}
          keyExtractor={(item) => item.data.id}
          renderItem={({ item }) => {
            if (item.type === 'message') {
              return <ChatMessage message={item.data} />;
            }
            return (
              <PermissionCard
                permission={item.data}
                onApprove={handleApprovePermission}
                onDeny={handleDenyPermission}
              />
            );
          }}
          contentContainerStyle={{ paddingVertical: 8 }}
          showsVerticalScrollIndicator={false}
          ListFooterComponent={
            /* WHY: The typing indicator is rendered as a FlatList footer so it
             * always appears below all messages and scrolls naturally with the list. */
            isAgentThinking ? (
              <View className="px-4 pb-2">
                <TypingIndicatorInline
                  agentType={activeAgent}
                  state={agentState}
                />
              </View>
            ) : null
          }
        />
      )}

      {/* Input Area */}
      <View className="border-t border-zinc-800 p-4 pb-6">
        <View className="flex-row items-end bg-background-secondary rounded-2xl px-4 py-2">
          <TextInput
            className="flex-1 text-white text-base py-2 max-h-32"
            placeholder={
              isConnected ? 'Message your agent...' : 'Connect to start chatting'
            }
            placeholderTextColor="#71717a"
            value={inputText}
            onChangeText={setInputText}
            multiline
            editable={isConnected}
            accessibilityLabel="Message input"
            accessibilityHint="Type a message to send to your AI agent"
          />
          {/* WHY: Show the stop button instead of the send button when the agent
           * is actively generating, so the user can cancel without needing a
           * separate UI element. The StopButtonIcon variant fits cleanly in the
           * same circular button space as the send button. */}
          {isAgentThinking ? (
            <StopButtonIcon
              isRunning={isAgentThinking}
              onStop={handleStop}
              accessibilityLabel="Stop agent generation"
            />
          ) : (
            <Pressable
              onPress={handleSend}
              disabled={!canSend}
              className={`ml-2 w-10 h-10 rounded-full items-center justify-center ${
                canSend ? 'bg-brand' : 'bg-zinc-800'
              }`}
              accessibilityRole="button"
              accessibilityLabel="Send message"
              accessibilityState={{ disabled: !canSend }}
            >
              <Ionicons
                name="send"
                size={20}
                color={canSend ? 'white' : '#71717a'}
              />
            </Pressable>
          )}
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}
