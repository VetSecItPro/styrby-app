'use client';

/**
 * Chat input component - allows users to send messages to the session.
 *
 * Provides a text input with send functionality, supporting both
 * button clicks and keyboard shortcuts (Enter to send, Shift+Enter for newline).
 */

import { useState, useRef, KeyboardEvent } from 'react';

/* ──────────────────────────── Types ──────────────────────────── */

/**
 * Props for the ChatInput component.
 */
interface ChatInputProps {
  /** Session ID for sending messages */
  sessionId: string;
}

/* ──────────────────────────── Icons ──────────────────────────── */

function SendIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"
      />
    </svg>
  );
}

function LoaderIcon({ className }: { className?: string }) {
  return (
    <svg
      className={`animate-spin ${className}`}
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
  );
}

/* ──────────────────────────── Component ──────────────────────── */

/**
 * Renders the chat input field with send button.
 *
 * WHY: The input supports multi-line messages with Shift+Enter.
 * Enter sends the message immediately for fast interaction.
 * The textarea auto-resizes based on content (up to a max height).
 *
 * @param props - ChatInput configuration
 */
export function ChatInput({ sessionId }: ChatInputProps) {
  const [message, setMessage] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  /**
   * Sends the current message to the session.
   * Clears the input and refocuses on success.
   */
  const sendMessage = async () => {
    const trimmedMessage = message.trim();
    if (!trimmedMessage || isSending) return;

    setIsSending(true);
    setError(null);

    try {
      const response = await fetch('/api/relay/send-message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          content: trimmedMessage,
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to send message');
      }

      setMessage('');

      // Reset textarea height and refocus
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
        textareaRef.current.focus();
      }
    } catch (err) {
      console.error('Failed to send message:', err);
      setError(err instanceof Error ? err.message : 'Failed to send message');
    } finally {
      setIsSending(false);
    }
  };

  /**
   * Handles keyboard events on the textarea.
   * Enter sends the message, Shift+Enter inserts a newline.
   */
  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  /**
   * Auto-resizes the textarea based on content.
   * Expands up to a maximum of 200px height.
   */
  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const textarea = e.target;
    setMessage(textarea.value);

    // Auto-resize
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
  };

  return (
    <div className="border-t border-zinc-800 bg-zinc-900/50 p-4">
      {/* Error message */}
      {error && (
        <div className="mb-3 text-sm text-red-400 flex items-center justify-between">
          <span>{error}</span>
          <button
            onClick={() => setError(null)}
            className="text-zinc-400 hover:text-zinc-200"
            aria-label="Dismiss error"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      <div className="flex gap-3">
        {/* Message input */}
        <textarea
          ref={textareaRef}
          value={message}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          placeholder="Type a message... (Enter to send, Shift+Enter for new line)"
          className="flex-1 resize-none rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-3 text-zinc-100 placeholder-zinc-500 focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500 disabled:opacity-50 min-h-[48px]"
          rows={1}
          disabled={isSending}
          aria-label="Message input"
        />

        {/* Send button */}
        <button
          onClick={sendMessage}
          disabled={!message.trim() || isSending}
          className="flex-shrink-0 rounded-lg bg-orange-600 p-3 text-white hover:bg-orange-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors focus:outline-none focus:ring-2 focus:ring-orange-500 focus:ring-offset-2 focus:ring-offset-zinc-900"
          aria-label={isSending ? 'Sending message...' : 'Send message'}
        >
          {isSending ? (
            <LoaderIcon className="h-5 w-5" />
          ) : (
            <SendIcon className="h-5 w-5" />
          )}
        </button>
      </div>

      {/* Keyboard shortcut hint */}
      <p className="mt-2 text-xs text-zinc-500">
        Press <kbd className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">Enter</kbd> to send,{' '}
        <kbd className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">Shift + Enter</kbd> for new line
      </p>
    </div>
  );
}
