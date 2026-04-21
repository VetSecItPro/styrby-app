/**
 * ChatMessageList
 *
 * Renders the merged chronological stream of chat messages and pending
 * permission requests, plus the in-flow typing indicator.
 *
 * WHY a dedicated component: The orchestrator owns *what* to display
 * (state + sorting). This component owns *how* (FlatList config, footer,
 * item dispatch). Splitting them keeps both files small and lets the
 * list be re-used or restyled without touching session logic.
 */

import { forwardRef } from 'react';
import { View, FlatList } from 'react-native';
import type { AgentType } from 'styrby-shared';
import { ChatMessage } from '../ChatMessage';
import { PermissionCard } from '../PermissionCard';
import { TypingIndicatorInline, type AgentState } from '../TypingIndicator';
import type { ChatItem } from '../../types/chat';

/**
 * Props for {@link ChatMessageList}.
 */
export interface ChatMessageListProps {
  /** Sorted message + permission stream */
  items: ChatItem[];
  /** Whether the agent is generating (controls footer typing indicator) */
  isAgentThinking: boolean;
  /** Currently active agent (drives indicator color) */
  activeAgent: AgentType;
  /** Current agent state (drives indicator label/animation) */
  agentState: AgentState;
  /** Approve callback for inline permission cards */
  onApprovePermission: (id: string) => void;
  /** Deny callback for inline permission cards */
  onDenyPermission: (id: string) => void;
}

/**
 * Renders the FlatList of chat items with a typing-indicator footer.
 * Forwards a ref to the underlying FlatList so the orchestrator can
 * imperatively scroll to bottom when new content arrives.
 *
 * @returns React element wrapping the FlatList
 */
export const ChatMessageList = forwardRef<FlatList, ChatMessageListProps>(
  function ChatMessageList(
    { items, isAgentThinking, activeAgent, agentState, onApprovePermission, onDenyPermission },
    ref,
  ) {
    return (
      <FlatList
        ref={ref}
        data={items}
        keyExtractor={(item) => item.data.id}
        renderItem={({ item }) => {
          if (item.type === 'message') {
            return <ChatMessage message={item.data} />;
          }
          return (
            <PermissionCard
              permission={item.data}
              onApprove={onApprovePermission}
              onDeny={onDenyPermission}
            />
          );
        }}
        contentContainerStyle={{ paddingVertical: 8 }}
        showsVerticalScrollIndicator={false}
        ListFooterComponent={
          /* WHY: The typing indicator renders as a FlatList footer so it
           * always sits below all messages and scrolls naturally with the list. */
          isAgentThinking ? (
            <View className="px-4 pb-2">
              <TypingIndicatorInline
                agentType={activeAgent}
                state={agentState}
              />
            </View>
          ) : null
        }
      />
    );
  },
);
