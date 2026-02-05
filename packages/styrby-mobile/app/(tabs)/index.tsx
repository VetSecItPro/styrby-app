/**
 * Dashboard Screen
 *
 * Multi-agent dashboard showing status of all connected AI agents.
 * Displays swipeable session cards, notifications, and quick stats.
 *
 * Data sources:
 * - Active sessions: loaded from Supabase `sessions` table + real-time relay updates
 * - Notifications: loaded from Supabase `audit_log` table (last 24 hours)
 * - Agent status: derived from active sessions + relay presence
 * - Quick stats: aggregated from `cost_records` table + live session count
 */

import { View, Text, ScrollView, Pressable, RefreshControl } from 'react-native';
import { useState, useCallback } from 'react';
import { router, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useRelay } from '../../src/hooks/useRelay';
import { useDashboardData } from '../../src/hooks/useDashboardData';
import { SessionCarousel, type ActiveSession } from '../../src/components/SessionCarousel';
import { NotificationStream, type Notification } from '../../src/components/NotificationStream';
import type { AgentType } from 'styrby-shared';

/**
 * Agent configuration with display properties for the agent card list.
 * These are the three primary agents shown on the dashboard regardless
 * of whether they have active sessions.
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

/**
 * Dashboard screen component.
 *
 * Wires together the relay hook (for real-time CLI communication) and the
 * dashboard data hook (for Supabase queries + relay-driven state updates).
 *
 * Refresh behavior:
 * - Pull-to-refresh: re-establishes relay connection + reloads all Supabase data
 * - Tab focus: reloads Supabase data when the user navigates back to this tab
 * - Relay messages: updates session state, costs, and permissions in real time
 *
 * @returns The dashboard screen JSX
 */
export default function DashboardScreen() {
  const {
    isConnected,
    isOnline,
    isCliOnline,
    pairingInfo,
    pendingQueueCount,
    connectedDevices,
    lastMessage,
    connect,
    sendMessage,
  } = useRelay();

  const {
    activeSessions,
    notifications: dashboardNotifications,
    agentStatus,
    quickStats,
    isLoading,
    refresh: refreshDashboardData,
  } = useDashboardData(lastMessage, connectedDevices);

  const [refreshing, setRefreshing] = useState(false);

  /**
   * WHY: Notifications need local "read" state that persists during the session
   * but doesn't need to be written back to the database (audit_log is immutable).
   * We maintain a state set of read notification IDs and merge it with the data
   * from the hook. Using state (not a ref) ensures the UI re-renders immediately
   * when a notification is marked read, without triggering a Supabase re-fetch.
   */
  const [readNotificationIds, setReadNotificationIds] = useState<Set<string>>(new Set());

  /**
   * Merges dashboard notifications with locally tracked read state.
   * Notifications fetched from the audit_log start as unread; once the user
   * taps one, we mark it read locally for the duration of the app session.
   */
  const notifications: Notification[] = dashboardNotifications.map((n) => ({
    ...n,
    read: readNotificationIds.has(n.id) ? true : n.read,
  }));

  // --------------------------------------------------------------------------
  // Refresh
  // --------------------------------------------------------------------------

  /**
   * Pull-to-refresh handler. Reconnects the relay and reloads all dashboard
   * data from Supabase in parallel.
   */
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([
        connect(),
        refreshDashboardData(),
      ]);
    } finally {
      setRefreshing(false);
    }
  }, [connect, refreshDashboardData]);

  // --------------------------------------------------------------------------
  // Focus Refresh
  // --------------------------------------------------------------------------

  /**
   * WHY: When the user navigates away (e.g., to chat) and comes back, the
   * session list and costs may be stale. useFocusEffect fires every time this
   * tab receives focus, keeping data fresh without background polling.
   */
  useFocusEffect(
    useCallback(() => {
      refreshDashboardData();
    }, [refreshDashboardData])
  );

  // --------------------------------------------------------------------------
  // Navigation Handlers
  // --------------------------------------------------------------------------

  /**
   * Navigates to the chat tab for a specific agent.
   *
   * @param agentType - The agent to open in the chat view
   */
  const handleAgentPress = (agentType: AgentType) => {
    router.push({
      pathname: '/(tabs)/chat',
      params: { agent: agentType },
    });
  };

  /**
   * Navigates to the chat tab for a specific session.
   *
   * @param session - The active session to open
   */
  const handleSessionPress = (session: ActiveSession) => {
    router.push({
      pathname: '/(tabs)/chat',
      params: { agent: session.agentType, sessionId: session.id },
    });
  };

  // --------------------------------------------------------------------------
  // Permission Handlers
  // --------------------------------------------------------------------------

  /**
   * Approves a pending permission request for a session.
   * Sends a permission_response message through the relay to the CLI.
   *
   * @param session - The session with the pending permission
   */
  const handleApprove = async (session: ActiveSession) => {
    if (session.pendingPermission) {
      await sendMessage({
        type: 'permission_response',
        payload: {
          request_id: session.pendingPermission.requestId,
          approved: true,
        },
      });
    }
  };

  /**
   * Denies a pending permission request for a session.
   * Sends a permission_response message through the relay to the CLI.
   *
   * @param session - The session with the pending permission
   */
  const handleDeny = async (session: ActiveSession) => {
    if (session.pendingPermission) {
      await sendMessage({
        type: 'permission_response',
        payload: {
          request_id: session.pendingPermission.requestId,
          approved: false,
        },
      });
    }
  };

  /**
   * Navigates to the pairing/scan screen so the user can pair with a CLI.
   */
  const handlePairPress = () => {
    router.push('/(auth)/scan');
  };

  // --------------------------------------------------------------------------
  // Notification Handlers
  // --------------------------------------------------------------------------

  /**
   * Handles a notification tap. If the notification is associated with a
   * session, navigates to that session in the chat tab.
   *
   * @param notification - The tapped notification
   */
  const handleNotificationPress = (notification: Notification) => {
    // Mark as read immediately on press
    setReadNotificationIds((prev) => new Set(prev).add(notification.id));

    if (notification.sessionId) {
      router.push({
        pathname: '/(tabs)/chat',
        params: { sessionId: notification.sessionId },
      });
    }
  };

  /**
   * Marks a notification as read in local state.
   * WHY: We don't persist read state to the database because audit_log entries
   * are immutable. Read state is session-scoped and resets on app restart.
   * Using a state set (not a ref) ensures the component re-renders immediately
   * without triggering a Supabase re-fetch.
   *
   * @param id - The notification ID to mark as read
   */
  const handleMarkRead = (id: string) => {
    setReadNotificationIds((prev) => new Set(prev).add(id));
  };

  // --------------------------------------------------------------------------
  // Derived Values
  // --------------------------------------------------------------------------

  const { totalCostToday, activeAgentCount } = quickStats;

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerStyle={{ paddingBottom: 24 }}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor="#f97316"
          accessibilityLabel="Pull to refresh dashboard data"
        />
      }
      accessibilityRole="scrollbar"
      accessibilityLabel="Dashboard"
    >
      {/* Connection Status Banner */}
      <View className="mx-4 mt-4">
        <Pressable
          className={`rounded-xl px-4 py-3 flex-row items-center justify-between ${
            isConnected && isCliOnline
              ? 'bg-green-500/10'
              : isConnected
                ? 'bg-yellow-500/10'
                : 'bg-zinc-800'
          }`}
          accessibilityRole="button"
          accessibilityLabel={
            isConnected && isCliOnline
              ? 'Connected to CLI'
              : isConnected
                ? 'Waiting for CLI to come online'
                : pairingInfo
                  ? 'Disconnected from relay'
                  : 'Not paired with a CLI device'
          }
          accessibilityState={{
            disabled: true,
          }}
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
              accessibilityRole="button"
              accessibilityLabel="Pair with a CLI device"
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
        </Pressable>

        {/* Pending queue indicator */}
        {pendingQueueCount > 0 && (
          <View
            className="mt-2 bg-orange-500/10 rounded-lg px-3 py-2 flex-row items-center"
            accessibilityRole="text"
            accessibilityLabel={`${pendingQueueCount} message${pendingQueueCount !== 1 ? 's' : ''} queued for delivery`}
          >
            <Ionicons name="hourglass" size={14} color="#f97316" />
            <Text className="text-orange-400 text-sm ml-2">
              {pendingQueueCount} message{pendingQueueCount !== 1 ? 's' : ''} queued
            </Text>
          </View>
        )}
      </View>

      {/* Active Sessions Carousel */}
      {activeSessions.length > 0 && (
        <View className="mt-6" accessibilityRole="summary" accessibilityLabel="Active sessions">
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
      <View className="mx-4 mt-6" accessibilityRole="summary" accessibilityLabel="Today's statistics">
        <Text className="text-zinc-400 text-sm font-medium mb-3">TODAY</Text>
        <View className="flex-row">
          <View
            className="flex-1 bg-background-secondary rounded-xl p-4 mr-2"
            accessibilityRole="text"
            accessibilityLabel={`Total spend today: $${totalCostToday.toFixed(2)}`}
          >
            <Ionicons name="wallet" size={20} color="#f97316" />
            <Text className="text-zinc-100 text-xl font-bold mt-2">
              ${totalCostToday.toFixed(2)}
            </Text>
            <Text className="text-zinc-500 text-sm">Total spend</Text>
          </View>
          <View
            className="flex-1 bg-background-secondary rounded-xl p-4 ml-2"
            accessibilityRole="text"
            accessibilityLabel={`${activeAgentCount} active agent${activeAgentCount !== 1 ? 's' : ''}`}
          >
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
              accessibilityRole="button"
              accessibilityLabel={`${agent.name}, ${status?.online ? 'connected' : 'not connected'}${
                status?.online ? `, $${status.cost.toFixed(2)} spent today` : ''
              }`}
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
                    {status?.online && (
                      <View className="ml-2 w-2 h-2 rounded-full bg-green-500" />
                    )}
                  </View>
                  <Text className="text-zinc-500 text-sm mt-0.5">
                    {status?.online ? 'Connected' : 'Not connected'}
                  </Text>
                </View>
                <View className="items-end">
                  {status?.online ? (
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
      <View className="mx-4 mt-6" accessibilityRole="list" accessibilityLabel="Recent notifications">
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
