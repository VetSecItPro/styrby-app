/**
 * TextBlock — renders a text content block with markdown-style code parsing.
 *
 * Extracted from ChatMessage.tsx (Cluster A2 split). Parses the raw text for
 * fenced code blocks (rendered via {@link InlineCodeBlock}), inline code, and
 * regular prose.
 *
 * @module components/chat/TextBlock
 */

import { View, Text } from 'react-native';
import { useMemo } from 'react';
import { parseMessageContent, MONO_FONT_FAMILY } from './message-content';
import { InlineCodeBlock } from './CodeBlock';

/**
 * @param props - the raw text content to render.
 */
export function TextBlock({ content }: { content: string }) {
  // WHY memoize: message content is immutable once received, so we don't
  // re-parse on every render.
  const segments = useMemo(() => parseMessageContent(content), [content]);

  // Fast path: no code found → render as plain text (the common case).
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
            return <InlineCodeBlock key={index} content={segment.content} language={segment.language} />;
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
              <Text key={index} className="text-zinc-200 text-base leading-6" selectable>
                {segment.content}
              </Text>
            );
        }
      })}
    </View>
  );
}
