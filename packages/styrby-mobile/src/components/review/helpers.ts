/**
 * Review Screen — Pure Helpers
 *
 * Conversion + aggregation helpers used by the review screen orchestrator
 * and its hook. Pure (no React, no Supabase, no I/O) so they are trivially
 * unit-testable.
 *
 * WHY split out: Extracted from `app/review/[id].tsx` during the orchestrator
 * refactor to satisfy the "extract pure helpers + write tests" rule from
 * CLAUDE.md.
 *
 * @module components/review/helpers
 */

import type { CodeReview, CodeReviewRow, ReviewFile, ReviewTotals } from '@/types/review';

/**
 * Maps a raw Supabase `code_reviews` row to the camelCase CodeReview shared type.
 *
 * @param row - Raw database row as returned by `supabase.from('code_reviews')`
 * @returns Typed CodeReview with snake_case columns mapped to camelCase fields
 *
 * @example
 * const { data } = await supabase.from('code_reviews').select('*').single();
 * const review = rowToReview(data as CodeReviewRow);
 */
export function rowToReview(row: CodeReviewRow): CodeReview {
  return {
    id: row.id,
    sessionId: row.session_id,
    status: row.status,
    summary: row.summary ?? undefined,
    gitBranch: row.git_branch ?? undefined,
    files: row.files ?? [],
    comments: row.comments ?? [],
    createdAt: row.created_at,
  };
}

/**
 * Computes total additions and deletions across every file in a review.
 * Used by the SummaryBar to render the +X / -Y counters at the top of the screen.
 *
 * @param files - Array of ReviewFile objects (typically `review.files`)
 * @returns Object with summed `additions` and `deletions`
 *
 * @example
 * computeTotals([{ additions: 3, deletions: 1 }, { additions: 0, deletions: 2 }])
 * // => { additions: 3, deletions: 3 }
 */
export function computeTotals(files: ReviewFile[]): ReviewTotals {
  return files.reduce<ReviewTotals>(
    (acc, f) => ({
      additions: acc.additions + f.additions,
      deletions: acc.deletions + f.deletions,
    }),
    { additions: 0, deletions: 0 },
  );
}
