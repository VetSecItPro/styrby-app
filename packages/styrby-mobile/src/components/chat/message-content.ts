/**
 * Markdown-ish content parsing for chat messages.
 *
 * Pure logic extracted from ChatMessage.tsx (Cluster A2 split). Splitting raw
 * message text into renderable segments has no React dependency, so it lives
 * here where it can be unit-tested directly and reused.
 *
 * @module components/chat/message-content
 */

import { Platform } from 'react-native';

/** What a {@link ParsedSegment} represents. */
export type ParsedSegmentType = 'text' | 'code_block' | 'inline_code';

/**
 * A parsed segment of message content. The parser splits raw text into these
 * so each can be rendered with the appropriate component.
 */
export interface ParsedSegment {
  /** What kind of content this segment represents. */
  type: ParsedSegmentType;
  /** The text content of the segment (code or prose). */
  content: string;
  /** Language identifier for code blocks (e.g. "typescript"). */
  language?: string;
}

/**
 * Monospace font family selected per platform.
 * WHY: iOS and Android ship different built-in monospace fonts. Platform.select
 * avoids a runtime lookup and keeps the bundle free of custom font files.
 */
export const MONO_FONT_FAMILY = Platform.select({
  ios: 'Menlo',
  android: 'monospace',
  default: 'monospace',
});

/**
 * Parses message content into segments of text, code blocks, and inline code.
 *
 * Handles: fenced code blocks (triple backtick + optional language), inline
 * code (single backtick), regular text, and edge cases (empty code blocks,
 * unclosed fences, nested backticks).
 *
 * @param content - Raw message content string.
 * @returns Array of parsed segments for rendering.
 *
 * @example
 * parseMessageContent("Hello `world`")
 * // => [{ type: 'text', content: 'Hello ' }, { type: 'inline_code', content: 'world' }]
 */
export function parseMessageContent(content: string): ParsedSegment[] {
  const segments: ParsedSegment[] = [];
  if (!content) return segments;

  // WHY two-pass: first extract fenced code blocks, then parse the remaining
  // text for inline code. This prevents backticks inside fenced blocks from
  // being treated as inline-code delimiters.
  //
  // KNOWN LIMITATION: nested code fences (``` inside ```) are not supported by
  // this regex-based parser — extremely rare in AI output and not worth a full
  // CommonMark parser here.
  const codeBlockRegex = /```(\w*)\n?([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = codeBlockRegex.exec(content)) !== null) {
    // Text before this code block.
    if (match.index > lastIndex) {
      const textBefore = content.slice(lastIndex, match.index);
      segments.push(...parseInlineCode(textBefore));
    }

    // The fenced code block itself.
    const language = match[1] || undefined;
    const codeContent = match[2];
    // WHY: only add the segment if there's actual content. Empty fences render
    // as nothing useful.
    if (codeContent.trim()) {
      segments.push({ type: 'code_block', content: codeContent, language });
    }

    lastIndex = match.index + match[0].length;
  }

  // Remaining text after the last code block (or all text if no blocks found).
  if (lastIndex < content.length) {
    const remaining = content.slice(lastIndex);
    segments.push(...parseInlineCode(remaining));
  }

  return segments;
}

/**
 * Parses a text string (with no fenced code blocks) for inline code segments.
 *
 * @param text - Text that does not contain fenced code blocks.
 * @returns Array of text and inline_code segments.
 */
export function parseInlineCode(text: string): ParsedSegment[] {
  const segments: ParsedSegment[] = [];
  // WHY: non-greedy match between single backticks; require non-backtick after
  // the opening so we don't match double/triple backticks.
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
