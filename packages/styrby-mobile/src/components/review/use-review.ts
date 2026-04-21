/**
 * useReview — State + I/O hook for the code review screen.
 *
 * Encapsulates loading the CodeReview (from Supabase or relay-passed JSON),
 * tracking expanded files, accumulating pending comments, and submitting the
 * final decision both via the relay channel and back to Supabase.
 *
 * WHY hook (vs. orchestrator-local state): The screen has 6 pieces of state,
 * 4 callbacks, and 2 async operations. Pulling them into a custom hook keeps
 * `app/review/[id].tsx` focused on layout and lets us add unit tests later
 * without going through the full screen render path.
 *
 * @module components/review/use-review
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import { router } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { useRelay } from '@/hooks/useRelay';
import { rowToReview } from './helpers';
import type {
  CodeReview,
  CodeReviewRow,
  CodeReviewStatus,
  ReviewComment,
} from '@/types/review';

/**
 * Development-only logger. Sensitive diff data must never reach production
 * log aggregators, so console output is gated on `__DEV__`.
 */
const logger = {
  log: (...args: unknown[]) => {
    if (__DEV__) console.log('[Review]', ...args);
  },
  error: (...args: unknown[]) => {
    if (__DEV__) console.error('[Review]', ...args);
  },
};

/**
 * Inputs to the hook — usually the parsed route params from `useLocalSearchParams`.
 */
export interface UseReviewParams {
  /** The CodeReview UUID, present whenever the screen is opened. */
  id: string;
  /** Optional JSON-stringified CodeReview passed via relay deep-link. */
  review?: string;
}

/** Return shape of `useReview`. Consumed by the orchestrator. */
export interface UseReviewResult {
  review: CodeReview | null;
  isLoading: boolean;
  isSubmitting: boolean;
  expandedFiles: Set<string>;
  pendingComments: ReviewComment[];
  showDecisionModal: boolean;
  selectedDecision: CodeReviewStatus | null;
  overallComment: string;
  setOverallComment: (text: string) => void;
  toggleFile: (filePath: string) => void;
  handleAddComment: (filePath: string, body: string) => void;
  openDecision: (decision: CodeReviewStatus) => void;
  closeDecisionModal: () => void;
  submitDecision: () => Promise<void>;
}

/**
 * Owns all stateful behavior for the code review screen.
 *
 * @param params - Route params passed from `useLocalSearchParams`
 * @returns Observable state + callbacks for the orchestrator
 */
export function useReview(params: UseReviewParams): UseReviewResult {
  const { sendMessage } = useRelay();

  const [review, setReview] = useState<CodeReview | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
  const [pendingComments, setPendingComments] = useState<ReviewComment[]>([]);
  const [showDecisionModal, setShowDecisionModal] = useState(false);
  const [selectedDecision, setSelectedDecision] = useState<CodeReviewStatus | null>(null);
  const [overallComment, setOverallComment] = useState('');

  // WHY: Prevents double-submit if the user taps the confirm button twice
  // before the network request settles.
  const submittingRef = useRef(false);

  useEffect(() => {
    // If a JSON-encoded review was passed via route params (relay deep-link),
    // use it directly instead of fetching from Supabase.
    if (params.review) {
      try {
        const parsed = JSON.parse(params.review) as CodeReview;
        setReview(parsed);
        setIsLoading(false);
        return;
      } catch (err) {
        logger.error('Failed to parse review from params:', err);
      }
    }

    void loadReview();
    // WHY: loadReview reads params.id from closure; params.id is in this dep
    // array so the effect re-fires whenever the review ID changes. params.review
    // is only read in the early-return guard above, not inside loadReview, so
    // omitting it here is intentional.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.id]);

  /**
   * Loads the CodeReview from Supabase by its ID. Falls back to a 404 UI when
   * the review can't be found.
   */
  const loadReview = async () => {
    setIsLoading(true);
    try {
      const { data, error } = await supabase
        .from('code_reviews')
        .select('*')
        .eq('id', params.id)
        .single();

      if (error || !data) {
        logger.error('Failed to load review:', error?.message);
        setIsLoading(false);
        return;
      }

      setReview(rowToReview(data as CodeReviewRow));
    } finally {
      setIsLoading(false);
    }
  };

  const toggleFile = useCallback((filePath: string) => {
    setExpandedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(filePath)) {
        next.delete(filePath);
      } else {
        next.add(filePath);
      }
      return next;
    });
  }, []);

  const handleAddComment = useCallback((filePath: string, body: string) => {
    const comment: ReviewComment = {
      id: crypto.randomUUID(),
      filePath,
      body,
      createdAt: new Date().toISOString(),
    };
    setPendingComments((prev) => [...prev, comment]);
  }, []);

  const openDecision = useCallback((decision: CodeReviewStatus) => {
    setSelectedDecision(decision);
    setShowDecisionModal(true);
  }, []);

  const closeDecisionModal = useCallback(() => {
    setShowDecisionModal(false);
  }, []);

  /**
   * Submits the review decision to the CLI via the relay channel and persists
   * the same payload to Supabase as an audit trail.
   *
   * Sends a `code_review_response` relay message with the review id, status,
   * and the combined per-file + overall comments. If the Supabase update fails
   * after the relay send, the failure is logged but not surfaced — the CLI
   * already received the decision, so the user-visible action succeeded.
   *
   * @throws Shows an Alert to the user when the relay send itself fails
   */
  const submitDecision = useCallback(async () => {
    if (!review || !selectedDecision || submittingRef.current) return;
    submittingRef.current = true;
    setIsSubmitting(true);
    setShowDecisionModal(false);

    const allComments = overallComment.trim()
      ? [
          ...pendingComments,
          {
            id: crypto.randomUUID(),
            filePath: '',
            body: overallComment.trim(),
            createdAt: new Date().toISOString(),
          } as ReviewComment,
        ]
      : pendingComments;

    try {
      // 1. Send the decision via relay (the CLI is waiting for this)
      await sendMessage({
        type: 'code_review_response',
        payload: {
          review_id: review.id,
          status: selectedDecision,
          comments: allComments,
        },
      });

      // 2. Persist the decision to Supabase
      const { error } = await supabase
        .from('code_reviews')
        .update({
          status: selectedDecision,
          comments: allComments,
        })
        .eq('id', review.id);

      if (error) {
        logger.error('Failed to persist review decision:', error.message);
        // WHY: Non-fatal — relay message was already sent. The CLI has the decision.
      }

      // Update local state
      setReview((prev) =>
        prev ? { ...prev, status: selectedDecision, comments: allComments } : prev,
      );

      const decisionLabel =
        selectedDecision === 'approved'
          ? 'Approved'
          : selectedDecision === 'rejected'
            ? 'Rejected'
            : 'Changes Requested';

      Alert.alert(
        `Review ${decisionLabel}`,
        'Your decision has been sent to the CLI.',
        [{ text: 'OK', onPress: () => router.back() }],
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to send review decision.';
      Alert.alert('Error', msg);
    } finally {
      setIsSubmitting(false);
      submittingRef.current = false;
    }
  }, [review, selectedDecision, pendingComments, overallComment, sendMessage]);

  return {
    review,
    isLoading,
    isSubmitting,
    expandedFiles,
    pendingComments,
    showDecisionModal,
    selectedDecision,
    overallComment,
    setOverallComment,
    toggleFile,
    handleAddComment,
    openDecision,
    closeDecisionModal,
    submitDecision,
  };
}
