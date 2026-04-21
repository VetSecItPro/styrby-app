/**
 * Chat sub-component barrel.
 *
 * Re-exports the orchestrator-facing components and helpers for the chat
 * screen. The orchestrator (`app/(tabs)/chat.tsx`) imports from here so
 * the surface stays small and refactor-friendly.
 */

export { ChatAgentPicker } from './ChatAgentPicker';
export type { ChatAgentPickerProps } from './ChatAgentPicker';

export { ChatEmptyState } from './ChatEmptyState';
export type { ChatEmptyStateProps } from './ChatEmptyState';

export { ChatMessageList } from './ChatMessageList';
export type { ChatMessageListProps } from './ChatMessageList';

export { ChatInputBar } from './ChatInputBar';
export type { ChatInputBarProps } from './ChatInputBar';

// WHY this list is the *minimum* the orchestrator needs:
// - AGENT_CONFIG / SELECTABLE_AGENTS: rendered in the agent picker.
// - chatLogger: orchestrator emits its own dev logs through it.
// DECRYPTION_FAILED_PLACEHOLDER is intentionally NOT re-exported — it's
// an implementation detail of chat-session.ts and useRelayMessageHandler;
// orchestrator never reads it.
export { AGENT_CONFIG, SELECTABLE_AGENTS, chatLogger } from './agent-config';

export {
  loadActiveSession,
  loadMessagesForSession,
  createSession,
  saveMessageToDb,
} from './chat-session';
export type {
  LoadActiveSessionResult,
  SaveMessageTokenData,
} from './chat-session';

export { useRelayMessageHandler } from './hooks/useRelayMessageHandler';
export type { RelayMessageHandlerDeps } from './hooks/useRelayMessageHandler';

export { useChatSend } from './hooks/useChatSend';
export type { UseChatSendDeps } from './hooks/useChatSend';
