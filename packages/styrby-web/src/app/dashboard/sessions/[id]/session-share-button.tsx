'use client';

/**
 * Session Share Button
 *
 * Creates a shareable replay link for a session. The link grants access to
 * the encrypted message content - the viewer also needs the decryption key
 * to read the messages. Keys are displayed separately so users can share
 * them via a secure channel.
 *
 * WHY separate key: If the link and key were bundled together, a leaked URL
 * would expose the full session. Keeping them separate means a link can be
 * forwarded safely - only recipients who also receive the key can decrypt.
 */

import { useState, useCallback } from 'react';

/* ──────────────────────────────── Icons ──────────────────────────────── */

/**
 * Share icon (SVG).
 */
function ShareIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
    </svg>
  );
}

/**
 * Copy icon (SVG).
 */
function CopyIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
    </svg>
  );
}

/**
 * Check icon (SVG).
 */
function CheckIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
    </svg>
  );
}

/* ──────────────────────────────── Types ──────────────────────────────── */

/**
 * Props for the SessionShareButton component.
 */
interface SessionShareButtonProps {
  /** Supabase session ID to generate the share link for */
  sessionId: string;
  /**
   * The machine ID that owns this session, used to derive a hint about
   * where the decryption key lives (informational only in the UI).
   */
  machineId: string | null;
}

/**
 * State for a successfully created share.
 */
interface ShareState {
  /** Full share URL to send to the viewer */
  shareUrl: string;
  /** Share ID (last segment of the URL) */
  shareId: string;
}

/* ─────────────────────────────── Component ───────────────────────────── */

/**
 * Share button for a session detail page.
 *
 * On click, creates a share link via POST /api/sessions/[id]/share and
 * displays the result in a small modal with separate "Copy link" and
 * "Copy decryption key" actions.
 *
 * WHY modal instead of inline: The key disclosure message needs to be
 * prominent so users understand they must share it separately. A modal
 * forces them to acknowledge the warning before copying.
 *
 * @param props - Component props
 */
export function SessionShareButton({ sessionId, machineId }: SessionShareButtonProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [share, setShare] = useState<ShareState | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** Copy state: 'link' | 'key' | null */
  const [copiedItem, setCopiedItem] = useState<'link' | 'key' | null>(null);

  /**
   * Creates the share link by calling the API route.
   * Stores the result in state for display in the modal.
   */
  const handleCreateShare = useCallback(async () => {
    setIsCreating(true);
    setError(null);

    try {
      const response = await fetch(`/api/sessions/${sessionId}/share`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error((data as { message?: string }).message ?? 'Failed to create share link');
      }

      const data = await response.json() as { shareUrl: string; share: { shareId: string } };
      setShare({ shareUrl: data.shareUrl, shareId: data.share.shareId });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create share link');
    } finally {
      setIsCreating(false);
    }
  }, [sessionId]);

  /**
   * Opens the share modal and immediately creates the link.
   */
  const handleOpen = useCallback(() => {
    setIsOpen(true);
    setShare(null);
    setError(null);
    handleCreateShare();
  }, [handleCreateShare]);

  /**
   * Copies text to clipboard and sets the copied indicator.
   *
   * @param text - The text to copy
   * @param item - Which item was copied (for UI feedback)
   */
  const handleCopy = useCallback(async (text: string, item: 'link' | 'key') => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedItem(item);
      setTimeout(() => setCopiedItem(null), 2000);
    } catch {
      // Fallback for environments without clipboard API
      const textarea = document.createElement('textarea');
      textarea.value = text;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      setCopiedItem(item);
      setTimeout(() => setCopiedItem(null), 2000);
    }
  }, []);

  return (
    <>
      {/* Share trigger button */}
      <button
        onClick={handleOpen}
        className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 transition-colors"
        title="Share session replay"
        aria-label="Share session"
      >
        <ShareIcon className="h-4 w-4" />
        <span>Share</span>
      </button>

      {/* Modal overlay */}
      {isOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="share-modal-title"
          onClick={(e) => {
            if (e.target === e.currentTarget) setIsOpen(false);
          }}
        >
          <div className="w-full max-w-md rounded-xl border border-zinc-700 bg-zinc-900 p-6 shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <h2 id="share-modal-title" className="text-lg font-semibold text-zinc-100">
                Share Session Replay
              </h2>
              <button
                onClick={() => setIsOpen(false)}
                className="text-zinc-500 hover:text-zinc-300 transition-colors"
                aria-label="Close share dialog"
              >
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Loading state */}
            {isCreating && (
              <div className="flex items-center gap-3 text-zinc-400 py-4">
                <svg className="h-5 w-5 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                <span>Creating share link...</span>
              </div>
            )}

            {/* Error state */}
            {error && !isCreating && (
              <div className="rounded-lg bg-red-900/30 border border-red-800 p-3 text-sm text-red-300">
                {error}
              </div>
            )}

            {/* Success state */}
            {share && !isCreating && (
              <div className="space-y-4">
                {/* Encryption warning */}
                <div className="rounded-lg bg-amber-900/20 border border-amber-800/50 p-3">
                  <p className="text-sm text-amber-300 font-medium">Two items to share</p>
                  <p className="mt-1 text-xs text-amber-400/80">
                    Messages are E2E encrypted. Share the link AND the decryption key separately
                    The viewer needs both to read the replay.
                  </p>
                </div>

                {/* Share URL */}
                <div>
                  <label className="block text-xs font-medium text-zinc-400 mb-1.5">
                    Share Link
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      readOnly
                      value={share.shareUrl}
                      className="flex-1 rounded-md bg-zinc-800 border border-zinc-700 px-3 py-2 text-sm text-zinc-100 font-mono truncate focus:outline-none"
                      onClick={(e) => (e.target as HTMLInputElement).select()}
                    />
                    <button
                      onClick={() => handleCopy(share.shareUrl, 'link')}
                      className="flex-shrink-0 inline-flex items-center gap-1 rounded-md bg-zinc-700 hover:bg-zinc-600 px-3 py-2 text-sm text-zinc-100 transition-colors"
                      aria-label="Copy share link"
                    >
                      {copiedItem === 'link' ? (
                        <><CheckIcon className="h-4 w-4 text-green-400" /><span className="text-green-400">Copied</span></>
                      ) : (
                        <><CopyIcon className="h-4 w-4" /><span>Copy</span></>
                      )}
                    </button>
                  </div>
                </div>

                {/* Decryption key notice */}
                <div>
                  <label className="block text-xs font-medium text-zinc-400 mb-1.5">
                    Decryption Key
                  </label>
                  <div className="rounded-lg bg-zinc-800 border border-zinc-700 p-3">
                    <p className="text-xs text-zinc-400">
                      The decryption key is stored on the CLI machine that ran this session
                      {machineId ? ` (machine ${machineId.slice(0, 8)}...)` : ''}.
                      Ask the session owner to share the key via a secure channel (Signal, 1Password, etc.).
                    </p>
                    <p className="mt-2 text-xs text-zinc-500">
                      The key is never stored in Styrby. This ensures your session content
                      is private even from Styrby servers.
                    </p>
                  </div>
                </div>

                {/* Done button */}
                <button
                  onClick={() => setIsOpen(false)}
                  className="w-full rounded-md bg-blue-600 hover:bg-blue-500 px-4 py-2 text-sm font-medium text-white transition-colors"
                >
                  Done
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
