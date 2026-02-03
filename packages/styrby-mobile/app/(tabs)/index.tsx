/**
 * Chat Screen
 *
 * Main chat interface for communicating with AI agents.
 * Shows active session, messages, and input for new messages.
 */

import { View, Text, ScrollView, TextInput, Pressable } from 'react-native';
import { useState } from 'react';
import { Ionicons } from '@expo/vector-icons';

export default function ChatScreen() {
  const [message, setMessage] = useState('');
  const [isConnected] = useState(false);

  return (
    <View className="flex-1 bg-background">
      {/* Connection Status Banner */}
      {!isConnected && (
        <View className="bg-error-network/20 px-4 py-2 flex-row items-center justify-center">
          <Ionicons name="cloud-offline" size={16} color="#eab308" />
          <Text className="text-yellow-500 text-sm ml-2">
            Not connected to CLI
          </Text>
        </View>
      )}

      {/* Empty State */}
      <ScrollView
        className="flex-1"
        contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', alignItems: 'center' }}
      >
        <View className="items-center px-8">
          <View className="w-16 h-16 rounded-2xl bg-brand/20 items-center justify-center mb-4">
            <Ionicons name="terminal" size={32} color="#f97316" />
          </View>
          <Text className="text-white text-xl font-semibold text-center mb-2">
            No Active Session
          </Text>
          <Text className="text-zinc-500 text-center mb-6">
            Pair your CLI to start chatting with your AI coding agents
          </Text>
          <Pressable className="bg-brand px-6 py-3 rounded-xl flex-row items-center">
            <Ionicons name="qr-code" size={20} color="white" />
            <Text className="text-white font-semibold ml-2">Scan QR Code</Text>
          </Pressable>
        </View>
      </ScrollView>

      {/* Input Area */}
      <View className="border-t border-zinc-800 p-4">
        <View className="flex-row items-end bg-background-secondary rounded-2xl px-4 py-2">
          <TextInput
            className="flex-1 text-white text-base py-2 max-h-32"
            placeholder="Message your agent..."
            placeholderTextColor="#71717a"
            value={message}
            onChangeText={setMessage}
            multiline
          />
          <Pressable
            className={`ml-2 w-10 h-10 rounded-full items-center justify-center ${
              message.trim() ? 'bg-brand' : 'bg-zinc-800'
            }`}
            disabled={!message.trim()}
          >
            <Ionicons
              name="send"
              size={20}
              color={message.trim() ? 'white' : '#71717a'}
            />
          </Pressable>
        </View>
      </View>
    </View>
  );
}
