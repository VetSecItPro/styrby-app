'use client';

/**
 * Chat thread component - displays messages with real-time updates.
 *
 * Renders the message list for a session, handles real-time message
 * insertion via Supabase Realtime, and provides code block rendering
 * with copy functionality.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRealtimeSubscription } from '@/hooks/useRealtimeSubscription';
import { PermissionCard } from './permission-card';
import { cn } from '@/lib/utils';

/* ──────────────────────────── Types ──────────────────────────── */

/**
 * Represents a message in the session.
 * Maps to the session_messages table schema.
 */
interface Message {
  /** Unique message identifier */
  id: string;
  /** ID of the session this message belongs to */
  session_id: string;
  /** Message ordering within session */
  sequence_number: number;
  /** Type of message (determines rendering) */
  message_type:
    | 'user_prompt'
    | 'agent_response'
    | 'agent_thinking'
    | 'permission_request'
    | 'permission_response'
    | 'tool_use'
    | 'tool_result'
    | 'error'
    | 'system';
  /** Encrypted content (E2E encrypted for security) */
  content_encrypted: string | null;
  /** Risk level for permission requests */
  risk_level: 'low' | 'medium' | 'high' | null;
  /** Whether permission was granted */
  permission_granted: boolean | null;
  /** Tool name for tool_use messages */
  tool_name: string | null;
  /** Response duration in ms */
  duration_ms: number | null;
  /** Extensible metadata */
  metadata: Record<string, unknown> | null;
  /** ISO 8601 timestamp */
  created_at: string;
}

/**
 * Props for the ChatThread component.
 */
interface ChatThreadProps {
  /** The session ID for real-time subscription */
  sessionId: string;
  /** Current user's ID for ownership checks */
  userId: string;
  /** Initial messages fetched server-side */
  initialMessages: Message[];
  /** Whether the session is still active (affects permission cards) */
  isSessionActive: boolean;
}

/* ──────────────────────────── Icons ──────────────────────────── */

/**
 * Copy icon for code blocks.
 */
function CopyIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
      />
    </svg>
  );
}

/**
 * Check icon for copy confirmation.
 */
function CheckIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M5 13l4 4L19 7"
      />
    </svg>
  );
}

/* ──────────────────────────── Component ──────────────────────── */

/**
 * Renders the chat thread with real-time updates.
 *
 * WHY: We use a client component for real-time subscriptions.
 * Messages are stored encrypted but for the demo we display them directly.
 * In production, decryption would happen client-side with the user's key.
 *
 * @param props - ChatThread configuration
 */
export function ChatThread({
  sessionId,
  userId,
  initialMessages,
  isSessionActive,
}: ChatThreadProps) {
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  /**
   * Handles a new message from the real-time subscription.
   * Appends the message to the end of the list.
   */
  const handleNewMessage = useCallback((message: Message) => {
    setMessages((prev) => {
      // Avoid duplicates (can happen on reconnect)
      if (prev.some((m) => m.id === message.id)) {
        return prev;
      }
      return [...prev, message];
    });
  }, []);

  /**
   * Handles message updates (e.g., permission_granted changes).
   */
  const handleUpdateMessage = useCallback((message: Message) => {
    setMessages((prev) =>
      prev.map((m) => (m.id === message.id ? message : m))
    );
  }, []);

  // Subscribe to real-time message updates
  useRealtimeSubscription<Message>({
    table: 'session_messages',
    filter: `session_id=eq.${sessionId}`,
    onInsert: handleNewMessage,
    onUpdate: handleUpdateMessage,
  });

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  /**
   * Copies code to clipboard and shows confirmation.
   *
   * @param code - The code text to copy
   * @param messageId - Used to track which code block was copied
   */
  const copyCode = async (code: string, messageId: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedId(messageId);
      setTimeout(() => setCopiedId(null), 2000);
    } catch (err) {
      console.error('Failed to copy code:', err);
    }
  };

  /**
   * Renders message content with code block detection.
   * Extracts fenced code blocks and renders them with copy buttons.
   *
   * @param content - The message content text
   * @param messageId - For tracking copy state
   */
  const renderContent = (content: string, messageId: string) => {
    const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;
    const parts: React.ReactNode[] = [];
    let lastIndex = 0;
    let match;

    while ((match = codeBlockRegex.exec(content)) !== null) {
      // Add text before code block
      if (match.index > lastIndex) {
        parts.push(
          <span key={`text-${lastIndex}`}>
            {content.slice(lastIndex, match.index)}
          </span>
        );
      }

      // Add code block with copy button
      const language = match[1] || 'text';
      const code = match[2].trimEnd();
      const codeId = `${messageId}-${match.index}`;

      parts.push(
        <div
          key={`code-${match.index}`}
          className="relative my-2 rounded-lg bg-zinc-900 border border-zinc-700"
        >
          <div className="flex items-center justify-between px-4 py-2 text-xs text-zinc-400 border-b border-zinc-700">
            <span className="font-mono">{language}</span>
            <button
              onClick={() => copyCode(code, codeId)}
              className="flex items-center gap-1.5 hover:text-zinc-100 transition-colors"
              aria-label={copiedId === codeId ? 'Copied' : 'Copy code'}
            >
              {copiedId === codeId ? (
                <>
                  <CheckIcon className="h-3.5 w-3.5 text-green-500" />
                  <span className="text-green-500">Copied</span>
                </>
              ) : (
                <>
                  <CopyIcon className="h-3.5 w-3.5" />
                  <span>Copy</span>
                </>
              )}
            </button>
          </div>
          <pre className="overflow-x-auto p-4 text-sm">
            <code className="font-mono">{code}</code>
          </pre>
        </div>
      );

      lastIndex = match.index + match[0].length;
    }

    // Add remaining text after last code block
    if (lastIndex < content.length) {
      parts.push(
        <span key={`text-${lastIndex}`}>{content.slice(lastIndex)}</span>
      );
    }

    return parts.length > 0 ? parts : content;
  };

  /**
   * Returns styling classes based on message type.
   */
  const getMessageStyles = (messageType: Message['message_type']) => {
    switch (messageType) {
      case 'user_prompt':
        return 'ml-auto bg-blue-600 text-white';
      case 'agent_response':
        return 'bg-zinc-800 text-white';
      case 'agent_thinking':
        return 'bg-zinc-800/50 text-zinc-400 italic';
      case 'tool_use':
        return 'bg-purple-900/30 text-purple-200 border border-purple-800';
      case 'tool_result':
        return 'bg-zinc-800/50 text-zinc-300 border border-zinc-700';
      case 'error':
        return 'bg-red-900/30 text-red-200 border border-red-800';
      case 'system':
        return 'bg-zinc-700 text-zinc-300 text-sm';
      default:
        return 'bg-zinc-800 text-white';
    }
  };

  /**
   * Returns a display label for the message sender.
   */
  const getSenderLabel = (messageType: Message['message_type']) => {
    switch (messageType) {
      case 'user_prompt':
        return 'You';
      case 'agent_response':
      case 'agent_thinking':
        return 'Agent';
      case 'tool_use':
        return 'Tool';
      case 'tool_result':
        return 'Result';
      case 'error':
        return 'Error';
      case 'system':
        return 'System';
      default:
        return 'Agent';
    }
  };

  /**
   * Decrypts message content (placeholder for E2E encryption).
   * In production, this would use the user's private key.
   */
  const getMessageContent = (message: Message): string => {
    // WHY: For now we display encrypted content directly.
    // Real E2E decryption would happen here using TweetNaCl.
    return message.content_encrypted || '';
  };

  return (
    <div
      ref={scrollRef}
      className="flex-1 overflow-y-auto p-6 space-y-4"
      role="log"
      aria-label="Chat messages"
    >
      {messages.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-full text-zinc-500">
          <svg
            className="h-12 w-12 mb-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
            />
          </svg>
          <p className="text-lg font-medium">No messages yet</p>
          <p className="text-sm mt-1">
            Messages will appear here as the agent responds.
          </p>
        </div>
      ) : (
        messages.map((message) => {
          // Handle permission requests with special card
          if (message.message_type === 'permission_request') {
            return (
              <PermissionCard
                key={message.id}
                message={message}
                sessionId={sessionId}
                isActive={isSessionActive && message.permission_granted === null}
              />
            );
          }

          // Skip rendering permission responses (they update the permission card)
          if (message.message_type === 'permission_response') {
            return null;
          }

          const content = getMessageContent(message);

          return (
            <div
              key={message.id}
              className={cn(
                'max-w-[80%] rounded-lg p-4',
                getMessageStyles(message.message_type)
              )}
            >
              <div className="flex items-center justify-between text-xs opacity-60 mb-2">
                <span>{getSenderLabel(message.message_type)}</span>
                <span>
                  {new Date(message.created_at).toLocaleTimeString('en-US', {
                    hour: 'numeric',
                    minute: '2-digit',
                  })}
                </span>
              </div>

              {/* Tool name for tool_use messages */}
              {message.message_type === 'tool_use' && message.tool_name && (
                <div className="text-xs text-purple-300 font-mono mb-2">
                  {message.tool_name}
                </div>
              )}

              {/* Message content */}
              <div className="whitespace-pre-wrap break-words">
                {renderContent(content, message.id)}
              </div>

              {/* Duration for agent responses */}
              {message.duration_ms && (
                <div className="mt-2 text-xs opacity-50">
                  {(message.duration_ms / 1000).toFixed(1)}s
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
