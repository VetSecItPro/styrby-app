/**
 * Sessions Screen
 *
 * List of past chat sessions with search and filtering.
 */

import { View, Text, FlatList, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

// Mock data for development
const MOCK_SESSIONS = [
  {
    id: '1',
    title: 'Authentication Flow',
    agent: 'claude' as const,
    lastMessage: 'Implemented OAuth with GitHub provider',
    timestamp: '2 hours ago',
    messageCount: 24,
  },
  {
    id: '2',
    title: 'Database Schema',
    agent: 'codex' as const,
    lastMessage: 'Created migration for user profiles',
    timestamp: 'Yesterday',
    messageCount: 18,
  },
  {
    id: '3',
    title: 'API Endpoints',
    agent: 'gemini' as const,
    lastMessage: 'Added rate limiting middleware',
    timestamp: '3 days ago',
    messageCount: 42,
  },
];

const agentColors = {
  claude: '#f97316',
  codex: '#22c55e',
  gemini: '#3b82f6',
};

export default function SessionsScreen() {
  return (
    <View className="flex-1 bg-background">
      {/* Search Bar */}
      <View className="px-4 py-3">
        <Pressable className="flex-row items-center bg-background-secondary rounded-xl px-4 py-3">
          <Ionicons name="search" size={20} color="#71717a" />
          <Text className="text-zinc-500 ml-2">Search sessions...</Text>
        </Pressable>
      </View>

      {/* Sessions List */}
      <FlatList
        data={MOCK_SESSIONS}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <Pressable className="px-4 py-3 border-b border-zinc-800/50 active:bg-zinc-900">
            <View className="flex-row items-start">
              {/* Agent Indicator */}
              <View
                className="w-10 h-10 rounded-full items-center justify-center mr-3"
                style={{ backgroundColor: `${agentColors[item.agent]}20` }}
              >
                <Ionicons
                  name="terminal"
                  size={20}
                  color={agentColors[item.agent]}
                />
              </View>

              {/* Session Info */}
              <View className="flex-1">
                <View className="flex-row items-center justify-between mb-1">
                  <Text className="text-white font-semibold" numberOfLines={1}>
                    {item.title}
                  </Text>
                  <Text className="text-zinc-500 text-xs">{item.timestamp}</Text>
                </View>
                <Text className="text-zinc-400 text-sm" numberOfLines={1}>
                  {item.lastMessage}
                </Text>
                <View className="flex-row items-center mt-1">
                  <View
                    className="px-2 py-0.5 rounded"
                    style={{ backgroundColor: `${agentColors[item.agent]}20` }}
                  >
                    <Text
                      className="text-xs font-medium capitalize"
                      style={{ color: agentColors[item.agent] }}
                    >
                      {item.agent}
                    </Text>
                  </View>
                  <Text className="text-zinc-500 text-xs ml-2">
                    {item.messageCount} messages
                  </Text>
                </View>
              </View>
            </View>
          </Pressable>
        )}
        ListEmptyComponent={
          <View className="flex-1 items-center justify-center py-20">
            <Ionicons name="chatbubbles-outline" size={48} color="#3f3f46" />
            <Text className="text-zinc-500 mt-4">No sessions yet</Text>
          </View>
        }
      />
    </View>
  );
}
