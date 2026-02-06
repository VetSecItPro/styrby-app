'use client';

/**
 * Session Replay Player Component
 *
 * Displays messages appearing based on their original timestamps, allowing
 * users to "replay" a past session like watching a video. Features include:
 * - Messages appear with original timing
 * - Timeline scrubber showing session duration
 * - Current message highlighted
 * - Auto-scroll to current message
 */

import { useRef, useEffect, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { useReplayState } from './use-replay-state';
import { ReplayControls } from './controls';
import type { ReplayMessage, PlaybackSpeed } from './types';

/* ──────────────────────────── Types ──────────────────────────── */

/**
 * Props for the ReplayPlayer component.
 */
interface ReplayPlayerProps {
  /** The session ID for context */
  sessionId: string;
  /** All messages in the session, sorted by created_at */
  messages: ReplayMessage[];
  /** Callback when playback completes */
  onReplayComplete?: () => void;
  /** Callback when user exits replay mode */
  onExitReplay?: () => void;
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

/* ──────────────────────────── Sub-Components ──────────────────── */

/**
 * Renders a single message in the replay.
 */
function ReplayMessageItem({
  message,
  isCurrentMessage,
  isFutureMessage,
}: {
  message: ReplayMessage;
  isCurrentMessage: boolean;
  isFutureMessage: boolean;
}) {
  const content = message.content_encrypted || '';
  const [copiedId, setCopiedId] = React.useState<string | null>(null);

  /**
   * Copies code to clipboard and shows confirmation.
   */
  const copyCode = async (code: string, codeId: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedId(codeId);
      setTimeout(() => setCopiedId(null), 2000);
    } catch (err) {
      console.error('Failed to copy code:', err);
    }
  };

  /**
   * Renders message content with code block detection.
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
  const getMessageStyles = (messageType: ReplayMessage['message_type']) => {
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
  const getSenderLabel = (messageType: ReplayMessage['message_type']) => {
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

  // Skip rendering permission responses
  if (message.message_type === 'permission_response') {
    return null;
  }

  return (
    <div
      className={cn(
        'max-w-[80%] rounded-lg p-4 transition-all duration-300',
        getMessageStyles(message.message_type),
        isCurrentMessage && 'ring-2 ring-orange-500 ring-offset-2 ring-offset-zinc-950',
        isFutureMessage && 'opacity-30'
      )}
      data-message-id={message.id}
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
}

// Need React import for useState in the nested component
import React from 'react';

/* ──────────────────────────── Main Component ──────────────────── */

/**
 * Renders the session replay player with timeline controls.
 *
 * WHY: Session replay allows users to understand the flow of past sessions,
 * debug issues, and learn from successful patterns. The visual timeline
 * makes it easy to navigate to specific points in the session.
 *
 * @param props - ReplayPlayer configuration
 */
export function ReplayPlayer({
  sessionId: _sessionId,
  messages,
  onReplayComplete,
  onExitReplay,
}: ReplayPlayerProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const currentMessageRef = useRef<HTMLDivElement>(null);

  const {
    isPlaying,
    speed,
    currentTimeMs,
    totalDurationMs,
    currentMessageIndex,
    visibleMessages: _visibleMessages,
    togglePlay,
    setSpeed,
    seekToTime,
    jumpToMessage,
  } = useReplayState({
    messages,
    initialSpeed: 1,
    onComplete: onReplayComplete,
  });

  // WHY: visibleMessages is available from the hook but we calculate
  // visibility inline for more control over the opacity transition
  void _visibleMessages;

  /**
   * Auto-scroll to the current message when it changes.
   */
  useEffect(() => {
    if (currentMessageIndex >= 0 && scrollRef.current) {
      const messageElements = scrollRef.current.querySelectorAll(
        '[data-message-id]'
      );
      const currentElement = messageElements[currentMessageIndex];

      if (currentElement) {
        currentElement.scrollIntoView({
          behavior: 'smooth',
          block: 'center',
        });
      }
    }
  }, [currentMessageIndex]);

  /**
   * Handle speed change from controls.
   */
  const handleSpeedChange = useCallback(
    (newSpeed: PlaybackSpeed) => {
      setSpeed(newSpeed);
    },
    [setSpeed]
  );

  /**
   * Handle seek from controls.
   */
  const handleSeek = useCallback(
    (timeMs: number) => {
      seekToTime(timeMs);
    },
    [seekToTime]
  );

  /**
   * Handle jump to message from controls.
   */
  const handleJumpToMessage = useCallback(
    (index: number) => {
      jumpToMessage(index);
    },
    [jumpToMessage]
  );

  return (
    <div className="flex h-full flex-col">
      {/* Replay header */}
      <div className="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/50 px-4 py-2">
        <div className="flex items-center gap-2">
          <div className="flex h-6 w-6 items-center justify-center rounded-full bg-orange-500/20">
            <svg
              className="h-3.5 w-3.5 text-orange-500"
              fill="currentColor"
              viewBox="0 0 24 24"
            >
              <path d="M8 5v14l11-7z" />
            </svg>
          </div>
          <span className="text-sm font-medium text-zinc-300">Session Replay</span>
          <span className="text-xs text-zinc-500">
            {messages.length} messages
          </span>
        </div>

        {onExitReplay && (
          <button
            onClick={onExitReplay}
            className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition-colors"
            aria-label="Exit replay mode"
          >
            <svg
              className="h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
            Exit Replay
          </button>
        )}
      </div>

      {/* Message area with replay */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto p-6 space-y-4"
        role="log"
        aria-label="Session replay messages"
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
            <p className="text-lg font-medium">No messages to replay</p>
            <p className="text-sm mt-1">
              This session has no recorded messages.
            </p>
          </div>
        ) : (
          messages.map((message, index) => {
            const isVisible = index <= currentMessageIndex;
            const isCurrentMessage = index === currentMessageIndex;
            const isFutureMessage = index > currentMessageIndex;

            // Only render visible messages in replay mode (or all with reduced opacity)
            return (
              <div
                key={message.id}
                ref={isCurrentMessage ? currentMessageRef : undefined}
                className={cn(
                  'transition-opacity duration-300',
                  !isVisible && 'opacity-10'
                )}
              >
                <ReplayMessageItem
                  message={message}
                  isCurrentMessage={isCurrentMessage}
                  isFutureMessage={isFutureMessage}
                />
              </div>
            );
          })
        )}
      </div>

      {/* Replay controls */}
      <ReplayControls
        isPlaying={isPlaying}
        speed={speed}
        currentTimeMs={currentTimeMs}
        totalDurationMs={totalDurationMs}
        currentMessageIndex={currentMessageIndex}
        totalMessages={messages.length}
        onTogglePlay={togglePlay}
        onSpeedChange={handleSpeedChange}
        onSeek={handleSeek}
        onJumpToMessage={handleJumpToMessage}
      />
    </div>
  );
}
