/**
 * Code block renderers for chat messages.
 *
 * Extracted from ChatMessage.tsx (Cluster A2 split):
 * - {@link CodeBlock} renders a structured `type: 'code'` content block.
 * - {@link InlineCodeBlock} renders a fenced code block found inside prose
 *   (via the markdown parser), with horizontal scroll for long lines.
 *
 * Both share the copy-with-timed-clear behavior via {@link useCopyWithClear}.
 *
 * @module components/chat/CodeBlock
 */

import { View, Text, Pressable, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { MONO_FONT_FAMILY } from './message-content';
import { useCopyWithClear } from './useCopyWithClear';

/**
 * Renders a structured code content block (dark container, language label,
 * copy button).
 *
 * @param props - code content + optional language identifier.
 */
export function CodeBlock({ content, language }: { content: string; language?: string }) {
  const { copied, handleCopy } = useCopyWithClear(content);

  return (
    <View className="bg-zinc-900 rounded-lg overflow-hidden my-2">
      {/* Header */}
      <View className="flex-row items-center justify-between px-3 py-2 bg-zinc-800/50 border-b border-zinc-700">
        <Text className="text-zinc-400 text-xs font-mono">{language || 'code'}</Text>
        <Pressable
          onPress={handleCopy}
          className="flex-row items-center"
          accessibilityRole="button"
          accessibilityLabel={`Copy ${language || 'code'} block`}
        >
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

/**
 * Renders a fenced code block found inside a text segment: dark container with
 * language label, horizontal scrolling, and a copy button.
 *
 * @param props - code content + optional language identifier.
 */
export function InlineCodeBlock({ content: codeContent, language }: { content: string; language?: string }) {
  const { copied, handleCopy } = useCopyWithClear(codeContent);

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
          <Text className="text-zinc-400 text-xs ml-1">{copied ? 'Copied!' : 'Copy'}</Text>
        </Pressable>
      </View>
      {/* Code content with horizontal scroll for long lines */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View className="p-3">
          <Text className="text-sm text-green-400" style={{ fontFamily: MONO_FONT_FAMILY }} selectable>
            {codeContent}
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}
