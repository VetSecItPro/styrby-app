/**
 * Chat Message Component
 *
 * Renders a single message in the chat UI (user / assistant / system / error),
 * with markdown code parsing (fenced blocks, inline code) for text content.
 *
 * Cluster A2 split: the sub-renderers and pure parser were moved into
 * `./chat/*` to keep this file under the 400-LOC ceiling. The public API
 * (types + `parseMessageContent`) is re-exported here so existing importers of
 * `./ChatMessage` keep working unchanged.
 *
 * @module components/ChatMessage
 */

import { View, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { AgentType } from 'styrby-shared';
import type { ChatMessageData } from './chat/message-types';
import { CodeBlock } from './chat/CodeBlock';
import { ThinkingBlock } from './chat/ThinkingBlock';
import { TextBlock } from './chat/TextBlock';

// Re-export the public surface so `import { ... } from './ChatMessage'` is
// unchanged for every existing consumer (chat screen, SessionReplay, etc.).
export type {
  MessageRole,
  ContentBlockType,
  ContentBlock,
  ChatMessageData,
} from './chat/message-types';
export {
  parseMessageContent,
  parseInlineCode,
  type ParsedSegmentType,
  type ParsedSegment,
} from './chat/message-content';

interface ChatMessageProps {
  message: ChatMessageData;
}

/** Per-agent display config (name + accent colors). */
const AGENT_CONFIG: Record<AgentType, { name: string; color: string; bgColor: string }> = {
  claude: { name: 'Claude', color: '#f97316', bgColor: 'rgba(249, 115, 22, 0.1)' },
  codex: { name: 'Codex', color: '#22c55e', bgColor: 'rgba(34, 197, 94, 0.1)' },
  gemini: { name: 'Gemini', color: '#3b82f6', bgColor: 'rgba(59, 130, 246, 0.1)' },
  opencode: { name: 'OpenCode', color: '#8b5cf6', bgColor: 'rgba(139, 92, 246, 0.1)' },
  aider: { name: 'Aider', color: '#ec4899', bgColor: 'rgba(236, 72, 153, 0.1)' },
  goose: { name: 'Goose', color: '#06b6d4', bgColor: 'rgba(6, 182, 212, 0.1)' },
  amp: { name: 'Amp', color: '#f59e0b', bgColor: 'rgba(245, 158, 11, 0.1)' },
  crush: { name: 'Crush', color: '#f43f5e', bgColor: 'rgba(244, 63, 94, 0.1)' },
  kilo: { name: 'Kilo', color: '#0ea5e9', bgColor: 'rgba(14, 165, 233, 0.1)' },
  kiro: { name: 'Kiro', color: '#f97316', bgColor: 'rgba(249, 115, 22, 0.1)' },
  droid: { name: 'Droid', color: '#64748b', bgColor: 'rgba(100, 116, 139, 0.1)' },
};

/**
 * Renders one chat message bubble with its agent header, content blocks, and
 * optional cost/duration footer.
 */
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
            <Text className="text-white text-xs font-bold">{agentConfig.name[0]}</Text>
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
                <Text className="text-zinc-500 text-xs ml-1">${message.costUsd.toFixed(4)}</Text>
              </View>
            )}
            {message.durationMs !== undefined && (
              <View className="flex-row items-center">
                <Ionicons name="time-outline" size={12} color="#71717a" />
                <Text className="text-zinc-500 text-xs ml-1">{(message.durationMs / 1000).toFixed(1)}s</Text>
              </View>
            )}
          </View>
        )}
      </View>

      {/* Timestamp */}
      <Text className="text-zinc-600 text-xs mt-1">
        {new Date(message.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
      </Text>
    </View>
  );
}
