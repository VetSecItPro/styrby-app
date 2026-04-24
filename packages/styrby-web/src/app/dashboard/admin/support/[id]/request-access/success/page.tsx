'use client';

/**
 * Support Access Grant Success Page
 * `/dashboard/admin/support/[id]/request-access/success?grant=<id>`
 *
 * Purpose:
 *   Reads the one-time raw token from the `support_grant_token_once` cookie,
 *   displays it ONCE to the admin, then immediately deletes the cookie so the
 *   token cannot be retrieved again from this page on reload.
 *
 * Security model:
 *   - The raw token arrives via a server-set cookie (maxAge: 60, not HttpOnly)
 *     set during the requestSupportAccessAction redirect.
 *   - WHY not HttpOnly: the client JS on this page must read the cookie to
 *     display it and then delete it. HttpOnly cookies are inaccessible to JS.
 *   - The cookie is deleted immediately after the component first reads it.
 *     On a reload, the token will be gone and the page shows a "token already
 *     shown" fallback message.
 *   - The raw token is NEVER sent to the server from this page. It lives only
 *     in the component's local state after being read from the cookie once.
 *   - No sessionStorage or localStorage usage — cookie-only per spec.
 *
 * WHY "use client":
 *   - document.cookie access requires client-side execution.
 *   - useEffect for one-time cookie read + delete on mount.
 *   - copy-to-clipboard button requires client-side JS.
 *
 * @param params       - Next.js 15 async route params (id = ticket UUID).
 * @param searchParams - grant=<grantId> from the redirect URL.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, CheckCircle, Copy, Eye, EyeOff } from 'lucide-react';
import { useParams, useSearchParams } from 'next/navigation';

// ─── Cookie utilities ─────────────────────────────────────────────────────────

const COOKIE_NAME = 'support_grant_token_once';

/**
 * Reads the one-time token cookie value.
 *
 * WHY parse manually: document.cookie is a semicolon-separated string of
 * key=value pairs. We split and find the matching key rather than using a
 * library to keep this dependency-free in the client component.
 *
 * @returns The raw token string, or null if the cookie is absent.
 */
function readTokenCookie(): string | null {
  if (typeof document === 'undefined') return null;
  const pairs = document.cookie.split(';');
  for (const pair of pairs) {
    const [key, ...valueParts] = pair.trim().split('=');
    if (key === COOKIE_NAME) {
      return decodeURIComponent(valueParts.join('='));
    }
  }
  return null;
}

/**
 * Deletes the one-time token cookie by setting an expired date.
 *
 * WHY overwrite with past expiry: the browser removes cookies when their
 * expiry is in the past. We must match the path='/' used when setting.
 */
function deleteTokenCookie(): void {
  if (typeof document === 'undefined') return;
  document.cookie = `${COOKIE_NAME}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/`;
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Success page after a support access grant is created.
 *
 * Reads the raw token from the one-time cookie on mount, displays it, then
 * immediately deletes the cookie so it cannot be read again on reload.
 *
 * If the cookie is absent (page was reloaded, or token expired before arriving),
 * a fallback message is shown instead of the token.
 */
export default function RequestAccessSuccessPage() {
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const ticketId = params.id;
  const grantId = searchParams.get('grant');

  const [rawToken, setRawToken] = useState<string | null>(null);
  const [tokenRead, setTokenRead] = useState(false);
  const [copied, setCopied] = useState(false);
  const [revealed, setRevealed] = useState(false);

  // WHY useEffect for cookie read: runs client-side after hydration. We read
  // and immediately delete the cookie so a page reload cannot retrieve the
  // token a second time. The token value is held only in React local state
  // for the duration of this page visit.
  useEffect(() => {
    const token = readTokenCookie();
    setRawToken(token);
    setTokenRead(true);
    // Delete immediately after reading — cookie is consumed.
    deleteTokenCookie();
  }, []); // WHY empty deps: run exactly once on mount.

  /**
   * Copies the raw token to the clipboard.
   * Shows a brief "Copied!" confirmation for 2 seconds.
   */
  const handleCopy = async () => {
    if (!rawToken) return;
    try {
      await navigator.clipboard.writeText(rawToken);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API may be denied (e.g., insecure context) — fail silently.
    }
  };

  // Before the effect has run (SSR / hydration), show nothing.
  if (!tokenRead) {
    return null;
  }

  return (
    <div className="mx-auto max-w-2xl">
      {/* Back link */}
      <Link
        href={`/dashboard/admin/support/${ticketId}`}
        className="mb-6 inline-flex items-center gap-2 text-sm text-zinc-400 transition-colors hover:text-zinc-100"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to ticket
      </Link>

      {/* Header */}
      <div className="mb-6 flex items-start gap-3">
        <CheckCircle className="mt-0.5 h-6 w-6 shrink-0 text-green-400" />
        <div>
          <h1 className="text-xl font-bold text-zinc-100">Access grant created</h1>
          <p className="mt-1 text-sm text-zinc-400">
            The user will be notified and must approve before you can view session metadata.
          </p>
          {grantId && (
            <p className="mt-1 font-mono text-xs text-zinc-500">
              Grant ID: {grantId}
            </p>
          )}
        </div>
      </div>

      {/* Token display (one-time) */}
      <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-5">
        <p className="mb-1 text-xs font-medium uppercase tracking-wide text-amber-400">
          One-time token — copy it now
        </p>
        <p className="mb-4 text-xs text-zinc-400">
          This token is displayed once and cannot be recovered. Store it securely or
          share it with the user approval link. Reloading this page will not show it again.
        </p>

        {rawToken ? (
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
                {/* WHY conditional reveal: allow admin to hide token if someone
                    is looking at their screen. Default is revealed since the
                    admin immediately needs to copy it. */}
                {revealed
                  ? rawToken
                  : '•'.repeat(Math.min(rawToken.length, 43))}
              </code>
              <div className="flex shrink-0 gap-2">
                <button
                  onClick={() => setRevealed((v) => !v)}
                  className="rounded-lg p-1.5 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
                  aria-label={revealed ? 'Hide token' : 'Show token'}
                  data-testid="toggle-reveal-button"
                >
                  {revealed ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
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

            {/* User-facing approval link */}
            <div className="rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-3">
              <p className="mb-1 text-xs font-medium text-zinc-400">
                User approval link
              </p>
              <p className="break-all font-mono text-xs text-zinc-300" data-testid="approval-link">
                {typeof window !== 'undefined'
                  ? `${window.location.origin}/api/support-access/${grantId ?? ''}/approve?token=${rawToken}`
                  : `/api/support-access/${grantId ?? ''}/approve?token=${rawToken}`}
              </p>
              <p className="mt-1 text-xs text-zinc-500">
                Share this link with the user or include it in the support reply.
                It expires when the grant expires.
              </p>
            </div>
          </div>
        ) : (
          /* Fallback when cookie is gone (reload / expired) */
          <div
            className="rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-3 text-sm text-zinc-400"
            data-testid="token-gone-message"
          >
            Token is no longer available. It was displayed when the grant was first created.
            If you need to regenerate access, create a new grant from the ticket page.
          </div>
        )}
      </div>

      {/* Next steps */}
      <div className="mt-6 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        <h2 className="mb-2 text-sm font-semibold text-zinc-300">Next steps</h2>
        <ol className="list-inside list-decimal space-y-1.5 text-sm text-zinc-400">
          <li>Copy the token above and store it securely.</li>
          <li>
            Send the approval link to the user via the ticket reply form{' '}
            <Link
              href={`/dashboard/admin/support/${ticketId}`}
              className="text-amber-400 underline-offset-2 hover:underline"
            >
              back on the ticket
            </Link>
            .
          </li>
          <li>Once the user approves, the grant status changes to &quot;approved&quot;.</li>
          <li>
            Use the token at{' '}
            <span className="font-mono text-zinc-300">
              /dashboard/admin/support/session/[sessionId]?grant=...
            </span>{' '}
            to view session metadata (no message content).
          </li>
        </ol>
      </div>
    </div>
  );
}
