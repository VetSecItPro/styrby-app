/**
 * Chat Message Component
 *
 * Renders a single message in the chat UI.
 * Supports different message types: user, agent, system, error.
 */

import { View, Text, Pressable } from 'react-native';
import { useState } from 'react';
import * as Clipboard from 'expo-clipboard';
import { Ionicons } from '@expo/vector-icons';
import type { AgentType } from 'styrby-shared';

/**
 * Message types
 */
export type MessageRole = 'user' | 'assistant' | 'system' | 'error';

/**
 * Message content block types
 */
export type ContentBlockType = 'text' | 'code' | 'thinking';

export interface ContentBlock {
  type: ContentBlockType;
  content: string;
  language?: string; // For code blocks
}

/**
 * Chat message data
 */
export interface ChatMessageData {
  id: string;
  role: MessageRole;
  agentType?: AgentType;
  content: ContentBlock[];
  timestamp: string;
  isStreaming?: boolean;
  costUsd?: number;
  durationMs?: number;
}

interface ChatMessageProps {
  message: ChatMessageData;
}

const AGENT_CONFIG: Record<AgentType, { name: string; color: string; bgColor: string }> = {
  claude: { name: 'Claude', color: '#f97316', bgColor: 'rgba(249, 115, 22, 0.1)' },
  codex: { name: 'Codex', color: '#22c55e', bgColor: 'rgba(34, 197, 94, 0.1)' },
  gemini: { name: 'Gemini', color: '#3b82f6', bgColor: 'rgba(59, 130, 246, 0.1)' },
};

function CodeBlock({ content, language }: { content: string; language?: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await Clipboard.setStringAsync(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <View className="bg-zinc-900 rounded-lg overflow-hidden my-2">
      {/* Header */}
      <View className="flex-row items-center justify-between px-3 py-2 bg-zinc-800/50 border-b border-zinc-700">
        <Text className="text-zinc-400 text-xs font-mono">{language || 'code'}</Text>
        <Pressable onPress={handleCopy} className="flex-row items-center">
          <Ionicons
            name={copied ? 'checkmark' : 'copy-outline'}
            size={14}
            color={copied ? '#22c55e' : '#71717a'}
          />
          <Text className="text-zinc-500 text-xs ml-1">{copied ? 'Copied!' : 'Copy'}</Text>
        </Pressable>
      </View>
      {/* Code */}
      <View className="p-3">
        <Text className="text-zinc-300 font-mono text-sm" selectable>
          {content}
        </Text>
      </View>
    </View>
  );
}

function ThinkingBlock({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <Pressable
      onPress={() => setExpanded(!expanded)}
      className="bg-zinc-800/50 rounded-lg my-2 overflow-hidden"
    >
      <View className="flex-row items-center px-3 py-2">
        <Ionicons name="bulb-outline" size={14} color="#71717a" />
        <Text className="text-zinc-500 text-xs ml-2 flex-1">Thinking...</Text>
        <Ionicons
          name={expanded ? 'chevron-up' : 'chevron-down'}
          size={14}
          color="#71717a"
        />
      </View>
      {expanded && (
        <View className="px-3 pb-3 border-t border-zinc-700">
          <Text className="text-zinc-500 text-sm mt-2">{content}</Text>
        </View>
      )}
    </Pressable>
  );
}

function TextBlock({ content }: { content: string }) {
  // Simple markdown-like rendering
  // Bold: **text**
  // Code: `text`
  // Links would need more work

  return (
    <Text className="text-zinc-200 text-base leading-6" selectable>
      {content}
    </Text>
  );
}

export function ChatMessage({ message }: ChatMessageProps) {
  const isUser = message.role === 'user';
  const isError = message.role === 'error';
  const isSystem = message.role === 'system';
  const agentConfig = message.agentType ? AGENT_CONFIG[message.agentType] : null;

  return (
    <View className={`px-4 py-3 ${isUser ? 'items-end' : 'items-start'}`}>
      {/* Agent indicator */}
      {!isUser && agentConfig && (
        <View className="flex-row items-center mb-2">
          <View
            style={{ backgroundColor: agentConfig.color }}
            className="w-5 h-5 rounded-md items-center justify-center"
          >
            <Text className="text-white text-xs font-bold">
              {agentConfig.name[0]}
            </Text>
          </View>
          <Text className="text-zinc-400 text-sm ml-2">{agentConfig.name}</Text>
          {message.isStreaming && (
            <View className="ml-2 flex-row items-center">
              <View className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
              <Text className="text-zinc-500 text-xs ml-1">typing</Text>
            </View>
          )}
        </View>
      )}

      {/* Message bubble */}
      <View
        className={`max-w-[85%] rounded-2xl px-4 py-3 ${
          isUser
            ? 'bg-brand rounded-br-md'
            : isError
              ? 'bg-red-500/10 border border-red-500/30'
              : isSystem
                ? 'bg-zinc-800/50'
                : 'bg-background-secondary rounded-bl-md'
        }`}
        style={!isUser && agentConfig ? { borderLeftWidth: 3, borderLeftColor: agentConfig.color } : undefined}
      >
        {/* Error icon */}
        {isError && (
          <View className="flex-row items-center mb-2">
            <Ionicons name="alert-circle" size={16} color="#ef4444" />
            <Text className="text-red-400 text-sm font-medium ml-2">Error</Text>
          </View>
        )}

        {/* Content blocks */}
        {message.content.map((block, index) => {
          switch (block.type) {
            case 'code':
              return <CodeBlock key={index} content={block.content} language={block.language} />;
            case 'thinking':
              return <ThinkingBlock key={index} content={block.content} />;
            default:
              return <TextBlock key={index} content={block.content} />;
          }
        })}

        {/* Footer with cost/duration */}
        {(message.costUsd !== undefined || message.durationMs !== undefined) && (
          <View className="flex-row items-center mt-2 pt-2 border-t border-zinc-700">
            {message.costUsd !== undefined && (
              <View className="flex-row items-center mr-3">
                <Ionicons name="wallet-outline" size={12} color="#71717a" />
                <Text className="text-zinc-500 text-xs ml-1">
                  ${message.costUsd.toFixed(4)}
                </Text>
              </View>
            )}
            {message.durationMs !== undefined && (
              <View className="flex-row items-center">
                <Ionicons name="time-outline" size={12} color="#71717a" />
                <Text className="text-zinc-500 text-xs ml-1">
                  {(message.durationMs / 1000).toFixed(1)}s
                </Text>
              </View>
            )}
          </View>
        )}
      </View>

      {/* Timestamp */}
      <Text className="text-zinc-600 text-xs mt-1">
        {new Date(message.timestamp).toLocaleTimeString([], {
          hour: 'numeric',
          minute: '2-digit',
        })}
      </Text>
    </View>
  );
}
