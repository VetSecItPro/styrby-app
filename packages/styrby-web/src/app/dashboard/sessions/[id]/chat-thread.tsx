'use client';

/**
 * Chat thread component - displays messages with real-time updates.
 *
 * Renders the message list for a session, handles real-time message
 * insertion via Supabase Realtime, and provides code block rendering
 * with copy functionality.
 */

import { useState, useEffect, useRef, useCallback, memo } from 'react';
import { useRealtimeSubscription } from '@/hooks/useRealtimeSubscription';
import { PermissionCard } from './permission-card';
import { cn } from '@/lib/utils';
import { tryDecryptMessage, registerWebDevice, type DecryptResult } from '@/lib/encryption';

// WHY: Hoisted to module level to avoid re-allocating the RegExp object on every
// render call. Note: no `g` flag here — we use matchAll() instead, which
// creates a fresh stateful iterator per call (the `g` flag on a shared regex
// causes lastIndex bugs across concurrent calls).
const CODE_BLOCK_REGEX = /```(\w+)?\n([\s\S]*?)```/;

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
  /** Base64-encoded nonce used for encryption (null = plaintext) */
  encryption_nonce: string | null;
  /** Risk level for permission requests */
  risk_level: 'low' | 'medium' | 'high' | null;
  /** Whether permission was granted */
  permission_granted: boolean | null;
  /** Tool name for tool_use messages */
  tool_name: string | null;
  /** Response duration in ms */
  duration_ms: number | null;
  /**
   * Per-message cost granularity (Phase 7.9).
   * Input tokens consumed by this message exchange (user prompt + context).
   */
  input_tokens: number | null;
  /**
   * Output tokens generated in the agent response for this message.
   */
  output_tokens: number | null;
  /**
   * Cache tokens (read + write) associated with this message.
   * WHY: Cached tokens are billed at a significantly reduced rate — surfacing
   * this lets users see how much the prompt cache is saving them per message.
   */
  cache_tokens: number | null;
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
  /** CLI machine ID that created this session (for E2E key lookup) */
  machineId: string | null;
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

/* ──────────────────────── Pure Helpers ───────────────────────── */

/**
 * Returns styling classes based on message type.
 * Defined at module level so MessageRow does not capture a new reference
 * on every parent render.
 *
 * @param messageType - The message type to style
 * @returns Tailwind class string
 */
function getMessageStyles(messageType: Message['message_type']): string {
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
}

/**
 * Formats a message-level cost into a compact display string.
 *
 * Returns null if there is no cost data to show (zero tokens or missing data).
 *
 * WHY: We show "< $0.0001" instead of "$0.0000" for very small but non-zero
 * costs so users understand they were charged something. Showing "$0.0000"
 * would imply the message was free, which is misleading.
 *
 * @param inputTokens - Number of input tokens for this message
 * @param outputTokens - Number of output tokens for this message
 * @param cacheTokens - Number of cache tokens for this message
 * @returns Formatted cost string like "$0.0042" or "< $0.0001", or null if no data
 */
function formatMessageCost(
  inputTokens: number | null,
  outputTokens: number | null,
  cacheTokens: number | null
): string | null {
  const totalTokens = (inputTokens ?? 0) + (outputTokens ?? 0) + (cacheTokens ?? 0);
  if (totalTokens === 0) return null;

  // WHY: We use a simple linear estimate here for display purposes only.
  // The actual cost was calculated by the CLI with exact model pricing.
  // This estimate uses an average of ~$3/M input, $15/M output, $0.30/M cache
  // which covers the most common Claude Sonnet 4 pricing tier.
  const input = inputTokens ?? 0;
  const output = outputTokens ?? 0;
  const cache = cacheTokens ?? 0;
  const estimated = ((input * 3) + (output * 15) + (cache * 0.30)) / 1_000_000;

  if (estimated === 0) return null;
  if (estimated < 0.0001) return '< $0.0001';
  return `$${estimated.toFixed(4)}`;
}

/**
 * Returns a display label for the message sender.
 *
 * @param messageType - The message type
 * @returns Human-readable sender label
 */
function getSenderLabel(messageType: Message['message_type']): string {
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
}

/**
 * Returns plaintext for unencrypted messages (no nonce).
 * For encrypted messages, returns null — async decryption is handled
 * by the useDecryptedMessages hook in the ChatThread component.
 *
 * @param message - Message record
 * @returns Displayable content string, or null if encrypted
 */
function getMessageContentSync(message: Message): string | null {
  if (!message.encryption_nonce) {
    return message.content_encrypted || '';
  }
  return null;
}

/**
 * Renders message content with code block detection.
 * Extracts fenced code blocks and renders them with copy buttons.
 *
 * @param content - The message content text
 * @param messageId - For tracking copy state per code block
 * @param copiedId - The currently-copied code block ID (null if none)
 * @param onCopy - Stable callback to invoke when a copy button is clicked
 * @returns Rendered React nodes
 */
function renderContent(
  content: string,
  messageId: string,
  copiedId: string | null,
  onCopy: (code: string, codeId: string) => void
): React.ReactNode {
  // WHY: Use matchAll with a new RegExp (with `g` flag) derived from the module-level
  // pattern. matchAll requires the global flag and returns a fresh iterator, avoiding
  // lastIndex state bugs that occur when reusing a `g`-flagged regex across calls.
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;

  for (const match of content.matchAll(new RegExp(CODE_BLOCK_REGEX.source, 'g'))) {
    if (match.index! > lastIndex) {
      parts.push(
        <span key={`text-${lastIndex}`}>
          {content.slice(lastIndex, match.index)}
        </span>
      );
    }

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
            onClick={() => onCopy(code, codeId)}
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

    lastIndex = match.index! + match[0].length;
  }

  if (lastIndex < content.length) {
    parts.push(
      <span key={`text-${lastIndex}`}>{content.slice(lastIndex)}</span>
    );
  }

  return parts.length > 0 ? parts : content;
}

/* ─────────────────────────── MessageRow ──────────────────────── */

/**
 * Props for the memoized MessageRow component.
 */
interface MessageRowProps {
  /** The message to render */
  message: Message;
  /** Decrypted content (null if decryption failed or still loading) */
  decryptedContent: DecryptResult | null;
  /** Which code block ID is currently showing the "Copied" state */
  copiedId: string | null;
  /** Stable callback — parent must wrap in useCallback to preserve referential equality */
  onCopy: (code: string, codeId: string) => void;
}

/**
 * Renders a single non-permission message row.
 *
 * WHY: Wrapped in React.memo so that adding new messages to the end of the
 * list (the common case) does not re-render previously rendered rows.
 * Without memoization, every state update (e.g. copiedId change, new message)
 * triggers a full re-render of the entire message list — O(n) re-renders for
 * sessions with hundreds of messages (PERF-017).
 *
 * Props are kept stable: `message` is a value from the array (same reference
 * for unchanged rows), `copiedId` is a string|null (primitive comparison),
 * and `onCopy` must be wrapped in useCallback by the parent.
 */
const MessageRow = memo(function MessageRow({ message, decryptedContent, copiedId, onCopy }: MessageRowProps) {
  // Resolve content: use decrypted result, fall back to sync extraction
  const syncContent = getMessageContentSync(message);
  const content = syncContent ?? decryptedContent?.content ?? '';
  const isEncryptedAndUnreadable = !syncContent && decryptedContent?.wasEncrypted && !decryptedContent.content;

  return (
    <div
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
        {isEncryptedAndUnreadable ? (
          <span className="inline-flex items-center gap-1.5 text-zinc-500 italic">
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
            Encrypted — view on paired device
          </span>
        ) : (
          renderContent(content, message.id, copiedId, onCopy)
        )}
      </div>

      {/* Footer: duration + per-message cost pill (Phase 7.9) */}
      {(message.duration_ms || message.input_tokens || message.output_tokens) && (
        <div className="mt-2 flex items-center gap-2 text-xs opacity-50">
          {message.duration_ms && (
            <span>{(message.duration_ms / 1000).toFixed(1)}s</span>
          )}
          {/* Cost pill — only shown for agent responses with token data */}
          {message.message_type === 'agent_response' && (() => {
            const costStr = formatMessageCost(
              message.input_tokens,
              message.output_tokens,
              message.cache_tokens
            );
            return costStr ? (
              <span
                className="inline-flex items-center rounded-full bg-zinc-700/60 px-1.5 py-0.5 text-[10px] font-mono text-zinc-400"
                title={`Input: ${message.input_tokens ?? 0} | Output: ${message.output_tokens ?? 0} | Cache: ${message.cache_tokens ?? 0}`}
                aria-label={`Message cost: ${costStr}`}
              >
                {costStr}
              </span>
            ) : null;
          })()}
        </div>
      )}
    </div>
  );
});

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
  userId: _userId,
  initialMessages,
  isSessionActive,
  machineId,
}: ChatThreadProps) {
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  /**
   * Cached decryption results indexed by message ID.
   * WHY: Decryption is async (requires Supabase key lookup on first call).
   * We decrypt all messages on mount and cache results so MessageRow can
   * render synchronously from the cache.
   */
  const [decryptedCache, setDecryptedCache] = useState<Record<string, DecryptResult>>({});

  /**
   * Decrypt all encrypted messages on mount and when new messages arrive.
   * Also registers the web device's public key for future E2E support.
   */
  useEffect(() => {
    // Best-effort web device registration (non-blocking)
    registerWebDevice().catch(() => {});

    const decryptAll = async () => {
      const newCache: Record<string, DecryptResult> = {};
      let hasNew = false;

      for (const msg of messages) {
        // Skip if already cached
        if (decryptedCache[msg.id]) {
          newCache[msg.id] = decryptedCache[msg.id];
          continue;
        }

        // Only decrypt messages that have a nonce (actually encrypted)
        if (msg.encryption_nonce) {
          hasNew = true;
          const result = await tryDecryptMessage(
            msg.content_encrypted,
            msg.encryption_nonce,
            machineId
          );
          newCache[msg.id] = result;
        }
      }

      if (hasNew) {
        setDecryptedCache((prev) => ({ ...prev, ...newCache }));
      }
    };

    decryptAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, machineId]);

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
   * Wrapped in useCallback so the reference stays stable across renders —
   * this is the `onCopy` prop passed into the memoized MessageRow. Without
   * useCallback a new function reference would be created on every render,
   * defeating React.memo's shallow-equality check on MessageRow props.
   *
   * @param code - The code text to copy
   * @param codeId - Used to track which code block shows the "Copied" state
   */
  const copyCode = useCallback(async (code: string, codeId: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedId(codeId);
      setTimeout(() => setCopiedId(null), 2000);
    } catch (err) {
      console.error('Failed to copy code:', err);
    }
  }, []);

  return (
    <div
      ref={scrollRef}
      className="flex-1 overflow-y-auto p-6 space-y-4"
      role="log"
      aria-label="Chat messages"
      aria-live="polite"
      aria-relevant="additions"
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
                machineId={machineId}
              />
            );
          }

          // Skip rendering permission responses (they update the permission card)
          if (message.message_type === 'permission_response') {
            return null;
          }

          return (
            <MessageRow
              key={message.id}
              message={message}
              decryptedContent={decryptedCache[message.id] || null}
              copiedId={copiedId}
              onCopy={copyCode}
            />
          );
        })
      )}
    </div>
  );
}
