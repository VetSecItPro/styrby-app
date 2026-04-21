/**
 * Code Review Screen — Orchestrator
 *
 * Mobile interface for reviewing agent-generated code changes before they
 * are applied. Loads the CodeReview by id (or accepts it via relay deep-link
 * params), renders one expandable diff per changed file, collects per-file +
 * overall comments, and sends the reviewer's decision back to the CLI via the
 * relay channel.
 *
 * Route: /review/[id]
 * - `[id]` is the CodeReview UUID, supplied either by a push notification deep
 *   link or by the active sessions relay message.
 *
 * Review workflow:
 * 1. Load the CodeReview from Supabase (or accept it from relay route params)
 * 2. Show a file list with +/- counts and inline diffs
 * 3. Allow per-file and overall comments
 * 4. Submit approve / reject / request-changes decision
 * 5. Send the decision back to the CLI via the relay channel
 *
 * The relay message type `code_review_response` carries:
 * - `reviewId`
 * - `status` ('approved' | 'rejected' | 'changes_requested')
 * - `comments` array
 *
 * WHY mobile code review: Developers often step away from their desk while an
 * agent is running. Mobile review lets them approve or reject agent-generated
 * changes from anywhere without needing to open a terminal.
 *
 * WHY orchestrator pattern: This file owns route-param parsing, navigation,
 * and the top-level layout only. State, I/O, and each visual section live in
 * `src/components/review/` per CLAUDE.md "Component-First Architecture" rules.
 *
 * @see src/components/review — sub-components, hook, helpers
 * @module app/review/[id]
 */

import React from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import {
  ActionBar,
  DecisionModal,
  FileRow,
  PendingCommentsList,
  ReviewHeader,
  ReviewLoadingScreen,
  ReviewNotFoundScreen,
  SummaryBar,
  useReview,
} from '@/components/review';
// Deep import: computeTotals is a private helper of the review group.
// Keeping it out of the barrel preserves the "barrel exports only what
// the orchestrator needs" rule (matches account + costs barrels).
import { computeTotals } from '@/components/review/helpers';

/**
 * Code review screen for reviewing agent-generated changes on mobile.
 *
 * @returns React element for the review screen
 */
export default function ReviewScreen() {
  const params = useLocalSearchParams<{ id: string; review?: string }>();

  const {
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
  } = useReview(params);

  if (isLoading) {
    return <ReviewLoadingScreen />;
  }

  if (!review) {
    return <ReviewNotFoundScreen onBack={() => router.back()} />;
  }

  const totals = computeTotals(review.files);
  const isDecided = review.status !== 'pending';

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: '#09090b' }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ReviewHeader
        summary={review.summary}
        status={review.status}
        isDecided={isDecided}
        onBack={() => router.back()}
      />

      <SummaryBar
        fileCount={review.files.length}
        totals={totals}
        gitBranch={review.gitBranch}
        pendingCommentCount={pendingComments.length}
      />

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 16 }}
        showsVerticalScrollIndicator={false}
      >
        {review.files.map((file) => (
          <FileRow
            key={file.path}
            file={file}
            isExpanded={expandedFiles.has(file.path)}
            onToggle={() => toggleFile(file.path)}
            onAddComment={handleAddComment}
          />
        ))}

        <PendingCommentsList comments={pendingComments} />

        {/* Bottom padding so the action bar doesn't overlap the last item */}
        <View style={{ height: 100 }} />
      </ScrollView>

      {/* Action Bar — only for pending reviews */}
      {!isDecided && <ActionBar isSubmitting={isSubmitting} onDecision={openDecision} />}

      <DecisionModal
        visible={showDecisionModal}
        selectedDecision={selectedDecision}
        overallComment={overallComment}
        onOverallCommentChange={setOverallComment}
        onCancel={closeDecisionModal}
        onConfirm={() => void submitDecision()}
      />
    </KeyboardAvoidingView>
  );
}
