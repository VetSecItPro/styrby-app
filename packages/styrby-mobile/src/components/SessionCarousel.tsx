/**
 * Session Carousel
 *
 * Horizontal swipeable carousel showing active agent sessions.
 * Each card shows the agent type, current activity, and quick actions.
 */

import { View, Text, Pressable, Dimensions } from 'react-native';
import { useRef, useState } from 'react';
import PagerView from 'react-native-pager-view';
import { Ionicons } from '@expo/vector-icons';
import type { AgentType } from 'styrby-shared';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const CARD_WIDTH = SCREEN_WIDTH - 48; // 24px padding on each side

/**
 * Represents an active coding session displayed in the dashboard carousel.
 * Populated from the Supabase `sessions` table and updated in real time
 * via relay messages (session_state, cost_update, permission_request).
 */
export interface ActiveSession {
  /** Session UUID from Supabase */
  id: string;
  /** Which AI agent is running this session */
  agentType: AgentType;
  /** Session title (auto-generated or user-set) */
  title: string;
  /** Current session state for the carousel UI */
  status: 'running' | 'idle' | 'waiting_permission';
  /** ISO timestamp of the most recent activity */
  lastActivity?: string;
  /** Total number of messages in this session */
  messageCount: number;
  /** Total cost in USD for this session */
  costUsd: number;
  /** Pending permission request details, if the session is waiting for approval */
  pendingPermission?: {
    /** The relay permission request ID, used when sending approval/denial */
    requestId: string;
    /** Tool name being requested (e.g., "Bash", "Write") */
    type: string;
    /** Human-readable description of what the tool will do */
    description: string;
  };
}

interface SessionCarouselProps {
  sessions: ActiveSession[];
  onSessionPress: (session: ActiveSession) => void;
  onApprove?: (session: ActiveSession) => void;
  onDeny?: (session: ActiveSession) => void;
}

const AGENT_CONFIG: Record<AgentType, { name: string; color: string; bgColor: string; icon: keyof typeof Ionicons.glyphMap }> = {
  claude: { name: 'Claude', color: '#f97316', bgColor: 'rgba(249, 115, 22, 0.15)', icon: 'terminal' },
  codex: { name: 'Codex', color: '#22c55e', bgColor: 'rgba(34, 197, 94, 0.15)', icon: 'code-slash' },
  gemini: { name: 'Gemini', color: '#3b82f6', bgColor: 'rgba(59, 130, 246, 0.15)', icon: 'sparkles' },
  opencode: { name: 'OpenCode', color: '#8b5cf6', bgColor: 'rgba(139, 92, 246, 0.15)', icon: 'code-working' },
  aider: { name: 'Aider', color: '#ec4899', bgColor: 'rgba(236, 72, 153, 0.15)', icon: 'people' },
};

export function SessionCarousel({ sessions, onSessionPress, onApprove, onDeny }: SessionCarouselProps) {
  const pagerRef = useRef<PagerView>(null);
  const [currentPage, setCurrentPage] = useState(0);

  if (sessions.length === 0) {
    return (
      <View className="mx-4 bg-background-secondary rounded-xl p-6 items-center">
        <Ionicons name="albums-outline" size={32} color="#71717a" />
        <Text className="text-zinc-400 text-center mt-3">No active sessions</Text>
        <Text className="text-zinc-600 text-sm text-center mt-1">
          Start a session from your CLI to see it here
        </Text>
      </View>
    );
  }

  return (
    <View>
      <PagerView
        ref={pagerRef}
        style={{ height: 200 }}
        initialPage={0}
        onPageSelected={(e) => setCurrentPage(e.nativeEvent.position)}
      >
        {sessions.map((session) => {
          const config = AGENT_CONFIG[session.agentType];

          return (
            <View key={session.id} className="px-4">
              <Pressable
                onPress={() => onSessionPress(session)}
                style={{ backgroundColor: config.bgColor }}
                className="rounded-2xl p-4 h-full"
              >
                {/* Header */}
                <View className="flex-row items-center justify-between">
                  <View className="flex-row items-center">
                    <View
                      style={{ backgroundColor: config.color }}
                      className="w-8 h-8 rounded-lg items-center justify-center"
                    >
                      <Ionicons name={config.icon} size={18} color="white" />
                    </View>
                    <Text className="text-zinc-100 font-semibold ml-3">{config.name}</Text>
                  </View>
                  <View className="flex-row items-center">
                    <View
                      className={`w-2 h-2 rounded-full mr-2 ${
                        session.status === 'running'
                          ? 'bg-green-500'
                          : session.status === 'waiting_permission'
                            ? 'bg-orange-500 animate-pulse'
                            : 'bg-yellow-500'
                      }`}
                    />
                    <Text className="text-zinc-400 text-sm capitalize">
                      {session.status.replace('_', ' ')}
                    </Text>
                  </View>
                </View>

                {/* Title */}
                <Text className="text-zinc-100 text-lg font-medium mt-3" numberOfLines={1}>
                  {session.title || 'Active Session'}
                </Text>

                {/* Permission Request Banner */}
                {session.status === 'waiting_permission' && session.pendingPermission && (
                  <View className="bg-orange-500/20 rounded-lg p-3 mt-3">
                    <Text className="text-orange-400 text-sm font-medium">
                      Permission Required
                    </Text>
                    <Text className="text-zinc-300 text-sm mt-1" numberOfLines={1}>
                      {session.pendingPermission.description}
                    </Text>
                    <View className="flex-row mt-2">
                      <Pressable
                        onPress={() => onApprove?.(session)}
                        className="bg-green-500 px-4 py-1.5 rounded-lg mr-2"
                      >
                        <Text className="text-white font-medium text-sm">Approve</Text>
                      </Pressable>
                      <Pressable
                        onPress={() => onDeny?.(session)}
                        className="bg-zinc-700 px-4 py-1.5 rounded-lg"
                      >
                        <Text className="text-zinc-300 font-medium text-sm">Deny</Text>
                      </Pressable>
                    </View>
                  </View>
                )}

                {/* Stats Row */}
                {session.status !== 'waiting_permission' && (
                  <View className="flex-row mt-auto pt-3">
                    <View className="flex-row items-center mr-4">
                      <Ionicons name="chatbubble-outline" size={14} color="#71717a" />
                      <Text className="text-zinc-400 text-sm ml-1">{session.messageCount}</Text>
                    </View>
                    <View className="flex-row items-center">
                      <Ionicons name="wallet-outline" size={14} color="#71717a" />
                      <Text className="text-zinc-400 text-sm ml-1">${session.costUsd.toFixed(2)}</Text>
                    </View>
                  </View>
                )}
              </Pressable>
            </View>
          );
        })}
      </PagerView>

      {/* Page Indicators */}
      {sessions.length > 1 && (
        <View className="flex-row justify-center mt-3">
          {sessions.map((_, index) => (
            <View
              key={index}
              className={`w-2 h-2 rounded-full mx-1 ${
                index === currentPage ? 'bg-brand' : 'bg-zinc-700'
              }`}
            />
          ))}
        </View>
      )}
    </View>
  );
}
