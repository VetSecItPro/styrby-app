/**
 * ChatEmptyState
 *
 * Renders the appropriate "nothing to show" UI for the chat screen
 * based on connection / pairing / loading state.
 *
 * WHY a dedicated component: There are four distinct empty-state variants
 * (unpaired, offline, loading-history, ready-to-chat). Inlining all four in
 * the orchestrator obscured the data-flow logic. A single switch component
 * keeps the orchestrator render lean and makes each variant easy to
 * snapshot-test in isolation.
 */

import { View, Text, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

/**
 * Props for {@link ChatEmptyState}.
 */
export interface ChatEmptyStateProps {
  /** Whether the user has paired a CLI machine */
  isPaired: boolean;
  /** Whether the relay socket is connected */
  isConnected: boolean;
  /** Whether the device has internet connectivity */
  isOnline: boolean;
  /** Whether we're currently loading historical messages from Supabase */
  isLoadingHistory: boolean;
  /** Called when the user taps the "Scan QR Code" button (unpaired variant) */
  onPairPress: () => void;
}

/**
 * Renders one of four empty-state variants based on the current state flags.
 *
 * Variant precedence: unpaired -> disconnected -> loading-history -> ready.
 *
 * @param props - {@link ChatEmptyStateProps}
 * @returns React element for the empty state
 */
export function ChatEmptyState({
  isPaired,
  isConnected,
  isOnline,
  isLoadingHistory,
  onPairPress,
}: ChatEmptyStateProps) {
  if (!isPaired) {
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
          onPress={onPairPress}
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
}
