/**
 * Review Screen — Domain Types
 *
 * Shared type definitions for the Code Review screen and its sub-components.
 * Mirrors the shape of the Supabase `code_reviews` row plus prop interfaces
 * for every sub-component in `src/components/review/`.
 *
 * WHY: Hoisted out of `app/review/[id].tsx` during the orchestrator refactor
 * so every sub-component imports from one stable location instead of from a
 * screen file. Matches the pattern established for agent-config, chat,
 * sessions, and webhooks.
 *
 * @module types/review
 */

import type { CodeReview, CodeReviewStatus, ReviewFile, ReviewComment } from 'styrby-shared';

export type { CodeReview, CodeReviewStatus, ReviewFile, ReviewComment };

/**
 * Raw Supabase row from the `code_reviews` table.
 *
 * WHY separate from CodeReview: DB columns are snake_case; the shared type
 * is camelCase. The mapping is performed by `rowToReview` in helpers.ts.
 */
export interface CodeReviewRow {
  id: string;
  session_id: string;
  status: CodeReviewStatus;
  summary: string | null;
  git_branch: string | null;
  files: ReviewFile[];
  comments: ReviewComment[];
  created_at: string;
}

/**
 * Aggregate +/- counts across all files in a review.
 * Returned by `computeTotals`.
 */
export interface ReviewTotals {
  additions: number;
  deletions: number;
}

// ============================================================================
// Sub-Component Prop Types
// ============================================================================

/** Props for `<FileRow />` — one expandable file in the review list. */
export interface FileRowProps {
  file: ReviewFile;
  isExpanded: boolean;
  onToggle: () => void;
  onAddComment: (filePath: string, comment: string) => void;
}

/** Props for `<ReviewHeader />` — top bar with back button + status badge. */
export interface ReviewHeaderProps {
  summary: string | undefined;
  status: CodeReviewStatus;
  isDecided: boolean;
  onBack: () => void;
}

/** Props for `<SummaryBar />` — counts of files, +/-, branch, comments. */
export interface SummaryBarProps {
  fileCount: number;
  totals: ReviewTotals;
  gitBranch: string | undefined;
  pendingCommentCount: number;
}

/** Props for `<PendingCommentsList />` — preview of unsaved file comments. */
export interface PendingCommentsListProps {
  comments: ReviewComment[];
}

/** Props for `<ActionBar />` — Reject / Request Changes / Approve buttons. */
export interface ActionBarProps {
  isSubmitting: boolean;
  onDecision: (status: CodeReviewStatus) => void;
}

/** Props for `<DecisionModal />` — confirm decision + collect overall comment. */
export interface DecisionModalProps {
  visible: boolean;
  selectedDecision: CodeReviewStatus | null;
  overallComment: string;
  onOverallCommentChange: (text: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}
