'use client';

/**
 * Handoff Banner — Web
 *
 * Dismissible banner shown when a user opens an existing session on a
 * different browser/device from the one that last wrote a snapshot within
 * the past 5 minutes.
 *
 * WHY: The banner is the entry point for the "pick up where you left off"
 * UX. Rather than silently restoring state (surprising), or ignoring the
 * snapshot (wasteful), we surface a clear choice: resume at the exact
 * position the user was at, or start a fresh view.
 *
 * Accessibility: The banner uses `role="alert"` so screen readers announce
 * it immediately on mount. The dismiss button has a clear aria-label.
 *
 * @module components/session-handoff/HandoffBanner
 */

import { useState, useCallback } from 'react';
import type { HandoffResponse } from '@styrby/shared/session-handoff';

// ============================================================================
// Types
// ============================================================================

/**
 * Callbacks for the two user actions in the banner.
 */
export interface HandoffBannerProps {
  /**
   * The non-`available: false` handoff response that triggered the banner.
   * Guaranteed to have `available: true` at the call site.
   */
  handoff: Extract<HandoffResponse, { available: true }>;

  /**
   * Called when the user clicks "Resume" — caller should restore cursor,
   * scroll, and draft state from the handoff data.
   */
  onResume: (handoff: Extract<HandoffResponse, { available: true }>) => void;

  /**
   * Called when the user clicks "Start fresh" or the dismiss X.
   * Caller dismisses the banner and takes over with a new snapshot stream.
   */
  onDismiss: () => void;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Formats a device kind into a human-readable label.
 *
 * @param kind - Device kind from the handoff response
 * @returns Display string, e.g. "iPhone", "Android", "Mac/PC", "terminal"
 */
function deviceLabel(kind: string): string {
  switch (kind) {
    case 'mobile_ios':
      return 'iPhone';
    case 'mobile_android':
      return 'Android';
    case 'cli':
      return 'terminal';
    case 'web':
    default:
      return 'Mac/PC';
  }
}

/**
 * Formats a snapshot age in ms into a short human-readable string.
 *
 * @param ageMs - Age in milliseconds
 * @returns E.g. "just now", "1 min ago", "4 min ago"
 */
function formatAge(ageMs: number): string {
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes === 1) return '1 min ago';
  return `${minutes} min ago`;
}

// ============================================================================
// Component
// ============================================================================

/**
 * Dismissible handoff prompt banner.
 *
 * Mounts a fixed-top banner with two CTAs: "Resume" (restores state) and
 * "Start fresh" (dismisses). The banner unmounts itself after either action
 * by tracking local visibility state.
 *
 * @param props - HandoffBannerProps
 * @returns The banner element, or null if dismissed
 *
 * @example
 * {handoff?.available && (
 *   <HandoffBanner
 *     handoff={handoff}
 *     onResume={handleResume}
 *     onDismiss={() => setHandoff(null)}
 *   />
 * )}
 */
export function HandoffBanner({ handoff, onResume, onDismiss }: HandoffBannerProps) {
  const [visible, setVisible] = useState(true);

  const handleResume = useCallback(() => {
    setVisible(false);
    onResume(handoff);
  }, [handoff, onResume]);

  const handleDismiss = useCallback(() => {
    setVisible(false);
    onDismiss();
  }, [onDismiss]);

  if (!visible) return null;

  const label = deviceLabel(handoff.lastDeviceKind);
  const age = formatAge(handoff.ageMs);
  const hasDraft = Boolean(handoff.activeDraft);

  return (
    <div
      role="alert"
      aria-live="polite"
      className="flex items-center justify-between gap-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm shadow-md dark:border-blue-800 dark:bg-blue-950"
      data-testid="handoff-banner"
    >
      {/* Info icon */}
      <svg
        className="h-4 w-4 shrink-0 text-blue-500"
        viewBox="0 0 20 20"
        fill="currentColor"
        aria-hidden="true"
      >
        <path
          fillRule="evenodd"
          d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a.75.75 0 000 1.5h.253a.25.25 0 01.244.304l-.459 2.066A1.75 1.75 0 0010.747 15H11a.75.75 0 000-1.5h-.253a.25.25 0 01-.244-.304l.459-2.066A1.75 1.75 0 009.253 9H9z"
          clipRule="evenodd"
        />
      </svg>

      {/* Message */}
      <p className="flex-1 text-blue-900 dark:text-blue-100">
        Pick up where you left off on{' '}
        <span className="font-medium">{label}</span>
        {' '}
        <span className="text-blue-600 dark:text-blue-400">({age})</span>
        {hasDraft && (
          <span className="ml-1 text-blue-600 dark:text-blue-400">
            — unsent message restored
          </span>
        )}
      </p>

      {/* Actions */}
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={handleResume}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
          data-testid="handoff-resume-button"
        >
          Resume
        </button>

        <button
          type="button"
          onClick={handleDismiss}
          className="rounded-md border border-blue-300 px-3 py-1.5 text-xs font-medium text-blue-700 transition-colors hover:bg-blue-100 dark:border-blue-700 dark:text-blue-300 dark:hover:bg-blue-900"
          data-testid="handoff-start-fresh-button"
        >
          Start fresh
        </button>

        {/* Dismiss X */}
        <button
          type="button"
          onClick={handleDismiss}
          aria-label="Dismiss handoff prompt"
          className="rounded p-1 text-blue-500 transition-colors hover:bg-blue-100 dark:hover:bg-blue-900"
          data-testid="handoff-dismiss-button"
        >
          <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
          </svg>
        </button>
      </div>
    </div>
  );
}
