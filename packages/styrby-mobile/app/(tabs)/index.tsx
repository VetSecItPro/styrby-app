/**
 * Dashboard Screen
 *
 * Multi-agent dashboard showing status of all connected AI agents.
 * Displays swipeable session cards, notifications, and quick stats.
 */

import { View, Text, ScrollView, Pressable, RefreshControl } from 'react-native';
import { useState, useCallback } from 'react';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useRelay } from '../../src/hooks/useRelay';
import { SessionCarousel, type ActiveSession } from '../../src/components/SessionCarousel';
import { NotificationStream, type Notification } from '../../src/components/NotificationStream';
import type { AgentType } from 'styrby-shared';

/**
 * Agent configuration with display properties.
 */
const AGENTS: Array<{
  type: AgentType;
  name: string;
  icon: keyof typeof Ionicons.glyphMap;
  color: string;
  bgColor: string;
}> = [
  {
    type: 'claude',
    name: 'Claude Code',
    icon: 'terminal',
    color: '#f97316',
    bgColor: 'rgba(249, 115, 22, 0.1)',
  },
  {
    type: 'codex',
    name: 'Codex CLI',
    icon: 'code-slash',
    color: '#22c55e',
    bgColor: 'rgba(34, 197, 94, 0.1)',
  },
  {
    type: 'gemini',
    name: 'Gemini CLI',
    icon: 'sparkles',
    color: '#3b82f6',
    bgColor: 'rgba(59, 130, 246, 0.1)',
  },
];

export default function DashboardScreen() {
  const {
    isConnected,
    isOnline,
    isCliOnline,
    pairingInfo,
    pendingQueueCount,
    connect,
    sendMessage,
  } = useRelay();

  const [refreshing, setRefreshing] = useState(false);

  // Mock active sessions - will be populated from relay
  const [activeSessions, setActiveSessions] = useState<ActiveSession[]>([]);

  // Mock notifications - will be populated from relay
  const [notifications, setNotifications] = useState<Notification[]>([]);

  // Mock agent status
  const [agentStatus] = useState<Record<AgentType, { online: boolean; cost: number }>>({
    claude: { online: false, cost: 0 },
    codex: { online: false, cost: 0 },
    gemini: { online: false, cost: 0 },
  });

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await connect();
    } finally {
      setRefreshing(false);
    }
  }, [connect]);

  const handleAgentPress = (agentType: AgentType) => {
    router.push({
      pathname: '/(tabs)/chat',
      params: { agent: agentType },
    });
  };

  const handleSessionPress = (session: ActiveSession) => {
    router.push({
      pathname: '/(tabs)/chat',
      params: { agent: session.agentType, sessionId: session.id },
    });
  };

  const handleApprove = async (session: ActiveSession) => {
    if (session.pendingPermission) {
      await sendMessage({
        type: 'permission_response',
        payload: {
          session_id: session.id,
          approved: true,
        },
      });
    }
  };

  const handleDeny = async (session: ActiveSession) => {
    if (session.pendingPermission) {
      await sendMessage({
        type: 'permission_response',
        payload: {
          session_id: session.id,
          approved: false,
        },
      });
    }
  };

  const handlePairPress = () => {
    router.push('/(auth)/scan');
  };

  const handleNotificationPress = (notification: Notification) => {
    if (notification.sessionId) {
      router.push({
        pathname: '/(tabs)/chat',
        params: { sessionId: notification.sessionId },
      });
    }
  };

  const handleMarkRead = (id: string) => {
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, read: true } : n))
    );
  };

  // Calculate totals
  const totalCostToday = Object.values(agentStatus).reduce((sum, a) => sum + a.cost, 0);
  const activeAgentCount = Object.values(agentStatus).filter((a) => a.online).length;

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerStyle={{ paddingBottom: 24 }}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#f97316" />
      }
    >
      {/* Connection Status Banner */}
      <View className="mx-4 mt-4">
        <View
          className={`rounded-xl px-4 py-3 flex-row items-center justify-between ${
            isConnected && isCliOnline
              ? 'bg-green-500/10'
              : isConnected
                ? 'bg-yellow-500/10'
                : 'bg-zinc-800'
          }`}
        >
          <View className="flex-row items-center">
            <View
              className={`w-2 h-2 rounded-full mr-3 ${
                isConnected && isCliOnline
                  ? 'bg-green-500'
                  : isConnected
                    ? 'bg-yellow-500'
                    : 'bg-zinc-500'
              }`}
            />
            <Text className="text-zinc-100">
              {isConnected && isCliOnline
                ? 'Connected to CLI'
                : isConnected
                  ? 'Waiting for CLI'
                  : pairingInfo
                    ? 'Disconnected'
                    : 'Not paired'}
            </Text>
          </View>

          {!pairingInfo ? (
            <Pressable
              onPress={handlePairPress}
              className="bg-brand px-3 py-1.5 rounded-lg flex-row items-center"
            >
              <Ionicons name="qr-code" size={14} color="white" />
              <Text className="text-white text-sm font-medium ml-1">Pair</Text>
            </Pressable>
          ) : !isOnline ? (
            <View className="flex-row items-center">
              <Ionicons name="cloud-offline" size={16} color="#eab308" />
              <Text className="text-yellow-500 text-sm ml-1">Offline</Text>
            </View>
          ) : null}
        </View>

        {/* Pending queue indicator */}
        {pendingQueueCount > 0 && (
          <View className="mt-2 bg-orange-500/10 rounded-lg px-3 py-2 flex-row items-center">
            <Ionicons name="hourglass" size={14} color="#f97316" />
            <Text className="text-orange-400 text-sm ml-2">
              {pendingQueueCount} message{pendingQueueCount !== 1 ? 's' : ''} queued
            </Text>
          </View>
        )}
      </View>

      {/* Active Sessions Carousel */}
      {activeSessions.length > 0 && (
        <View className="mt-6">
          <Text className="text-zinc-400 text-sm font-medium mx-4 mb-3">ACTIVE SESSIONS</Text>
          <SessionCarousel
            sessions={activeSessions}
            onSessionPress={handleSessionPress}
            onApprove={handleApprove}
            onDeny={handleDeny}
          />
        </View>
      )}

      {/* Quick Stats */}
      <View className="mx-4 mt-6">
        <Text className="text-zinc-400 text-sm font-medium mb-3">TODAY</Text>
        <View className="flex-row">
          <View className="flex-1 bg-background-secondary rounded-xl p-4 mr-2">
            <Ionicons name="wallet" size={20} color="#f97316" />
            <Text className="text-zinc-100 text-xl font-bold mt-2">
              ${totalCostToday.toFixed(2)}
            </Text>
            <Text className="text-zinc-500 text-sm">Total spend</Text>
          </View>
          <View className="flex-1 bg-background-secondary rounded-xl p-4 ml-2">
            <Ionicons name="pulse" size={20} color="#22c55e" />
            <Text className="text-zinc-100 text-xl font-bold mt-2">{activeAgentCount}</Text>
            <Text className="text-zinc-500 text-sm">Active agents</Text>
          </View>
        </View>
      </View>

      {/* Agent Cards */}
      <View className="mx-4 mt-6">
        <Text className="text-zinc-400 text-sm font-medium mb-3">AGENTS</Text>
        {AGENTS.map((agent) => {
          const status = agentStatus[agent.type];
          return (
            <Pressable
              key={agent.type}
              onPress={() => handleAgentPress(agent.type)}
              className="bg-background-secondary rounded-xl mb-3 overflow-hidden"
            >
              <View className="flex-row items-center p-4">
                <View
                  style={{ backgroundColor: agent.bgColor }}
                  className="w-12 h-12 rounded-xl items-center justify-center"
                >
                  <Ionicons name={agent.icon} size={24} color={agent.color} />
                </View>
                <View className="flex-1 ml-4">
                  <View className="flex-row items-center">
                    <Text className="text-zinc-100 font-semibold text-base">{agent.name}</Text>
                    {status.online && (
                      <View className="ml-2 w-2 h-2 rounded-full bg-green-500" />
                    )}
                  </View>
                  <Text className="text-zinc-500 text-sm mt-0.5">
                    {status.online ? 'Connected' : 'Not connected'}
                  </Text>
                </View>
                <View className="items-end">
                  {status.online ? (
                    <>
                      <Text className="text-zinc-300 font-medium">${status.cost.toFixed(2)}</Text>
                      <Text className="text-zinc-600 text-xs">today</Text>
                    </>
                  ) : (
                    <Ionicons name="chevron-forward" size={20} color="#71717a" />
                  )}
                </View>
              </View>
            </Pressable>
          );
        })}
      </View>

      {/* Notifications */}
      <View className="mx-4 mt-6">
        <Text className="text-zinc-400 text-sm font-medium mb-3">NOTIFICATIONS</Text>
        <View className="bg-background-secondary rounded-xl overflow-hidden">
          <NotificationStream
            notifications={notifications}
            onNotificationPress={handleNotificationPress}
            onMarkRead={handleMarkRead}
            maxItems={5}
          />
        </View>
      </View>
    </ScrollView>
  );
}
