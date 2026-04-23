'use client';

/**
 * ReplayViewer — Read-only session replay for public /replay/[token] pages.
 *
 * WHY a separate component from ReplayPlayer (in session-replay/):
 *   ReplayPlayer is used in the authenticated dashboard where the user owns
 *   the session and can navigate freely. ReplayViewer is the public-facing
 *   view for unauthenticated viewers who received a share link. It:
 *     - Does not expose any controls that require auth (share, delete, etc.)
 *     - Shows a scrub-mask disclosure banner so viewers know what was redacted
 *     - Is accessible to screen readers with ARIA live regions for playback state
 *     - Has no Supabase client calls — all data comes in as props (server-rendered)
 *
 * Accessibility:
 *   - Keyboard controls: Space = play/pause, ArrowRight = next, ArrowLeft = prev
 *   - ARIA live region announces current message position during playback
 *   - Playback controls labeled for screen readers
 *   - Progress bar has role="progressbar" with aria-valuenow / aria-valuemax
 *
 * @module components/replay/ReplayViewer
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import type { ScrubbedMessage, ScrubMask, ReplaySessionMeta, PlaybackSpeed } from '@styrby/shared/session-replay';
import { cn } from '@/lib/utils';

// ============================================================================
// Types
// ============================================================================

/**
 * Props for the ReplayViewer component.
 */
export interface ReplayViewerProps {
  /** Session metadata shown in the viewer header. */
  session: ReplaySessionMeta;

  /** Scrubbed messages ready for rendering (scrubbed server-side). */
  messages: ScrubbedMessage[];

  /** The scrub mask applied server-side (shown in the disclosure banner). */
  scrubMask: ScrubMask;

  /** ISO 8601 timestamp when this replay token expires. */
  expiresAt: string;

  /** Number of views remaining (null = unlimited). */
  viewsRemaining: number | null;
}

// ============================================================================
// Playback speed options
// ============================================================================

const SPEED_OPTIONS: PlaybackSpeed[] = [1, 2, 4];

/**
 * Interval in milliseconds between messages at 1x speed.
 * Adjusted by the speed multiplier during playback.
 *
 * WHY 800ms: Fast enough to feel like "watching", slow enough to read each
 * message. The speed multiplier lets viewers tune this to their preference.
 */
const BASE_INTERVAL_MS = 800;

// ============================================================================
// Component
// ============================================================================

/**
 * Public session replay viewer with playback controls.
 *
 * Renders all messages immediately (they are already available from SSR),
 * then provides timeline scrubber + play/pause to step through them in order.
 *
 * @param props - ReplayViewerProps
 */
export function ReplayViewer({
  session,
  messages,
  scrubMask,
  expiresAt,
  viewsRemaining,
}: ReplayViewerProps) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState<PlaybackSpeed>(1);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const messageRefs = useRef<(HTMLDivElement | null)[]>([]);

  // ── Playback engine ──────────────────────────────────────────────────────
  const stopPlayback = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    setIsPlaying(false);
  }, []);

  const startPlayback = useCallback(() => {
    if (currentIndex >= messages.length - 1) {
      // At end — reset to beginning before playing
      setCurrentIndex(0);
    }
    setIsPlaying(true);
  }, [currentIndex, messages.length]);

  // WHY useEffect for the interval: We need to restart the interval whenever
  // speed or isPlaying changes. useEffect with the right deps handles cleanup.
  useEffect(() => {
    if (!isPlaying) return;

    intervalRef.current = setInterval(() => {
      setCurrentIndex((prev) => {
        if (prev >= messages.length - 1) {
          stopPlayback();
          return prev;
        }
        return prev + 1;
      });
    }, BASE_INTERVAL_MS / speed);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [isPlaying, speed, messages.length, stopPlayback]);

  // ── Scroll active message into view ─────────────────────────────────────
  useEffect(() => {
    messageRefs.current[currentIndex]?.scrollIntoView({
      behavior: 'smooth',
      block: 'nearest',
    });
  }, [currentIndex]);

  // ── Keyboard controls ────────────────────────────────────────────────────
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      // Only handle keys when no input is focused
      if (document.activeElement?.tagName === 'INPUT') return;

      switch (e.key) {
        case ' ':
          e.preventDefault();
          isPlaying ? stopPlayback() : startPlayback();
          break;
        case 'ArrowRight':
          e.preventDefault();
          setCurrentIndex((prev) => Math.min(prev + 1, messages.length - 1));
          stopPlayback();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          setCurrentIndex((prev) => Math.max(prev - 1, 0));
          stopPlayback();
          break;
      }
    }

    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [isPlaying, messages.length, startPlayback, stopPlayback]);

  // Cleanup on unmount
  useEffect(() => () => stopPlayback(), [stopPlayback]);

  const total = messages.length;
  const progress = total > 1 ? (currentIndex / (total - 1)) * 100 : 0;

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Header */}
      <header className="sticky top-0 z-10 border-b border-border bg-background/95 backdrop-blur-sm px-4 py-3">
        <div className="max-w-3xl mx-auto flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-0.5">
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Session Replay
              </span>
              <span className="text-xs text-muted-foreground">•</span>
              <span className="text-xs text-muted-foreground">{session.agentType}</span>
              {session.model && (
                <>
                  <span className="text-xs text-muted-foreground">•</span>
                  <span className="text-xs text-muted-foreground">{session.model}</span>
                </>
              )}
            </div>
            <h1 className="text-base font-semibold text-foreground truncate">
              {session.title ?? 'Untitled Session'}
            </h1>
          </div>
          <div className="text-right shrink-0">
            <p className="text-xs text-muted-foreground">
              {new Date(session.startedAt).toLocaleDateString()}
            </p>
            {viewsRemaining !== null && (
              <p className="text-xs text-amber-500">
                {viewsRemaining} view{viewsRemaining !== 1 ? 's' : ''} remaining
              </p>
            )}
          </div>
        </div>

        {/* Scrub mask disclosure banner */}
        {(scrubMask.secrets || scrubMask.file_paths || scrubMask.commands) && (
          <div
            className="max-w-3xl mx-auto mt-2 px-3 py-2 rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-xs text-amber-700 dark:text-amber-300"
            role="note"
            aria-label="Scrub mask disclosure"
          >
            <strong>Privacy filter active:</strong>{' '}
            {[
              scrubMask.secrets && 'secrets (API keys, tokens)',
              scrubMask.file_paths && 'file paths',
              scrubMask.commands && 'shell commands',
            ]
              .filter(Boolean)
              .join(', ')}{' '}
            have been redacted by the session owner.
          </div>
        )}
      </header>

      {/* Message list */}
      <main className="flex-1 max-w-3xl mx-auto w-full px-4 py-6" role="main">
        {/* ARIA live region for screen readers */}
        <div
          aria-live="polite"
          aria-atomic="true"
          className="sr-only"
        >
          {isPlaying
            ? `Playing — message ${currentIndex + 1} of ${total}`
            : `Paused at message ${currentIndex + 1} of ${total}`}
        </div>

        {messages.length === 0 ? (
          <p className="text-center text-muted-foreground text-sm mt-12">
            This session has no messages.
          </p>
        ) : (
          <div className="space-y-4">
            {messages.map((message, index) => (
              <div
                key={index}
                ref={(el) => { messageRefs.current[index] = el; }}
                className={cn(
                  'rounded-lg border px-4 py-3 text-sm transition-all duration-300',
                  index === currentIndex
                    ? 'border-primary/50 bg-primary/5 shadow-sm'
                    : index > currentIndex
                    ? 'border-border opacity-30'
                    : 'border-border opacity-80'
                )}
                aria-current={index === currentIndex ? 'true' : undefined}
              >
                <div className="flex items-center gap-2 mb-1.5">
                  <span
                    className={cn(
                      'text-xs font-medium capitalize',
                      message.role === 'user' ? 'text-blue-500' : 'text-green-600 dark:text-green-400'
                    )}
                  >
                    {message.role}
                  </span>
                  {message._scrubbed && (
                    <span className="text-xs text-amber-500" aria-label="Content was scrubbed">
                      [filtered]
                    </span>
                  )}
                </div>
                <pre className="whitespace-pre-wrap font-mono text-xs text-foreground/80 overflow-x-auto">
                  {message.content}
                </pre>
              </div>
            ))}
          </div>
        )}
      </main>

      {/* Playback controls — sticky footer */}
      {total > 0 && (
        <footer className="sticky bottom-0 border-t border-border bg-background/95 backdrop-blur-sm px-4 py-3">
          <div className="max-w-3xl mx-auto space-y-3">
            {/* Progress bar / scrubber */}
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted-foreground tabular-nums w-10 shrink-0">
                {currentIndex + 1}/{total}
              </span>
              <div className="relative flex-1 h-2 bg-muted rounded-full overflow-hidden">
                <div
                  role="progressbar"
                  aria-valuenow={currentIndex + 1}
                  aria-valuemin={1}
                  aria-valuemax={total}
                  aria-label="Replay progress"
                  className="absolute inset-y-0 left-0 bg-primary rounded-full transition-all duration-300"
                  style={{ width: `${progress}%` }}
                />
                {/* Clickable scrubber */}
                <input
                  type="range"
                  min={0}
                  max={total - 1}
                  value={currentIndex}
                  onChange={(e) => {
                    setCurrentIndex(Number(e.target.value));
                    stopPlayback();
                  }}
                  className="absolute inset-0 w-full opacity-0 cursor-pointer"
                  aria-label="Seek to position"
                />
              </div>
            </div>

            {/* Controls row */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {/* Previous */}
                <button
                  onClick={() => { setCurrentIndex((p) => Math.max(p - 1, 0)); stopPlayback(); }}
                  disabled={currentIndex === 0}
                  className="p-2 rounded-md hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  aria-label="Previous message"
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                  </svg>
                </button>

                {/* Play / Pause */}
                <button
                  onClick={isPlaying ? stopPlayback : startPlayback}
                  className="px-4 py-1.5 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
                  aria-label={isPlaying ? 'Pause replay' : 'Play replay'}
                  aria-pressed={isPlaying}
                >
                  {isPlaying ? 'Pause' : 'Play'}
                </button>

                {/* Next */}
                <button
                  onClick={() => { setCurrentIndex((p) => Math.min(p + 1, total - 1)); stopPlayback(); }}
                  disabled={currentIndex === total - 1}
                  className="p-2 rounded-md hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  aria-label="Next message"
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </button>
              </div>

              {/* Speed selector */}
              <div className="flex items-center gap-1" role="group" aria-label="Playback speed">
                <span className="text-xs text-muted-foreground mr-1">Speed:</span>
                {SPEED_OPTIONS.map((s) => (
                  <button
                    key={s}
                    onClick={() => setSpeed(s)}
                    className={cn(
                      'px-2 py-1 text-xs rounded-md transition-colors',
                      speed === s
                        ? 'bg-primary text-primary-foreground font-medium'
                        : 'hover:bg-muted text-muted-foreground'
                    )}
                    aria-pressed={speed === s}
                    aria-label={`${s}x speed`}
                  >
                    {s}x
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Expiry notice */}
          <p className="max-w-3xl mx-auto mt-2 text-center text-xs text-muted-foreground">
            This replay link expires {new Date(expiresAt).toLocaleString()}.
          </p>
        </footer>
      )}
    </div>
  );
}
