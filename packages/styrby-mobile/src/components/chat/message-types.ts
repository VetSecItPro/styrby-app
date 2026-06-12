/**
 * Chat message domain types.
 *
 * Extracted from ChatMessage.tsx (Cluster A2 split) so the types can be
 * imported without pulling in the React component tree, and so the component
 * file stays under the 400-LOC ceiling.
 *
 * @module components/chat/message-types
 */

import type { AgentType } from 'styrby-shared';

/** Who authored a chat message. */
export type MessageRole = 'user' | 'assistant' | 'system' | 'error';

/** The kind of a single content block within a message. */
export type ContentBlockType = 'text' | 'code' | 'thinking';

/** One renderable block of a message (prose, a code block, or a thinking trace). */
export interface ContentBlock {
  type: ContentBlockType;
  content: string;
  /** Language identifier for code blocks. */
  language?: string;
}

/** A full chat message as rendered by {@link ChatMessage}. */
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
