'use client';

/**
 * TokenDisplay — interactive UI for the one-time support-grant token.
 *
 * Phase 4.2 — Support Tooling T4
 * Added 2026-04-25 — extracted from page.tsx as part of the SEC-ADV-001
 * server-component refactor.
 *
 * Why this is a client component:
 *   - Reveal-toggle (mask/unmask the token glyph) requires local state.
 *   - Copy-to-clipboard requires `navigator.clipboard.writeText`, which is
 *     browser-only.
 *
 * Why the parent (page.tsx) is a server component:
 *   - The raw token is fetched + DELETEd from the DB via a SECURITY DEFINER
 *     RPC during render. Client components cannot do that without exposing
 *     the token via a non-HttpOnly cookie or storage — exactly the SEC-ADV-001
 *     vector this PR closes.
 *
 * Token lifecycle in this component:
 *   The `rawToken` prop arrives via React's props mechanism — it lives in this
 *   component's local React tree and dies with the page. It is NOT persisted to
 *   localStorage, sessionStorage, IndexedDB, or any cookie. The clipboard write
 *   is initiated by an explicit user gesture (button click) and the OS-level
 *   clipboard is the user's responsibility from there.
 *
 * @param rawToken  Raw base64url support-grant token. Treat as a secret —
 *                  display only, never log, never persist.
 * @param ticketId  Support ticket UUID — used to build the user approval link.
 * @param grantId   Grant primary key (string) — used in the approval link.
 */

import { useState } from 'react';
import { Copy, Eye, EyeOff } from 'lucide-react';

interface TokenDisplayProps {
  rawToken: string;
  ticketId: string;
  grantId: string | null;
}

export function TokenDisplay({ rawToken, ticketId: _ticketId, grantId }: TokenDisplayProps) {
  // _ticketId is reserved — kept in the prop set so future additions (e.g. a
  // "back to ticket" inline link inside this subtree) don't require a parent
  // refactor. Currently rendered by the parent page only.
  void _ticketId;

  const [copied, setCopied] = useState(false);
  const [revealed, setRevealed] = useState(false);

  /**
   * Copies the raw token to the clipboard and shows a 2-second confirmation.
   *
   * WHY explicit user gesture: clipboard.writeText requires a recent user
   * activation in modern browsers; the click handler satisfies that.
   * WHY catch+silent: the Clipboard API may be unavailable (insecure context,
   * user denied permission). We silently swallow rather than crash the page.
   */
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(rawToken);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API may be denied (e.g., insecure context) — fail silently.
    }
  };

  /**
   * Copies the user-facing approval link (no token embedded) to the clipboard.
   *
   * WHY no token in URL:
   *   - The user is authenticated by their own session cookie. RLS on
   *     support_access_grants enforces ownership; embedding a token would
   *     extend the secret's reachability beyond the admin's browser.
   *   - GDPR Art. 7 forbids query-param auto-approval (consent must be an
   *     affirmative POST action by the user).
   */
  const handleCopyApprovalLink = async () => {
    if (!grantId) return;
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    try {
      await navigator.clipboard.writeText(`${origin}/support/access/${grantId}`);
    } catch {
      // Clipboard API may be denied — fail silently.
    }
  };

  return (
    <div className="space-y-3">
      {/* Token value display */}
      <div
        className="flex items-center gap-3 rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-3"
        data-testid="token-display-wrapper"
      >
        <code
          className="flex-1 break-all font-mono text-sm text-zinc-100"
          data-testid="token-value"
        >
          {/* WHY conditional reveal: allow admin to hide token if someone is
              looking at their screen. Default is hidden (•••) — a one-click
              reveal keeps shoulder-surfing visible to the admin. */}
          {revealed ? rawToken : '•'.repeat(Math.min(rawToken.length, 43))}
        </code>
        <div className="flex shrink-0 gap-2">
          <button
            onClick={() => setRevealed((v) => !v)}
            className="rounded-lg p-1.5 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
            aria-label={revealed ? 'Hide token' : 'Show token'}
            data-testid="toggle-reveal-button"
          >
            {revealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
          <button
            onClick={handleCopy}
            className="rounded-lg p-1.5 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
            aria-label="Copy token to clipboard"
            data-testid="copy-button"
          >
            <Copy className="h-4 w-4" />
          </button>
        </div>
      </div>

      {copied && (
        <p className="text-xs text-green-400" data-testid="copied-confirmation">
          Copied to clipboard.
        </p>
      )}

      {/* User-facing approval link (no token in URL) */}
      {grantId && (
        <div className="rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-3">
          <p className="mb-1 text-xs font-medium text-zinc-400">User approval link</p>
          <p
            className="break-all font-mono text-xs text-zinc-300"
            data-testid="approval-link"
          >
            {typeof window !== 'undefined'
              ? `${window.location.origin}/support/access/${grantId}`
              : `/support/access/${grantId}`}
          </p>
          <button
            type="button"
            onClick={handleCopyApprovalLink}
            className="mt-2 inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
            data-testid="copy-approval-link-button"
          >
            <Copy className="h-3 w-3" />
            Copy link
          </button>
          <p className="mt-1 text-xs text-zinc-500">
            Share this link with the user via the ticket reply form. The user must be
            signed in to approve - no token is embedded in the URL.
          </p>
        </div>
      )}
    </div>
  );
}
