'use client';

/**
 * CreateReplayLinkModal — "Share this session" modal for the web dashboard.
 *
 * Lets session owners configure a replay token and copy the resulting URL.
 *
 * UX flow:
 *   1. User clicks "Share this session" on the session detail page
 *   2. Modal opens with sensible defaults (24h, 10 views, secrets scrubbed)
 *   3. User customises duration / max views / scrub mask
 *   4. User clicks "Generate link" — POST to /api/sessions/[id]/replay
 *   5. URL appears with a one-click copy button
 *   6. Modal can be dismissed; the link stays in the session's "Active links" list
 *
 * Security note:
 *   The raw token URL is shown ONCE in this modal. It is not stored in
 *   localStorage or any client-side state. If the user closes the modal
 *   without copying, they need to create a new token.
 *
 * @module components/replay/CreateReplayLinkModal
 */

import { useState } from 'react';
import type {
  ReplayTokenDuration,
  ReplayTokenMaxViews,
  ScrubMask,
  CreateReplayTokenResponse,
} from '@styrby/shared/session-replay';

// ============================================================================
// Types
// ============================================================================

/**
 * Props for the CreateReplayLinkModal component.
 */
export interface CreateReplayLinkModalProps {
  /** Session ID to generate the replay link for. */
  sessionId: string;

  /** Whether the modal is currently visible. */
  open: boolean;

  /** Called when the user dismisses the modal. */
  onClose: () => void;
}

// ============================================================================
// Option labels
// ============================================================================

const DURATION_LABELS: Record<ReplayTokenDuration, string> = {
  '1h':  '1 hour',
  '24h': '24 hours',
  '7d':  '7 days',
  '30d': '30 days',
};

const MAX_VIEWS_LABELS: Record<string, string> = {
  '1':         '1 view',
  '5':         '5 views',
  '10':        '10 views',
  'unlimited': 'Unlimited',
};

// ============================================================================
// Component
// ============================================================================

/**
 * Modal for generating a privacy-preserving session replay link.
 *
 * @param props - CreateReplayLinkModalProps
 */
export function CreateReplayLinkModal({ sessionId, open, onClose }: CreateReplayLinkModalProps) {
  // ── Form state ────────────────────────────────────────────────────────────
  const [duration, setDuration] = useState<ReplayTokenDuration>('24h');
  const [maxViews, setMaxViews] = useState<ReplayTokenMaxViews>(10);
  const [scrubMask, setScrubMask] = useState<ScrubMask>({
    secrets:    true,  // ON by default — leaking API keys via replay links is high-severity
    file_paths: false,
    commands:   false,
  });

  // ── UI state ──────────────────────────────────────────────────────────────
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generatedUrl, setGeneratedUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  if (!open) return null;

  // ── Submit ────────────────────────────────────────────────────────────────
  async function handleGenerate() {
    setLoading(true);
    setError(null);
    setGeneratedUrl(null);

    try {
      const res = await fetch(`/api/sessions/${sessionId}/replay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ duration, maxViews, scrubMask }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.message ?? `Error ${res.status}`);
        return;
      }

      const data: CreateReplayTokenResponse = await res.json();
      setGeneratedUrl(data.url);
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  // ── Copy to clipboard ─────────────────────────────────────────────────────
  async function handleCopy() {
    if (!generatedUrl) return;
    try {
      await navigator.clipboard.writeText(generatedUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Could not copy to clipboard. Please copy the URL manually.');
    }
  }

  // ── Reset form when re-opening ────────────────────────────────────────────
  function handleClose() {
    setGeneratedUrl(null);
    setError(null);
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="replay-modal-title"
    >
      <div className="relative w-full max-w-md bg-background border border-border rounded-xl shadow-xl p-6 mx-4">
        {/* Close button */}
        <button
          onClick={handleClose}
          className="absolute top-4 right-4 text-muted-foreground hover:text-foreground transition-colors"
          aria-label="Close modal"
        >
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>

        <h2 id="replay-modal-title" className="text-lg font-semibold text-foreground mb-1">
          Share this session
        </h2>
        <p className="text-sm text-muted-foreground mb-5">
          Generate a link that lets anyone view a replay of this session.
          The link is read-only and cannot modify anything.
        </p>

        {!generatedUrl ? (
          <>
            {/* Duration */}
            <fieldset className="mb-4">
              <legend className="text-sm font-medium text-foreground mb-2">Expires after</legend>
              <div className="flex flex-wrap gap-2">
                {(Object.keys(DURATION_LABELS) as ReplayTokenDuration[]).map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setDuration(d)}
                    className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${
                      duration === d
                        ? 'border-primary bg-primary/10 text-primary font-medium'
                        : 'border-border hover:bg-muted text-muted-foreground'
                    }`}
                    aria-pressed={duration === d}
                  >
                    {DURATION_LABELS[d]}
                  </button>
                ))}
              </div>
            </fieldset>

            {/* Max views */}
            <fieldset className="mb-4">
              <legend className="text-sm font-medium text-foreground mb-2">Max views</legend>
              <div className="flex flex-wrap gap-2">
                {([1, 5, 10, 'unlimited'] as ReplayTokenMaxViews[]).map((v) => (
                  <button
                    key={String(v)}
                    type="button"
                    onClick={() => setMaxViews(v)}
                    className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${
                      maxViews === v
                        ? 'border-primary bg-primary/10 text-primary font-medium'
                        : 'border-border hover:bg-muted text-muted-foreground'
                    }`}
                    aria-pressed={maxViews === v}
                  >
                    {MAX_VIEWS_LABELS[String(v)]}
                  </button>
                ))}
              </div>
            </fieldset>

            {/* Scrub mask */}
            <fieldset className="mb-6">
              <legend className="text-sm font-medium text-foreground mb-1">
                Privacy filter
              </legend>
              <p className="text-xs text-muted-foreground mb-2">
                Redact sensitive content before it reaches the viewer.
              </p>
              <div className="space-y-2">
                {(
                  [
                    { key: 'secrets' as const,    label: 'Secrets',      description: 'API keys, tokens, private keys, JWTs' },
                    { key: 'file_paths' as const, label: 'File paths',   description: 'Absolute paths (basenames preserved)' },
                    { key: 'commands' as const,   label: 'Shell commands', description: 'Terminal commands ($ prompts preserved)' },
                  ] as const
                ).map(({ key, label, description }) => (
                  <label
                    key={key}
                    className="flex items-start gap-3 cursor-pointer group"
                  >
                    <input
                      type="checkbox"
                      checked={scrubMask[key]}
                      onChange={(e) =>
                        setScrubMask((prev) => ({ ...prev, [key]: e.target.checked }))
                      }
                      className="mt-0.5 h-4 w-4 rounded border-border accent-primary"
                      aria-label={`${label}: ${description}`}
                    />
                    <div>
                      <span className="text-sm font-medium text-foreground group-hover:text-primary transition-colors">
                        {label}
                      </span>
                      <p className="text-xs text-muted-foreground">{description}</p>
                    </div>
                  </label>
                ))}
              </div>
            </fieldset>

            {error && (
              <p className="text-sm text-destructive mb-3" role="alert">
                {error}
              </p>
            )}

            <button
              onClick={handleGenerate}
              disabled={loading}
              className="w-full py-2.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? 'Generating...' : 'Generate link'}
            </button>
          </>
        ) : (
          /* Generated URL state */
          <div>
            <p className="text-sm text-muted-foreground mb-3">
              Your replay link is ready. Copy it and share with your viewer.
              This URL will not be shown again.
            </p>

            <div className="flex items-center gap-2 p-3 rounded-lg bg-muted border border-border mb-4">
              <p
                className="flex-1 text-xs font-mono text-foreground truncate"
                title={generatedUrl}
              >
                {generatedUrl}
              </p>
              <button
                onClick={handleCopy}
                className="shrink-0 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors"
                aria-label="Copy replay link to clipboard"
              >
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </div>

            <button
              onClick={handleClose}
              className="w-full py-2 rounded-lg border border-border text-sm text-muted-foreground hover:bg-muted transition-colors"
            >
              Done
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
