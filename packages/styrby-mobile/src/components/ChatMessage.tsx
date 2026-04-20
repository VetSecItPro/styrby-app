/**
 * Chat Message Component
 *
 * Renders a single message in the chat UI.
 * Supports different message types: user, agent, system, error.
 *
 * Enhanced with markdown code parsing:
 * - Fenced code blocks (```lang ... ```) with language labels, copy button,
 *   and horizontal scrolling
 * - Inline code (`code`) with monospace font and distinct background
 * - Regular text renders normally (no regressions)
 *
 * @module components/ChatMessage
 */

import { View, Text, Pressable, ScrollView, Platform } from 'react-native';
import { useState, useMemo, useRef, useEffect } from 'react';
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
  opencode: { name: 'OpenCode', color: '#8b5cf6', bgColor: 'rgba(139, 92, 246, 0.1)' },
  aider: { name: 'Aider', color: '#ec4899', bgColor: 'rgba(236, 72, 153, 0.1)' },
  goose: { name: 'Goose', color: '#06b6d4', bgColor: 'rgba(6, 182, 212, 0.1)' },
  amp: { name: 'Amp', color: '#f59e0b', bgColor: 'rgba(245, 158, 11, 0.1)' },
  crush: { name: 'Crush', color: '#f43f5e', bgColor: 'rgba(244, 63, 94, 0.1)' },
  kilo: { name: 'Kilo', color: '#0ea5e9', bgColor: 'rgba(14, 165, 233, 0.1)' },
  kiro: { name: 'Kiro', color: '#f97316', bgColor: 'rgba(249, 115, 22, 0.1)' },
  droid: { name: 'Droid', color: '#64748b', bgColor: 'rgba(100, 116, 139, 0.1)' },
};

function CodeBlock({ content, language }: { content: string; language?: string }) {
  const [copied, setCopied] = useState(false);

  /**
   * Stores active timer IDs so they can be cleared if the component unmounts
   * before they fire, preventing state updates on unmounted components.
   */
  const timerIdsRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  // WHY: Clear all pending timers when the component unmounts. Without this,
  // the setCopied(false) and Clipboard.setStringAsync('') callbacks fire on an
  // already-unmounted component, causing React "Can't perform a state update on
  // an unmounted component" warnings and potential clipboard side-effects.
  useEffect(() => {
    // WHY: Capture the ref value in a local variable so the cleanup function
    // always operates on the same array instance even if timerIdsRef.current
    // is reassigned before cleanup runs (React's ref timing guarantee).
    const timers = timerIdsRef.current;
    return () => {
      timers.forEach(clearTimeout);
    };
  }, []);

  const handleCopy = async () => {
    await Clipboard.setStringAsync(content);
    setCopied(true);
    // Reset the "Copied!" indicator after 2 seconds
    timerIdsRef.current.push(setTimeout(() => setCopied(false), 2000));
    // SEC-MOB-001 FIX: Clear the clipboard after 30 seconds.
    // WHY: Code blocks may contain secrets (API keys, tokens, passwords) that
    // the developer copies during a session. If the user copies sensitive content
    // and then switches apps, that data sits in the system clipboard indefinitely,
    // accessible to any app that reads the clipboard (many do so on every focus).
    // Clearing after 30 seconds limits the exposure window without disrupting
    // normal paste workflows (users typically paste within a few seconds).
    timerIdsRef.current.push(setTimeout(() => Clipboard.setStringAsync(''), 30000));
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

// ============================================================================
// Markdown Content Parsing
// ============================================================================

/**
 * Segment types produced by parsing message content for markdown-style
 * code fences and inline code backticks.
 */
export type ParsedSegmentType = 'text' | 'code_block' | 'inline_code';

/**
 * A parsed segment of message content.
 * The parser splits raw text into these segments so each can be
 * rendered with the appropriate component.
 */
export interface ParsedSegment {
  /** What kind of content this segment represents */
  type: ParsedSegmentType;
  /** The text content of the segment (code or prose) */
  content: string;
  /** Language identifier for code blocks (e.g., "typescript") */
  language?: string;
}

/**
 * Monospace font family selected per platform.
 * WHY: iOS and Android ship different built-in monospace fonts.
 * Using Platform.select avoids a runtime lookup and keeps the
 * bundle free of custom font files.
 */
const MONO_FONT_FAMILY = Platform.select({
  ios: 'Menlo',
  android: 'monospace',
  default: 'monospace',
});

/**
 * Parses message content into segments of text, code blocks, and inline code.
 *
 * Handles:
 * - Fenced code blocks (triple backtick with optional language)
 * - Inline code (single backtick)
 * - Regular text (everything else)
 * - Edge cases: empty code blocks, unclosed fences, nested backticks
 *
 * @param content - Raw message content string
 * @returns Array of parsed segments for rendering
 *
 * @example
 * parseMessageContent("Hello `world`")
 * // => [{ type: 'text', content: 'Hello ' }, { type: 'inline_code', content: 'world' }]
 */
export function parseMessageContent(content: string): ParsedSegment[] {
  const segments: ParsedSegment[] = [];
  if (!content) return segments;

  // WHY: We use a two-pass approach — first extract fenced code blocks,
  // then parse the remaining text for inline code. This prevents backticks
  // inside fenced blocks from being treated as inline code delimiters.
  //
  // KNOWN LIMITATION: Nested code fences (``` inside ```) are not supported by
  // this regex-based parser. A message like:
  //   ````md
  //   ```js
  //   code
  //   ```
  //   ````
  // will be parsed incorrectly. This edge case is extremely rare in AI-generated
  // output and not worth the complexity of a full CommonMark parser here.
  const codeBlockRegex = /```(\w*)\n?([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = codeBlockRegex.exec(content)) !== null) {
    // Text before this code block
    if (match.index > lastIndex) {
      const textBefore = content.slice(lastIndex, match.index);
      segments.push(...parseInlineCode(textBefore));
    }

    // The fenced code block itself
    const language = match[1] || undefined;
    const codeContent = match[2];
    // WHY: Only add the segment if there's actual content. Empty fences
    // (``` ```) are valid markdown but render as nothing useful.
    if (codeContent.trim()) {
      segments.push({ type: 'code_block', content: codeContent, language });
    }

    lastIndex = match.index + match[0].length;
  }

  // Remaining text after the last code block (or all text if no blocks found)
  if (lastIndex < content.length) {
    const remaining = content.slice(lastIndex);
    segments.push(...parseInlineCode(remaining));
  }

  return segments;
}

/**
 * Parses a text string for inline code segments (single backtick delimited).
 *
 * @param text - Text that does not contain fenced code blocks
 * @returns Array of text and inline_code segments
 */
function parseInlineCode(text: string): ParsedSegment[] {
  const segments: ParsedSegment[] = [];
  // WHY: Non-greedy match between single backticks. We avoid matching
  // double/triple backticks by requiring non-backtick after opening.
  const inlineRegex = /`([^`]+)`/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = inlineRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', content: text.slice(lastIndex, match.index) });
    }
    segments.push({ type: 'inline_code', content: match[1] });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    segments.push({ type: 'text', content: text.slice(lastIndex) });
  }

  return segments;
}

// ============================================================================
// Inline Code Block Component (for fenced code blocks found inside text)
// ============================================================================

/**
 * Renders a fenced code block found inside a text segment.
 * Provides a dark container with language label, horizontal scrolling,
 * and a copy button.
 *
 * @param props - code content and optional language identifier
 * @returns Styled code block with copy functionality
 */
function InlineCodeBlock({ content: codeContent, language }: { content: string; language?: string }) {
  const [copied, setCopied] = useState(false);

  /**
   * Stores active timer IDs so they can be cleared if the component unmounts
   * before they fire. Same pattern as CodeBlock above.
   */
  const timerIdsRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    // WHY: Capture the ref value in a local variable so the cleanup function
    // always operates on the same array instance even if timerIdsRef.current
    // is reassigned before cleanup runs (React's ref timing guarantee).
    const timers = timerIdsRef.current;
    return () => {
      timers.forEach(clearTimeout);
    };
  }, []);

  /**
   * Copies the code content to the clipboard with a timed clear.
   */
  const handleCopy = async () => {
    await Clipboard.setStringAsync(codeContent);
    setCopied(true);
    timerIdsRef.current.push(setTimeout(() => setCopied(false), 2000));
    // WHY: Same security pattern as the main CodeBlock — clear clipboard
    // after 30s to limit exposure of potentially sensitive code.
    timerIdsRef.current.push(setTimeout(() => Clipboard.setStringAsync(''), 30000));
  };

  return (
    <View className="bg-zinc-900 rounded-lg border border-zinc-800 my-2 overflow-hidden">
      {/* Header row: language label + copy button */}
      <View className="flex-row items-center justify-between px-3 py-1.5 bg-zinc-800/50">
        <Text className="text-zinc-500 text-xs" style={{ fontFamily: MONO_FONT_FAMILY }}>
          {language || 'code'}
        </Text>
        <Pressable
          onPress={handleCopy}
          hitSlop={8}
          className="flex-row items-center"
          accessibilityRole="button"
          accessibilityLabel={`Copy ${language || 'code'} block`}
        >
          <Ionicons
            name={copied ? 'checkmark' : 'copy-outline'}
            size={14}
            color={copied ? '#22c55e' : '#71717a'}
          />
          <Text className="text-zinc-400 text-xs ml-1">
            {copied ? 'Copied!' : 'Copy'}
          </Text>
        </Pressable>
      </View>
      {/* Code content with horizontal scroll for long lines */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View className="p-3">
          <Text
            className="text-sm text-green-400"
            style={{ fontFamily: MONO_FONT_FAMILY }}
            selectable
          >
            {codeContent}
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

// ============================================================================
// Text Block Component (enhanced with inline code + code block parsing)
// ============================================================================

/**
 * Renders a text content block with markdown-style code parsing.
 *
 * Parses the raw text for:
 * - Fenced code blocks (```language ... ```) rendered as distinct containers
 * - Inline code (`code`) rendered with monospace font and background
 * - Regular text rendered normally
 *
 * @param props - The text content to render
 * @returns Parsed and styled text with code highlighting
 */
function TextBlock({ content }: { content: string }) {
  // WHY: Memoize parsing so we don't re-parse on every render.
  // Message content is immutable once received, so this is safe.
  const segments = useMemo(() => parseMessageContent(content), [content]);

  // Fast path: if no code was found, render as plain text (most common case)
  if (segments.length === 1 && segments[0].type === 'text') {
    return (
      <Text className="text-zinc-200 text-base leading-6" selectable>
        {content}
      </Text>
    );
  }

  return (
    <View>
      {segments.map((segment, index) => {
        switch (segment.type) {
          case 'code_block':
            return (
              <InlineCodeBlock
                key={index}
                content={segment.content}
                language={segment.language}
              />
            );
          case 'inline_code':
            return (
              <Text key={index} className="text-zinc-200 text-base leading-6" selectable>
                <Text
                  className="text-sm text-orange-300 bg-zinc-800 rounded px-1.5 py-0.5"
                  style={{ fontFamily: MONO_FONT_FAMILY }}
                >
                  {segment.content}
                </Text>
              </Text>
            );
          default:
            return (
              <Text
                key={index}
                className="text-zinc-200 text-base leading-6"
                selectable
              >
                {segment.content}
              </Text>
            );
        }
      })}
    </View>
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
