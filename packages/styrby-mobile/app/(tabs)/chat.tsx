/**
 * Chat Screen
 *
 * Main chat interface for communicating with AI agents.
 * Shows messages, permission requests, and input for new messages.
 */

import { View, Text, FlatList, TextInput, Pressable, KeyboardAvoidingView, Platform } from 'react-native';
import { useState, useRef, useEffect, useCallback } from 'react';
import { useLocalSearchParams, router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useRelay } from '../../src/hooks/useRelay';
import { ChatMessage, type ChatMessageData } from '../../src/components/ChatMessage';
import { PermissionCard, type PermissionRequest } from '../../src/components/PermissionCard';
import type { AgentType } from 'styrby-shared';

const AGENT_CONFIG: Record<AgentType, { name: string; color: string; bgColor: string }> = {
  claude: { name: 'Claude', color: '#f97316', bgColor: 'rgba(249, 115, 22, 0.1)' },
  codex: { name: 'Codex', color: '#22c55e', bgColor: 'rgba(34, 197, 94, 0.1)' },
  gemini: { name: 'Gemini', color: '#3b82f6', bgColor: 'rgba(59, 130, 246, 0.1)' },
};

export default function ChatScreen() {
  const params = useLocalSearchParams<{ agent?: string; sessionId?: string }>();
  const { isConnected, isOnline, isCliOnline, pairingInfo, sendMessage, lastMessage } = useRelay();

  const [inputText, setInputText] = useState('');
  const [messages, setMessages] = useState<ChatMessageData[]>([]);
  const [pendingPermissions, setPendingPermissions] = useState<PermissionRequest[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState<AgentType | null>(
    (params.agent as AgentType) || null
  );

  const flatListRef = useRef<FlatList>(null);

  // Handle incoming messages from relay
  useEffect(() => {
    if (!lastMessage) return;

    switch (lastMessage.type) {
      case 'agent_response':
        // Add agent response to messages
        const responseData = lastMessage.payload as {
          content: string;
          agent_type: AgentType;
          cost_usd?: number;
          duration_ms?: number;
        };
        setMessages((prev) => [
          ...prev,
          {
            id: lastMessage.id,
            role: 'assistant',
            agentType: responseData.agent_type,
            content: [{ type: 'text', content: responseData.content }],
            timestamp: lastMessage.timestamp,
            costUsd: responseData.cost_usd,
            durationMs: responseData.duration_ms,
          },
        ]);
        break;

      case 'permission_request':
        // Add permission request
        const permData = lastMessage.payload as PermissionRequest;
        setPendingPermissions((prev) => [...prev, permData]);
        break;

      case 'permission_response':
        // Remove handled permission
        const { id } = lastMessage.payload as { id: string };
        setPendingPermissions((prev) => prev.filter((p) => p.id !== id));
        break;
    }
  }, [lastMessage]);

  // Scroll to bottom on new messages
  useEffect(() => {
    if (messages.length > 0) {
      setTimeout(() => {
        flatListRef.current?.scrollToEnd({ animated: true });
      }, 100);
    }
  }, [messages.length, pendingPermissions.length]);

  const handleSend = useCallback(async () => {
    if (!inputText.trim() || !isConnected) return;

    const userMessage: ChatMessageData = {
      id: `msg_${Date.now()}`,
      role: 'user',
      content: [{ type: 'text', content: inputText.trim() }],
      timestamp: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInputText('');
    setIsLoading(true);

    try {
      await sendMessage({
        type: 'chat',
        payload: {
          content: inputText.trim(),
          agent_type: selectedAgent,
        },
      });
    } catch (error) {
      // Add error message
      setMessages((prev) => [
        ...prev,
        {
          id: `error_${Date.now()}`,
          role: 'error',
          content: [{ type: 'text', content: 'Failed to send message. Please try again.' }],
          timestamp: new Date().toISOString(),
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  }, [inputText, isConnected, selectedAgent, sendMessage]);

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
        setPendingPermissions((prev) => prev.filter((p) => p.id !== id));
      } catch (error) {
        console.error('Failed to approve permission:', error);
      }
    },
    [pendingPermissions, sendMessage]
  );

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
        setPendingPermissions((prev) => prev.filter((p) => p.id !== id));
      } catch (error) {
        console.error('Failed to deny permission:', error);
      }
    },
    [pendingPermissions, sendMessage]
  );

  const handlePairPress = () => {
    router.push('/(auth)/scan');
  };

  // Check if we can send messages
  const canSend = isConnected && inputText.trim().length > 0;

  // Render empty state if not connected or no messages
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

  // Combine messages and permissions for display
  const chatItems = [
    ...messages.map((m) => ({ type: 'message' as const, data: m })),
    ...pendingPermissions.map((p) => ({ type: 'permission' as const, data: p })),
  ].sort((a, b) => {
    const aTime = 'timestamp' in a.data ? a.data.timestamp : a.data.timestamp;
    const bTime = 'timestamp' in b.data ? b.data.timestamp : b.data.timestamp;
    return new Date(aTime).getTime() - new Date(bTime).getTime();
  });

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
          {(['claude', 'codex', 'gemini'] as AgentType[]).map((agent) => {
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
      {chatItems.length === 0 ? (
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
          />
          <Pressable
            onPress={handleSend}
            disabled={!canSend || isLoading}
            className={`ml-2 w-10 h-10 rounded-full items-center justify-center ${
              canSend && !isLoading ? 'bg-brand' : 'bg-zinc-800'
            }`}
          >
            {isLoading ? (
              <View className="w-5 h-5 rounded-full border-2 border-white border-t-transparent animate-spin" />
            ) : (
              <Ionicons
                name="send"
                size={20}
                color={canSend ? 'white' : '#71717a'}
              />
            )}
          </Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}
