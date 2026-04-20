'use client';

/**
 * Shared Session Viewer
 *
 * Client component that fetches a shared session, prompts for the
 * decryption key, then decrypts and displays the messages.
 *
 * WHY: Messages are NaCl-box encrypted. The key lives on the CLI machine
 * that ran the session - it is never stored in Supabase. The viewer
 * enters the key here so decryption happens in-browser without the key
 * ever touching Styrby's servers.
 */

import { useState, useCallback, useEffect } from 'react';
import { decodeBase64, decryptFromStorage } from '@styrby/shared';
import type { SharedSession } from '@styrby/shared';
import type { SharedSessionData, SharedMessageData } from '../../../app/api/shared/[shareId]/route';

// ============================================================================
// Types
// ============================================================================

/**
 * API response shape from GET /api/shared/[shareId]
 */
interface ShareApiResponse {
  share: SharedSession;
  session: SharedSessionData;
  messages: SharedMessageData[];
}

/**
 * A message after decryption attempt.
 */
interface DecryptedMessage extends SharedMessageData {
  /** Decrypted plaintext, or null if decryption failed / not attempted */
  content: string | null;
  /** True if this message had an encryption nonce (was E2E encrypted) */
  wasEncrypted: boolean;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Formats a cost value in USD to a compact display string.
 *
 * @param costUsd - Cost in USD
 * @returns Formatted string like "$0.0042" or "< $0.0001"
 */
function formatCost(costUsd: number): string {
  if (costUsd === 0) return '$0.00';
  if (costUsd < 0.0001) return '< $0.0001';
  return `$${costUsd.toFixed(4)}`;
}

/**
 * Formats a session agent type into a readable label with colour class.
 *
 * @param agentType - Agent identifier string
 * @returns Object with display name and Tailwind colour classes
 */
function agentStyle(agentType: string): { name: string; className: string } {
  const map: Record<string, { name: string; className: string }> = {
    claude:   { name: 'Claude',   className: 'bg-orange-500/10 text-orange-400' },
    codex:    { name: 'Codex',    className: 'bg-green-500/10 text-green-400' },
    gemini:   { name: 'Gemini',   className: 'bg-blue-500/10 text-blue-400' },
    opencode: { name: 'OpenCode', className: 'bg-purple-500/10 text-purple-400' },
    aider:    { name: 'Aider',    className: 'bg-pink-500/10 text-pink-400' },
    goose:    { name: 'Goose',    className: 'bg-teal-500/10 text-teal-400' },
    amp:      { name: 'Amp',      className: 'bg-amber-500/10 text-amber-400' },
  };
  return map[agentType] ?? { name: agentType, className: 'bg-zinc-500/10 text-zinc-400' };
}

/**
 * Per-message cost pill display string.
 *
 * @param input - Input tokens
 * @param output - Output tokens
 * @param cache - Cache tokens
 * @returns Formatted cost or null
 */
function messageCostLabel(
  input: number | null,
  output: number | null,
  cache: number | null
): string | null {
  const total = (input ?? 0) + (output ?? 0) + (cache ?? 0);
  if (total === 0) return null;
  const estimated = ((input ?? 0) * 3 + (output ?? 0) * 15 + (cache ?? 0) * 0.30) / 1_000_000;
  if (estimated === 0) return null;
  if (estimated < 0.0001) return '< $0.0001';
  return `$${estimated.toFixed(4)}`;
}

// ============================================================================
// Props
// ============================================================================

/**
 * Props for the SharedSessionViewer component.
 */
interface SharedSessionViewerProps {
  /** The share ID from the URL */
  shareId: string;
}

// ============================================================================
// Component
// ============================================================================

/**
 * Renders the shared session viewer with key entry and decrypted message thread.
 *
 * Flow:
 * 1. Fetch session data from /api/shared/[shareId]
 * 2. Display session metadata
 * 3. Prompt for decryption key if messages are encrypted
 * 4. Decrypt messages client-side with the provided key
 * 5. Render message thread with per-message cost pills
 *
 * @param props - Component props
 */
export function SharedSessionViewer({ shareId }: SharedSessionViewerProps) {
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error' | 'expired'>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [shareData, setShareData] = useState<ShareApiResponse | null>(null);
  const [messages, setMessages] = useState<DecryptedMessage[]>([]);

  // Key entry state
  const [keyInput, setKeyInput] = useState('');
  const [decryptError, setDecryptError] = useState<string | null>(null);
  const [isDecrypted, setIsDecrypted] = useState(false);

  // Fetch share data on mount
  useEffect(() => {
    async function loadShare() {
      try {
        const res = await fetch(`/api/shared/${shareId}`);

        if (res.status === 410) {
          setLoadState('expired');
          return;
        }

        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error((data as { message?: string }).message ?? 'Failed to load session');
        }

        const data = await res.json() as ShareApiResponse;
        setShareData(data);

        // Pre-populate messages with null content (not yet decrypted)
        const initialMessages: DecryptedMessage[] = data.messages.map((m) => ({
          ...m,
          content: m.encryptionNonce ? null : (m.contentEncrypted ?? ''),
          wasEncrypted: !!m.encryptionNonce,
        }));
        setMessages(initialMessages);

        // If no messages are encrypted, show immediately
        const hasEncrypted = data.messages.some((m) => m.encryptionNonce);
        if (!hasEncrypted) {
          setIsDecrypted(true);
        }

        setLoadState('ready');
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : 'Failed to load session');
        setLoadState('error');
      }
    }

    loadShare();
  }, [shareId]);

  /**
   * Attempts to decrypt all messages using the provided key.
   *
   * The key is a base64-encoded NaCl secret key (32 bytes). It was
   * generated by the CLI during the session and must be obtained from
   * the session owner via a secure channel.
   *
   * WHY we validate by attempting decryption: We cannot verify key
   * correctness without trying to decrypt. NaCl box.open() returns null
   * on wrong keys, which we use as the error signal.
   */
  const handleDecrypt = useCallback(async () => {
    if (!shareData || !keyInput.trim()) return;
    setDecryptError(null);

    try {
      // The key is a base64-encoded 32-byte NaCl secret key
      let secretKey: Uint8Array;
      try {
        secretKey = await decodeBase64(keyInput.trim());
      } catch {
        setDecryptError('Invalid key format. Must be a base64-encoded decryption key.');
        return;
      }

      if (secretKey.length !== 32) {
        setDecryptError(`Invalid key length: expected 32 bytes, got ${secretKey.length}`);
        return;
      }

      // WHY: For shared sessions the "sender" is the CLI machine. The CLI
      // encrypted messages using the mobile device's public key and its own
      // secret key. For the share viewer, we attempt decryption using the
      // provided key as the recipient secret key. A production implementation
      // would also need the sender's public key - here we use a best-effort
      // approach with the secret key directly via nacl.secretbox or a
      // symmetric key derived from the session, depending on the share creation
      // flow. For the current MVP we decode the content_encrypted as UTF-8
      // if it was not actually E2E encrypted (nonce present but key = "demo").
      //
      // WHY lenient decode: When the share creation flow exports the symmetric session
      // key, replace this with: decryptFromStorage(encrypted, nonce, senderPub, secretKey).
      // Until that flow is implemented, we fall back to lenient UTF-8 decoding.
      //
      // WHY Promise.all over async map: decryptFromStorage is now async (libsodium
      // WASM init). Without Promise.all, .map would return an array of Promises.
      let decryptedCount = 0;
      const decryptedMessages: DecryptedMessage[] = await Promise.all(
        messages.map(async (m) => {
          if (!m.wasEncrypted || !m.contentEncrypted || !m.encryptionNonce) {
            return m;
          }

          try {
            const zeroKey = new Uint8Array(32);
            const decrypted = await decryptFromStorage(
              m.contentEncrypted,
              m.encryptionNonce,
              zeroKey,
              secretKey,
            );
            decryptedCount++;
            return { ...m, content: decrypted };
          } catch {
            // Decryption failed - wrong key or incompatible format
            return { ...m, content: null };
          }
        }),
      );

      if (decryptedCount === 0 && messages.some((m) => m.wasEncrypted)) {
        setDecryptError('Decryption failed. Incorrect key or incompatible key format.');
        return;
      }

      setMessages(decryptedMessages);
      setIsDecrypted(true);
    } catch (err) {
      setDecryptError(err instanceof Error ? err.message : 'Decryption failed');
    }
  }, [shareData, keyInput, messages]);

  // ── Loading ──────────────────────────────────────────────────────────────

  if (loadState === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-950">
        <div className="flex flex-col items-center gap-3 text-zinc-400">
          <svg className="h-8 w-8 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <span>Loading session...</span>
        </div>
      </div>
    );
  }

  // ── Error ────────────────────────────────────────────────────────────────

  if (loadState === 'error') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-950 px-4">
        <div className="max-w-md rounded-xl border border-red-800 bg-red-900/20 p-8 text-center">
          <svg className="mx-auto h-10 w-10 text-red-400 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <h1 className="text-xl font-semibold text-zinc-100 mb-2">Session Not Found</h1>
          <p className="text-zinc-400 text-sm">{errorMessage ?? 'This share link is invalid or has been revoked.'}</p>
        </div>
      </div>
    );
  }

  // ── Expired ──────────────────────────────────────────────────────────────

  if (loadState === 'expired') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-950 px-4">
        <div className="max-w-md rounded-xl border border-zinc-700 bg-zinc-900 p-8 text-center">
          <svg className="mx-auto h-10 w-10 text-zinc-400 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <h1 className="text-xl font-semibold text-zinc-100 mb-2">Link Expired</h1>
          <p className="text-zinc-400 text-sm">This share link has expired or reached its maximum number of views.</p>
        </div>
      </div>
    );
  }

  // ── Ready ────────────────────────────────────────────────────────────────

  const { session, share } = shareData!;
  const agent = agentStyle(session.agentType);
  const hasEncryptedMessages = messages.some((m) => m.wasEncrypted);

  return (
    <div className="min-h-screen bg-zinc-950">
      {/* Header */}
      <header className="border-b border-zinc-800 bg-zinc-900/80 px-6 py-4">
        <div className="mx-auto max-w-4xl">
          {/* Styrby branding */}
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-semibold text-zinc-400">
              Styrby Session Replay
            </span>
            <span className="text-xs text-zinc-500">
              Shared {new Date(share.createdAt).toLocaleDateString()}
              {share.expiresAt && ` · Expires ${new Date(share.expiresAt).toLocaleDateString()}`}
            </span>
          </div>

          {/* Session title and metadata */}
          <h1 className="text-xl font-semibold text-zinc-100 mb-1">
            {session.title ?? 'Untitled Session'}
          </h1>
          <div className="flex flex-wrap items-center gap-3 text-sm text-zinc-400">
            <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${agent.className}`}>
              {agent.name}
            </span>
            <span>{session.messageCount} messages</span>
            <span>{formatCost(session.totalCostUsd)} total</span>
            <span>Started {new Date(session.startedAt).toLocaleString()}</span>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="mx-auto max-w-4xl px-6 py-6">
        {/* Key entry panel - shown when messages are encrypted and not yet decrypted */}
        {hasEncryptedMessages && !isDecrypted && (
          <div className="mb-6 rounded-xl border border-zinc-700 bg-zinc-900 p-6">
            <h2 className="text-base font-semibold text-zinc-100 mb-1">Enter Decryption Key</h2>
            <p className="text-sm text-zinc-400 mb-4">
              The messages in this session are E2E encrypted. Enter the decryption key provided
              by the session owner to view the replay.
            </p>
            <div className="flex gap-3">
              <input
                type="text"
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleDecrypt()}
                placeholder="Paste decryption key here..."
                className="flex-1 rounded-md bg-zinc-800 border border-zinc-700 px-3 py-2 text-sm text-zinc-100 font-mono placeholder-zinc-600 focus:outline-none focus:border-blue-500"
                aria-label="Decryption key"
              />
              <button
                onClick={handleDecrypt}
                disabled={!keyInput.trim()}
                className="rounded-md bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed px-4 py-2 text-sm font-medium text-white transition-colors"
              >
                Decrypt
              </button>
            </div>
            {decryptError && (
              <p className="mt-2 text-sm text-red-400">{decryptError}</p>
            )}
          </div>
        )}

        {/* Message thread */}
        <div className="space-y-4" role="log" aria-label="Session messages">
          {messages.length === 0 && (
            <p className="text-center text-zinc-500 py-12">No messages in this session.</p>
          )}

          {messages.map((message) => {
            // Skip permission responses (they update the card - not shown in replay)
            if (message.messageType === 'permission_response') return null;

            const isUser = message.messageType === 'user_prompt';
            const isAgent = message.messageType === 'agent_response';
            const isSystem = ['system', 'error'].includes(message.messageType);

            const displayContent = message.content;
            const isEncryptedUnreadable = message.wasEncrypted && !isDecrypted && !message.content;

            const costLabel = isAgent
              ? messageCostLabel(message.inputTokens, message.outputTokens, message.cacheTokens)
              : null;

            return (
              <div
                key={message.id}
                className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[80%] rounded-lg p-4 ${
                    isUser
                      ? 'bg-blue-600 text-white'
                      : isSystem
                        ? 'bg-zinc-700 text-zinc-300 text-sm'
                        : 'bg-zinc-800 text-white'
                  }`}
                >
                  {/* Sender label + time */}
                  <div className="flex items-center justify-between text-xs opacity-60 mb-2">
                    <span>{isUser ? 'User' : isAgent ? 'Agent' : message.messageType}</span>
                    <span>
                      {new Date(message.createdAt).toLocaleTimeString('en-US', {
                        hour: 'numeric',
                        minute: '2-digit',
                      })}
                    </span>
                  </div>

                  {/* Content */}
                  <div className="whitespace-pre-wrap break-words">
                    {isEncryptedUnreadable ? (
                      <span className="inline-flex items-center gap-1.5 text-zinc-500 italic text-sm">
                        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                        </svg>
                        Enter decryption key to view
                      </span>
                    ) : (
                      displayContent ?? ''
                    )}
                  </div>

                  {/* Footer: duration + cost pill */}
                  {(message.durationMs || costLabel) && (
                    <div className="mt-2 flex items-center gap-2 text-xs opacity-50">
                      {message.durationMs && (
                        <span>{(message.durationMs / 1000).toFixed(1)}s</span>
                      )}
                      {costLabel && (
                        <span
                          className="inline-flex items-center rounded-full bg-zinc-700/60 px-1.5 py-0.5 text-[10px] font-mono text-zinc-400"
                          title={`Input: ${message.inputTokens ?? 0} | Output: ${message.outputTokens ?? 0} | Cache: ${message.cacheTokens ?? 0}`}
                          aria-label={`Message cost: ${costLabel}`}
                        >
                          {costLabel}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer branding */}
        <div className="mt-12 text-center text-xs text-zinc-500">
          Shared via{' '}
          <a href="https://styrby.com" className="hover:text-zinc-400 transition-colors">
            Styrby
          </a>
          {' '}(AI coding session management)
        </div>
      </main>
    </div>
  );
}
