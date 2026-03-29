/**
 * Bookmarks Hook
 *
 * Manages session bookmark state for the mobile app. Handles fetching the
 * user's bookmarked session IDs, toggling a bookmark (POST to add, DELETE to
 * remove), and exposes loading/error state per session.
 *
 * The hook calls the Styrby web API (`/api/bookmarks`) rather than Supabase
 * directly so that tier limit enforcement (Free: 5, Pro: 50, Power: unlimited)
 * runs through the same server-side logic as the web app.
 *
 * WHY call the web API instead of Supabase client directly: The tier gate
 * logic lives in the Next.js route handler and would have to be duplicated if
 * we bypassed it. Centralising enforcement in the API prevents divergence
 * between platforms.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabase';

// ============================================================================
// Constants
// ============================================================================

/**
 * Base URL for the Styrby web app API.
 * Reads from the Expo environment variable; falls back to the production URL.
 */
const APP_URL =
  process.env.EXPO_PUBLIC_APP_URL ?? 'https://app.styrby.com';

// ============================================================================
// Types
// ============================================================================

/**
 * Return value from the useBookmarks hook.
 */
export interface UseBookmarksResult {
  /**
   * Set of session IDs that the authenticated user has bookmarked.
   * Use `bookmarkedIds.has(sessionId)` for O(1) lookup.
   */
  bookmarkedIds: Set<string>;

  /** True while the initial bookmark list is being fetched. */
  isLoading: boolean;

  /**
   * Error message from the last failed fetch, or null if no error.
   */
  fetchError: string | null;

  /**
   * Map of session IDs to their in-flight toggle loading state.
   * Used to show subtle opacity on star icons during the API call.
   */
  togglingIds: Set<string>;

  /**
   * Map of session IDs to per-toggle error messages.
   * Cleared automatically after 4 seconds so errors don't linger.
   */
  toggleErrors: Map<string, string>;

  /**
   * Toggles the bookmark state for a session optimistically.
   *
   * - If the session is currently bookmarked: sends DELETE, removes from set.
   * - If not bookmarked: sends POST, adds to set.
   * - On failure: reverts the optimistic update and sets a per-session error.
   *
   * @param sessionId - The session to bookmark or un-bookmark
   */
  toggleBookmark: (sessionId: string) => Promise<void>;
}

// ============================================================================
// Hook
// ============================================================================

/**
 * Fetches and manages bookmark state for the current user.
 *
 * @returns Bookmark state and toggle function
 *
 * @example
 * const { bookmarkedIds, toggleBookmark, togglingIds } = useBookmarks();
 * const isBookmarked = bookmarkedIds.has(session.id);
 * const isToggling  = togglingIds.has(session.id);
 */
export function useBookmarks(): UseBookmarksResult {
  const [bookmarkedIds, setBookmarkedIds] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [togglingIds, setTogglingIds] = useState<Set<string>>(new Set());
  const [toggleErrors, setToggleErrors] = useState<Map<string, string>>(new Map());

  /**
   * Tracks error-clearing timers so we can cancel them on unmount.
   * WHY: Without cleanup, setState calls after unmount cause memory leaks.
   */
  const errorTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // ---- Fetch on mount ----

  useEffect(() => {
    let cancelled = false;

    async function fetchBookmarks() {
      try {
        setIsLoading(true);
        setFetchError(null);

        const { data: { session: authSession } } = await supabase.auth.getSession();
        const token = authSession?.access_token;

        if (!token) {
          if (!cancelled) setFetchError('Not authenticated');
          return;
        }

        const response = await fetch(`${APP_URL}/api/bookmarks`, {
          headers: { Authorization: `Bearer ${token}` },
        });

        if (!response.ok) {
          const data = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error ?? `HTTP ${response.status}`);
        }

        const data = (await response.json()) as {
          bookmarks: Array<{ session_id: string }>;
        };

        if (!cancelled) {
          setBookmarkedIds(new Set(data.bookmarks.map((b) => b.session_id)));
        }
      } catch (err) {
        if (!cancelled) {
          setFetchError(
            err instanceof Error ? err.message : 'Failed to load bookmarks'
          );
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    void fetchBookmarks();

    return () => {
      cancelled = true;
    };
  }, []);

  // ---- Cleanup error timers on unmount ----

  useEffect(() => {
    const timers = errorTimers.current;
    return () => {
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
    };
  }, []);

  // ---- Toggle ----

  /**
   * Toggles the bookmark state for a session with optimistic UI.
   *
   * @param sessionId - Session to bookmark or un-bookmark
   */
  const toggleBookmark = useCallback(
    async (sessionId: string) => {
      // Prevent double-tap while a toggle is in flight
      if (togglingIds.has(sessionId)) return;

      // Optimistic update
      const wasBookmarked = bookmarkedIds.has(sessionId);
      setBookmarkedIds((prev) => {
        const next = new Set(prev);
        if (wasBookmarked) {
          next.delete(sessionId);
        } else {
          next.add(sessionId);
        }
        return next;
      });

      // Mark as in-flight
      setTogglingIds((prev) => new Set(prev).add(sessionId));

      try {
        const { data: { session: authSession } } = await supabase.auth.getSession();
        const token = authSession?.access_token;

        if (!token) throw new Error('Not authenticated');

        const method = wasBookmarked ? 'DELETE' : 'POST';
        const response = await fetch(`${APP_URL}/api/bookmarks`, {
          method,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ session_id: sessionId }),
        });

        if (!response.ok) {
          const data = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error ?? `HTTP ${response.status}`);
        }
      } catch (err) {
        // Revert the optimistic update
        setBookmarkedIds((prev) => {
          const next = new Set(prev);
          if (wasBookmarked) {
            next.add(sessionId); // put back
          } else {
            next.delete(sessionId); // remove
          }
          return next;
        });

        // Surface per-session error, auto-clear after 4 s
        const message =
          err instanceof Error ? err.message : 'Failed to update bookmark';
        setToggleErrors((prev) => new Map(prev).set(sessionId, message));

        // Clear any existing timer for this session
        const existing = errorTimers.current.get(sessionId);
        if (existing) clearTimeout(existing);

        const timer = setTimeout(() => {
          setToggleErrors((prev) => {
            const next = new Map(prev);
            next.delete(sessionId);
            return next;
          });
          errorTimers.current.delete(sessionId);
        }, 4000);

        errorTimers.current.set(sessionId, timer);
      } finally {
        setTogglingIds((prev) => {
          const next = new Set(prev);
          next.delete(sessionId);
          return next;
        });
      }
    },
    [bookmarkedIds, togglingIds]
  );

  return {
    bookmarkedIds,
    isLoading,
    fetchError,
    togglingIds,
    toggleErrors,
    toggleBookmark,
  };
}
