'use client';

/**
 * Session Bookmark Button
 *
 * A client component that renders a star icon button for bookmarking or
 * un-bookmarking a session. Uses optimistic UI — the star toggles immediately
 * and reverts if the API call fails.
 *
 * Tier limits are enforced server-side. If the user's limit is reached the
 * API returns 403 and we show an inline error tooltip.
 *
 * @module dashboard/sessions/[id]/session-bookmark-button
 */

import { useState, useCallback } from 'react';

/* ──────────────────────────── Types ──────────────────────────── */

/**
 * Props for the SessionBookmarkButton component.
 */
interface SessionBookmarkButtonProps {
  /** The session ID to bookmark or un-bookmark. */
  sessionId: string;
  /**
   * Whether the session is already bookmarked.
   * Determines the initial filled/outline state of the star icon.
   */
  initialBookmarked: boolean;
  /**
   * Visual variant.
   * - 'sm'  — small icon for list items (16px)
   * - 'md'  — medium icon for session detail headers (20px)
   *
   * @default 'md'
   */
  size?: 'sm' | 'md';
}

/* ──────────────────────────── Component ──────────────────────────── */

/**
 * Star icon button that toggles a session's bookmarked state.
 *
 * Optimistic UI pattern:
 * 1. Toggle `isBookmarked` immediately so the user sees instant feedback.
 * 2. Fire the API request (POST to add, DELETE to remove).
 * 3. On failure, revert the optimistic state and show an inline error message.
 *
 * @param sessionId - The session to bookmark/un-bookmark
 * @param initialBookmarked - Whether the session is already bookmarked
 * @param size - Icon size variant ('sm' | 'md')
 * @returns A pressable star icon button
 */
export function SessionBookmarkButton({
  sessionId,
  initialBookmarked,
  size = 'md',
}: SessionBookmarkButtonProps) {
  const [isBookmarked, setIsBookmarked] = useState(initialBookmarked);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Toggles the bookmark state with optimistic UI.
   *
   * WHY: We optimistically flip the icon before the network call so the
   * interaction feels instant. If the API fails we revert and show the
   * error message inline. A tooltip-style error is preferred over a toast
   * so it doesn't obscure other UI elements.
   */
  const handleToggle = useCallback(async () => {
    if (isLoading) return;

    // Optimistic update
    const previous = isBookmarked;
    setIsBookmarked(!previous);
    setIsLoading(true);
    setError(null);

    try {
      const method = previous ? 'DELETE' : 'POST';
      const response = await fetch('/api/bookmarks', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId }),
      });

      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? 'Failed to update bookmark');
      }
    } catch (err) {
      // Revert optimistic update on failure
      setIsBookmarked(previous);
      setError(err instanceof Error ? err.message : 'Failed to update bookmark');
    } finally {
      setIsLoading(false);
    }
  }, [isLoading, isBookmarked, sessionId]);

  const iconSize = size === 'sm' ? 'h-4 w-4' : 'h-5 w-5';
  const buttonPadding = size === 'sm' ? 'p-1' : 'p-1.5';

  return (
    <div className="relative inline-flex">
      <button
        onClick={(e) => {
          // WHY: Stop propagation so clicking the star on a session list item
          // doesn't also navigate to the session detail page.
          e.preventDefault();
          e.stopPropagation();
          void handleToggle();
        }}
        disabled={isLoading}
        aria-label={isBookmarked ? 'Remove bookmark' : 'Bookmark session'}
        aria-pressed={isBookmarked}
        title={isBookmarked ? 'Remove bookmark' : 'Bookmark this session'}
        className={`
          ${buttonPadding} rounded-md transition-all
          ${isLoading ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}
          ${
            isBookmarked
              ? 'text-orange-400 hover:text-orange-300'
              : 'text-zinc-500 hover:text-orange-400'
          }
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500
        `}
      >
        {/* Star icon: filled when bookmarked, outline when not */}
        {isBookmarked ? (
          /* Filled star */
          <svg
            className={iconSize}
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
          </svg>
        ) : (
          /* Outline star */
          <svg
            className={iconSize}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.75}
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"
            />
          </svg>
        )}
      </button>

      {/* Inline error tooltip */}
      {/* WHY: A tooltip anchored to the button is less disruptive than a toast
          and gives the user immediate context about what went wrong without
          scrolling to a notification area. */}
      {error && (
        <div
          role="alert"
          className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-max max-w-[200px] rounded-lg bg-red-900/90 border border-red-700/50 px-3 py-1.5 text-xs text-red-200 z-50 pointer-events-none text-center"
        >
          {error}
          <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-red-900/90" />
        </div>
      )}
    </div>
  );
}
