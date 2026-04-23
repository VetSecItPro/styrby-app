/**
 * useApprovalActions — Mobile approval vote hook (Phase 2.4)
 *
 * Manages the vote lifecycle for a single pending approval request:
 *   1. POST `/api/approval/[id]` with the vote (approve/deny).
 *   2. Tracks in-flight state so the card can show a loading spinner.
 *   3. Surfaces errors for display in the card's error banner.
 *   4. Calls `onResolved` when the vote succeeds so the parent list can
 *      remove or update the card without waiting for a Realtime event.
 *
 * WHY this is a custom hook rather than inline state in the card:
 *   The card is a pure presentational component. Keeping fetch logic here
 *   lets us test voting behaviour without mounting the full React tree, and
 *   lets us reuse this hook in the `ApprovalDetailScreen` where the same
 *   action is available.
 *
 * @module components/approvals/useApprovalActions
 */

import { useState, useCallback } from 'react';

// ============================================================================
// Types
// ============================================================================

/** Shape of the API response from POST /api/approval/[id]. */
interface ResolveApiResponse {
  approvalId?: string;
  status?: string;
  reason?: string;
  error?: string;
}

/** Inputs for the hook. */
export interface UseApprovalActionsInput {
  /**
   * The Supabase project URL used to build the API URL.
   * Defaults to EXPO_PUBLIC_SUPABASE_URL env var.
   */
  supabaseUrl?: string;

  /**
   * Called when the vote completes successfully.
   * The parent can use this to optimistically remove the card from the list.
   *
   * @param approvalId - The resolved approval's UUID.
   * @param status - The terminal status ('approved' | 'denied').
   */
  onResolved?: (approvalId: string, status: 'approved' | 'denied') => void;

  /**
   * Override fetch for testing. Defaults to globalThis.fetch.
   */
  fetchImpl?: typeof fetch;

  /**
   * Override the access token retrieval. When omitted, the hook reads from
   * the Expo SecureStore / supabase.auth.getSession() in the real app.
   * In tests, supply a fake token directly.
   */
  getAccessToken?: () => Promise<string | null>;
}

/** Return value of {@link useApprovalActions}. */
export interface UseApprovalActionsResult {
  /** True while a vote call is in-flight. */
  isVoting: boolean;
  /** Error message from the last failed vote, or null. */
  voteError: string | null;
  /**
   * Submit a vote for the given approval.
   *
   * @param approvalId - The approval row UUID.
   * @param vote - The approver's decision.
   * @param resolutionNote - Optional reason (recommended for denials).
   */
  vote: (
    approvalId: string,
    vote: 'approved' | 'denied',
    resolutionNote?: string,
  ) => Promise<void>;
  /** Clear any displayed error. */
  clearError: () => void;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Builds the API URL for the approval resolution endpoint.
 *
 * WHY we use the Next.js `/api/approval/[id]` route instead of calling the
 * edge function directly:
 *   The mobile app authenticates via Supabase session cookies managed by
 *   Next.js. The API route validates the session server-side and forwards a
 *   signed JWT to the edge function. This avoids storing a long-lived JWT in
 *   the mobile app's secure store for approval requests specifically.
 *
 * @param baseUrl - The web app base URL (e.g. https://app.styrby.com)
 * @param approvalId - The approval row UUID.
 * @returns Full API URL string.
 */
function buildApprovalUrl(baseUrl: string, approvalId: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/api/approval/${approvalId}`;
}

// ============================================================================
// Hook
// ============================================================================

/**
 * Manages vote submission for a pending approval request.
 *
 * @param input - Configuration and callbacks.
 * @returns State + vote function for the card component.
 *
 * @example
 * ```tsx
 * const { isVoting, voteError, vote } = useApprovalActions({
 *   onResolved: (id, status) => removeFromList(id),
 * });
 *
 * return (
 *   <ApprovalRequestCard
 *     approval={approval}
 *     isVoting={isVoting}
 *     voteError={voteError}
 *     onVote={(id, v) => vote(id, v)}
 *     onViewDetails={navigateToDetail}
 *   />
 * );
 * ```
 */
export function useApprovalActions({
  supabaseUrl,
  onResolved,
  fetchImpl = globalThis.fetch,
  getAccessToken,
}: UseApprovalActionsInput = {}): UseApprovalActionsResult {
  const [isVoting, setIsVoting] = useState(false);
  const [voteError, setVoteError] = useState<string | null>(null);

  /**
   * Resolves the access token from the environment.
   *
   * WHY a lazy default: importing `supabase` from `@/lib/supabase` would
   * create a circular dependency if this hook is used in tests that mock
   * the supabase module. The `getAccessToken` override lets tests inject a
   * fake token directly.
   */
  const resolveAccessToken = useCallback(async (): Promise<string | null> => {
    if (getAccessToken) return getAccessToken();
    // Dynamic import avoids circular dependency in test environments
    try {
      const { supabase } = await import('@/lib/supabase');
      const { data } = await supabase.auth.getSession();
      return data.session?.access_token ?? null;
    } catch {
      return null;
    }
  }, [getAccessToken]);

  const vote = useCallback(
    async (
      approvalId: string,
      voteDecision: 'approved' | 'denied',
      resolutionNote?: string,
    ): Promise<void> => {
      if (isVoting) return; // Prevent double-submit

      setIsVoting(true);
      setVoteError(null);

      try {
        const accessToken = await resolveAccessToken();
        if (!accessToken) {
          setVoteError('Session expired. Please log in again.');
          return;
        }

        // WHY we use the web app base URL rather than the Supabase URL:
        //   The `/api/approval/[id]` route is a Next.js API route, not a
        //   Supabase edge function. The web app base URL is the same origin
        //   as the dashboard the approver is already using.
        const webBaseUrl =
          supabaseUrl ??
          process.env.EXPO_PUBLIC_WEB_URL ??
          'https://app.styrby.com';

        const url = buildApprovalUrl(webBaseUrl, approvalId);

        const response = await fetchImpl(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({
            vote: voteDecision,
            resolutionNote,
          }),
        });

        const body = (await response.json()) as ResolveApiResponse;

        if (!response.ok) {
          // Surface a user-friendly error based on the HTTP status
          if (response.status === 403) {
            setVoteError(body.error ?? 'You do not have permission to resolve this approval.');
          } else if (response.status === 409) {
            // Already resolved — silently dismiss; treat as success
            onResolved?.(approvalId, body.status as 'approved' | 'denied' ?? voteDecision);
          } else {
            setVoteError(body.error ?? `Unexpected error (${response.status}). Please try again.`);
          }
          return;
        }

        // Success: notify parent to optimistically update the list
        onResolved?.(approvalId, voteDecision);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Network error. Please try again.';
        setVoteError(message);
      } finally {
        setIsVoting(false);
      }
    },
    [isVoting, resolveAccessToken, fetchImpl, supabaseUrl, onResolved],
  );

  const clearError = useCallback(() => setVoteError(null), []);

  return { isVoting, voteError, vote, clearError };
}
