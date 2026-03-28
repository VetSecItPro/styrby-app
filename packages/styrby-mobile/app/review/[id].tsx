/**
 * Code Review Screen
 *
 * Mobile interface for reviewing agent-generated code changes before they
 * are applied. Displays a list of changed files with diff viewers and
 * provides approve/reject/request-changes controls.
 *
 * Route: /review/[id]
 * - [id] is the CodeReview UUID, either from a push notification deep link
 *   or from the active sessions relay message.
 *
 * Review workflow:
 * 1. Load the CodeReview from Supabase (or accept it from relay route params)
 * 2. Show a file list with +/- counts and inline diffs
 * 3. Allow per-file and per-hunk comments
 * 4. Submit approve / reject / request-changes decision
 * 5. Send the decision back to the CLI via the relay channel
 *
 * The relay message type 'code_review_response' carries:
 * - reviewId
 * - status ('approved' | 'rejected' | 'changes_requested')
 * - comments array
 *
 * WHY mobile code review: Developers often step away from their desk while
 * an agent is running. Mobile review lets them approve or reject agent-generated
 * changes from anywhere without needing to open a terminal.
 *
 * @module app/review/[id]
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  ScrollView,
  Pressable,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  Alert,
  ActivityIndicator,
  Modal,
} from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useRelay } from '../../src/hooks/useRelay';
import { DiffViewer } from '../../src/components/DiffViewer';
import { supabase } from '../../src/lib/supabase';
import type { CodeReview, CodeReviewStatus, ReviewFile, ReviewComment } from 'styrby-shared';

// ============================================================================
// Dev Logger
// ============================================================================

/**
 * Development-only logger to prevent sensitive diff data from leaking
 * into production logs.
 */
const logger = {
  log: (...args: unknown[]) => { if (__DEV__) console.log('[Review]', ...args); },
  error: (...args: unknown[]) => { if (__DEV__) console.error('[Review]', ...args); },
};

// ============================================================================
// Types
// ============================================================================

/**
 * Raw Supabase row from the `code_reviews` table.
 * WHY separate from CodeReview: DB columns are snake_case; the shared type is camelCase.
 */
interface CodeReviewRow {
  id: string;
  session_id: string;
  status: CodeReviewStatus;
  summary: string | null;
  git_branch: string | null;
  files: ReviewFile[];
  comments: ReviewComment[];
  created_at: string;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Maps a raw Supabase code_reviews row to the CodeReview shared type.
 *
 * @param row - Raw database row
 * @returns Typed CodeReview object
 */
function rowToReview(row: CodeReviewRow): CodeReview {
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
 * Computes total additions and deletions across all files in a review.
 *
 * @param files - Array of ReviewFile objects
 * @returns Object with total additions and deletions
 */
function computeTotals(files: ReviewFile[]): { additions: number; deletions: number } {
  return files.reduce(
    (acc, f) => ({
      additions: acc.additions + f.additions,
      deletions: acc.deletions + f.deletions,
    }),
    { additions: 0, deletions: 0 }
  );
}

// ============================================================================
// Sub-Components
// ============================================================================

/**
 * File list item with expand-on-tap to reveal the DiffViewer.
 *
 * @param file - The ReviewFile to display
 * @param isExpanded - Whether the diff should be shown
 * @param onToggle - Called when the row is tapped
 * @param onAddComment - Called when the user submits a file-level comment
 * @returns React element
 */
function FileRow({
  file,
  isExpanded,
  onToggle,
  onAddComment,
}: {
  file: ReviewFile;
  isExpanded: boolean;
  onToggle: () => void;
  onAddComment: (filePath: string, comment: string) => void;
}) {
  const [showCommentInput, setShowCommentInput] = useState(false);
  const [commentText, setCommentText] = useState('');

  const handleSubmitComment = useCallback(() => {
    const trimmed = commentText.trim();
    if (!trimmed) return;
    onAddComment(file.path, trimmed);
    setCommentText('');
    setShowCommentInput(false);
  }, [commentText, file.path, onAddComment]);

  return (
    <View style={{ marginBottom: 4 }}>
      {/* Tap row to expand diff */}
      <Pressable
        onPress={onToggle}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          backgroundColor: '#18181b',
          paddingHorizontal: 14,
          paddingVertical: 10,
          borderRadius: isExpanded ? undefined : 10,
          borderTopLeftRadius: 10,
          borderTopRightRadius: 10,
          borderWidth: 1,
          borderColor: '#27272a',
        }}
        accessibilityRole="button"
        accessibilityLabel={`${isExpanded ? 'Collapse' : 'Expand'} ${file.path}`}
        accessibilityState={{ expanded: isExpanded }}
      >
        <Ionicons name="document-text-outline" size={16} color="#71717a" />
        <Text
          style={{
            color: '#e4e4e7',
            fontSize: 13,
            fontFamily: 'monospace',
            flex: 1,
            marginLeft: 8,
          }}
          numberOfLines={1}
        >
          {file.path}
        </Text>
        <Text style={{ color: '#86efac', fontSize: 12, fontWeight: '600', marginRight: 8 }}>
          +{file.additions}
        </Text>
        <Text style={{ color: '#fca5a5', fontSize: 12, fontWeight: '600', marginRight: 8 }}>
          -{file.deletions}
        </Text>
        <Ionicons
          name={isExpanded ? 'chevron-up' : 'chevron-down'}
          size={16}
          color="#71717a"
        />
      </Pressable>

      {/* Expanded diff view */}
      {isExpanded && (
        <View
          style={{
            borderWidth: 1,
            borderTopWidth: 0,
            borderColor: '#27272a',
            borderBottomLeftRadius: 10,
            borderBottomRightRadius: 10,
            overflow: 'hidden',
          }}
        >
          <DiffViewer file={file} showLineNumbers defaultCollapsed={false} />

          {/* Comment input toggle */}
          <View
            style={{
              backgroundColor: '#18181b',
              paddingHorizontal: 12,
              paddingBottom: 10,
            }}
          >
            {showCommentInput ? (
              <View>
                <TextInput
                  value={commentText}
                  onChangeText={setCommentText}
                  placeholder="Add a comment on this file..."
                  placeholderTextColor="#52525b"
                  multiline
                  style={{
                    backgroundColor: '#27272a',
                    color: 'white',
                    borderRadius: 8,
                    padding: 10,
                    fontSize: 13,
                    minHeight: 60,
                    textAlignVertical: 'top',
                    marginBottom: 8,
                  }}
                  accessibilityLabel={`Comment on ${file.path}`}
                />
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <Pressable
                    onPress={() => { setShowCommentInput(false); setCommentText(''); }}
                    style={{
                      paddingHorizontal: 12,
                      paddingVertical: 8,
                      borderRadius: 8,
                      backgroundColor: '#27272a',
                    }}
                    accessibilityRole="button"
                    accessibilityLabel="Cancel comment"
                  >
                    <Text style={{ color: '#71717a', fontSize: 13 }}>Cancel</Text>
                  </Pressable>
                  <Pressable
                    onPress={handleSubmitComment}
                    disabled={!commentText.trim()}
                    style={{
                      paddingHorizontal: 12,
                      paddingVertical: 8,
                      borderRadius: 8,
                      backgroundColor: commentText.trim() ? '#f97316' : '#3f3f46',
                    }}
                    accessibilityRole="button"
                    accessibilityLabel="Submit comment"
                  >
                    <Text style={{ color: 'white', fontSize: 13, fontWeight: '600' }}>
                      Add Comment
                    </Text>
                  </Pressable>
                </View>
              </View>
            ) : (
              <Pressable
                onPress={() => setShowCommentInput(true)}
                style={{ flexDirection: 'row', alignItems: 'center' }}
                accessibilityRole="button"
                accessibilityLabel={`Add a comment on ${file.path}`}
              >
                <Ionicons name="chatbubble-outline" size={14} color="#71717a" />
                <Text style={{ color: '#71717a', fontSize: 12, marginLeft: 6 }}>
                  Add comment on this file
                </Text>
              </Pressable>
            )}
          </View>
        </View>
      )}
    </View>
  );
}

// ============================================================================
// Screen Component
// ============================================================================

/**
 * Code review screen for reviewing agent-generated changes on mobile.
 *
 * Loads the review by ID from Supabase (or relay params), renders diffs for
 * each changed file, collects comments, and sends the reviewer's decision
 * back to the CLI via the relay channel.
 *
 * @returns React element for the review screen
 */
export default function ReviewScreen() {
  const params = useLocalSearchParams<{
    id: string;
    /** Optional: JSON-stringified CodeReview passed via relay deep-link */
    review?: string;
  }>();

  const { sendMessage } = useRelay();

  // --------------------------------------------------------------------------
  // State
  // --------------------------------------------------------------------------

  const [review, setReview] = useState<CodeReview | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
  const [pendingComments, setPendingComments] = useState<ReviewComment[]>([]);
  const [showDecisionModal, setShowDecisionModal] = useState(false);
  const [selectedDecision, setSelectedDecision] = useState<CodeReviewStatus | null>(null);
  const [overallComment, setOverallComment] = useState('');

  // WHY: Prevent double-submit if the user taps quickly
  const submittingRef = useRef(false);

  // --------------------------------------------------------------------------
  // Load Review
  // --------------------------------------------------------------------------

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
  }, [params.id]);

  /**
   * Loads the CodeReview from Supabase by its ID.
   * Falls back to a 404 error UI if the review is not found.
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

  // --------------------------------------------------------------------------
  // File Expansion
  // --------------------------------------------------------------------------

  /**
   * Toggles the expanded state of a file in the review.
   *
   * @param filePath - Workspace-relative path to toggle
   */
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

  // --------------------------------------------------------------------------
  // Comments
  // --------------------------------------------------------------------------

  /**
   * Adds a file-level comment to the pending comments list.
   *
   * @param filePath - The file being commented on
   * @param body - Comment text
   */
  const handleAddComment = useCallback((filePath: string, body: string) => {
    const comment: ReviewComment = {
      id: crypto.randomUUID(),
      filePath,
      body,
      createdAt: new Date().toISOString(),
    };
    setPendingComments((prev) => [...prev, comment]);
  }, []);

  // --------------------------------------------------------------------------
  // Decision Submission
  // --------------------------------------------------------------------------

  /**
   * Opens the decision modal with the selected action.
   *
   * @param decision - The review decision to confirm
   */
  const openDecision = useCallback((decision: CodeReviewStatus) => {
    setSelectedDecision(decision);
    setShowDecisionModal(true);
  }, []);

  /**
   * Submits the review decision to the CLI via the relay channel.
   *
   * Sends a 'code_review_response' relay message containing:
   * - reviewId (correlation ID for the CLI to match the pending review)
   * - status (approved | rejected | changes_requested)
   * - comments (all pending file comments + optional overall comment)
   *
   * Also persists the decision to Supabase for the audit log.
   *
   * @throws Shows Alert if the relay message fails to send
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
      setReview((prev) => prev ? { ...prev, status: selectedDecision, comments: allComments } : prev);

      const decisionLabel =
        selectedDecision === 'approved' ? 'Approved'
        : selectedDecision === 'rejected' ? 'Rejected'
        : 'Changes Requested';

      Alert.alert(
        `Review ${decisionLabel}`,
        'Your decision has been sent to the CLI.',
        [{ text: 'OK', onPress: () => router.back() }]
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to send review decision.';
      Alert.alert('Error', msg);
    } finally {
      setIsSubmitting(false);
      submittingRef.current = false;
    }
  }, [review, selectedDecision, pendingComments, overallComment, sendMessage]);

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------

  if (isLoading) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: '#09090b',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <ActivityIndicator size="large" color="#f97316" />
        <Text style={{ color: '#71717a', marginTop: 12, fontSize: 14 }}>
          Loading review...
        </Text>
      </View>
    );
  }

  if (!review) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: '#09090b',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 32,
        }}
      >
        <Ionicons name="alert-circle" size={48} color="#ef4444" />
        <Text style={{ color: 'white', fontSize: 18, fontWeight: '600', marginTop: 16, textAlign: 'center' }}>
          Review Not Found
        </Text>
        <Text style={{ color: '#71717a', marginTop: 8, textAlign: 'center' }}>
          This code review may have expired or already been submitted.
        </Text>
        <Pressable
          onPress={() => router.back()}
          style={{
            marginTop: 24,
            paddingHorizontal: 20,
            paddingVertical: 12,
            borderRadius: 12,
            backgroundColor: '#f97316',
          }}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Text style={{ color: 'white', fontWeight: '700' }}>Go Back</Text>
        </Pressable>
      </View>
    );
  }

  const totals = computeTotals(review.files);
  const isDecided = review.status !== 'pending';

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: '#09090b' }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {/* Header */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: 16,
          paddingTop: 16,
          paddingBottom: 12,
          borderBottomWidth: 1,
          borderBottomColor: '#18181b',
        }}
      >
        <Pressable
          onPress={() => router.back()}
          style={{ padding: 4, marginRight: 12 }}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Ionicons name="arrow-back" size={22} color="#71717a" />
        </Pressable>

        <View style={{ flex: 1 }}>
          <Text style={{ color: 'white', fontWeight: '700', fontSize: 16 }}>
            Code Review
          </Text>
          {review.summary && (
            <Text style={{ color: '#71717a', fontSize: 13 }} numberOfLines={1}>
              {review.summary}
            </Text>
          )}
        </View>

        {/* Status badge for decided reviews */}
        {isDecided && (
          <View
            style={{
              paddingHorizontal: 10,
              paddingVertical: 4,
              borderRadius: 999,
              backgroundColor:
                review.status === 'approved' ? 'rgba(34,197,94,0.15)'
                : review.status === 'rejected' ? 'rgba(239,68,68,0.15)'
                : 'rgba(234,179,8,0.15)',
            }}
          >
            <Text
              style={{
                fontWeight: '700',
                fontSize: 12,
                color:
                  review.status === 'approved' ? '#22c55e'
                  : review.status === 'rejected' ? '#ef4444'
                  : '#eab308',
              }}
            >
              {review.status === 'approved' ? 'Approved'
               : review.status === 'rejected' ? 'Rejected'
               : 'Changes Requested'}
            </Text>
          </View>
        )}
      </View>

      {/* Summary bar */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: 16,
          paddingVertical: 10,
          backgroundColor: '#0f0f11',
          gap: 16,
        }}
      >
        <Text style={{ color: '#71717a', fontSize: 13 }}>
          {review.files.length} file{review.files.length !== 1 ? 's' : ''}
        </Text>
        <Text style={{ color: '#86efac', fontSize: 13, fontWeight: '600' }}>
          +{totals.additions}
        </Text>
        <Text style={{ color: '#fca5a5', fontSize: 13, fontWeight: '600' }}>
          -{totals.deletions}
        </Text>
        {review.gitBranch && (
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Ionicons name="git-branch-outline" size={13} color="#71717a" />
            <Text style={{ color: '#71717a', fontSize: 12, marginLeft: 4 }}>
              {review.gitBranch}
            </Text>
          </View>
        )}
        {pendingComments.length > 0 && (
          <View style={{ flexDirection: 'row', alignItems: 'center', marginLeft: 'auto' as never }}>
            <Ionicons name="chatbubble" size={13} color="#f97316" />
            <Text style={{ color: '#f97316', fontSize: 12, marginLeft: 4 }}>
              {pendingComments.length}
            </Text>
          </View>
        )}
      </View>

      {/* File list with diffs */}
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

        {/* Pending comments summary */}
        {pendingComments.length > 0 && (
          <View
            style={{
              marginTop: 8,
              padding: 12,
              backgroundColor: '#18181b',
              borderRadius: 10,
              borderWidth: 1,
              borderColor: '#27272a',
            }}
          >
            <Text style={{ color: '#a1a1aa', fontSize: 12, fontWeight: '600', marginBottom: 8 }}>
              {pendingComments.length} PENDING COMMENT{pendingComments.length !== 1 ? 'S' : ''}
            </Text>
            {pendingComments.map((c) => (
              <View key={c.id} style={{ marginBottom: 6 }}>
                <Text style={{ color: '#71717a', fontSize: 11, fontFamily: 'monospace' }}>
                  {c.filePath || 'General'}
                </Text>
                <Text style={{ color: '#d4d4d8', fontSize: 13 }}>{c.body}</Text>
              </View>
            ))}
          </View>
        )}

        {/* Bottom padding for action bar */}
        <View style={{ height: 100 }} />
      </ScrollView>

      {/* Action Bar — only for pending reviews */}
      {!isDecided && (
        <View
          style={{
            flexDirection: 'row',
            paddingHorizontal: 16,
            paddingVertical: 12,
            paddingBottom: Platform.OS === 'ios' ? 28 : 12,
            backgroundColor: '#0f0f11',
            borderTopWidth: 1,
            borderTopColor: '#18181b',
            gap: 10,
          }}
        >
          <Pressable
            onPress={() => openDecision('rejected')}
            disabled={isSubmitting}
            style={{
              flex: 1,
              paddingVertical: 14,
              borderRadius: 12,
              backgroundColor: 'rgba(239,68,68,0.12)',
              borderWidth: 1,
              borderColor: 'rgba(239,68,68,0.3)',
              alignItems: 'center',
            }}
            accessibilityRole="button"
            accessibilityLabel="Reject changes"
          >
            <Text style={{ color: '#ef4444', fontWeight: '700', fontSize: 14 }}>Reject</Text>
          </Pressable>

          <Pressable
            onPress={() => openDecision('changes_requested')}
            disabled={isSubmitting}
            style={{
              flex: 1,
              paddingVertical: 14,
              borderRadius: 12,
              backgroundColor: 'rgba(234,179,8,0.12)',
              borderWidth: 1,
              borderColor: 'rgba(234,179,8,0.3)',
              alignItems: 'center',
            }}
            accessibilityRole="button"
            accessibilityLabel="Request changes"
          >
            <Text style={{ color: '#eab308', fontWeight: '700', fontSize: 14 }}>
              Request Changes
            </Text>
          </Pressable>

          <Pressable
            onPress={() => openDecision('approved')}
            disabled={isSubmitting}
            style={{
              flex: 1,
              paddingVertical: 14,
              borderRadius: 12,
              backgroundColor: 'rgba(34,197,94,0.12)',
              borderWidth: 1,
              borderColor: 'rgba(34,197,94,0.3)',
              alignItems: 'center',
              flexDirection: 'row',
              justifyContent: 'center',
              gap: 6,
            }}
            accessibilityRole="button"
            accessibilityLabel="Approve changes"
          >
            {isSubmitting ? (
              <ActivityIndicator size="small" color="#22c55e" />
            ) : (
              <>
                <Ionicons name="checkmark" size={16} color="#22c55e" />
                <Text style={{ color: '#22c55e', fontWeight: '700', fontSize: 14 }}>Approve</Text>
              </>
            )}
          </Pressable>
        </View>
      )}

      {/* Decision Confirmation Modal */}
      <Modal
        visible={showDecisionModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowDecisionModal(false)}
        accessibilityViewIsModal
      >
        <View
          style={{
            flex: 1,
            backgroundColor: 'rgba(0,0,0,0.7)',
            justifyContent: 'center',
            paddingHorizontal: 24,
          }}
        >
          <View
            style={{
              backgroundColor: '#18181b',
              borderRadius: 16,
              padding: 20,
            }}
          >
            <Text style={{ color: 'white', fontWeight: '700', fontSize: 17, marginBottom: 4 }}>
              {selectedDecision === 'approved' ? 'Approve Changes?'
               : selectedDecision === 'rejected' ? 'Reject Changes?'
               : 'Request Changes?'}
            </Text>
            <Text style={{ color: '#71717a', fontSize: 14, marginBottom: 16 }}>
              {selectedDecision === 'approved'
                ? 'This will signal the CLI to proceed with applying these changes.'
                : selectedDecision === 'rejected'
                ? 'This will tell the CLI to discard these changes.'
                : 'The CLI will pause and wait for the changes to be revised.'}
            </Text>

            {/* Optional overall comment */}
            <Text style={{ color: '#a1a1aa', fontSize: 13, marginBottom: 6 }}>
              Overall comment (optional)
            </Text>
            <TextInput
              value={overallComment}
              onChangeText={setOverallComment}
              placeholder="Leave a note for the agent..."
              placeholderTextColor="#52525b"
              multiline
              style={{
                backgroundColor: '#27272a',
                color: 'white',
                borderRadius: 10,
                padding: 12,
                fontSize: 14,
                minHeight: 60,
                textAlignVertical: 'top',
                marginBottom: 16,
              }}
              accessibilityLabel="Overall review comment"
            />

            <View style={{ flexDirection: 'row', gap: 10 }}>
              <Pressable
                onPress={() => setShowDecisionModal(false)}
                style={{
                  flex: 1,
                  paddingVertical: 14,
                  borderRadius: 10,
                  backgroundColor: '#27272a',
                  alignItems: 'center',
                }}
                accessibilityRole="button"
                accessibilityLabel="Cancel"
              >
                <Text style={{ color: '#71717a', fontWeight: '600' }}>Cancel</Text>
              </Pressable>

              <Pressable
                onPress={() => void submitDecision()}
                style={{
                  flex: 2,
                  paddingVertical: 14,
                  borderRadius: 10,
                  backgroundColor:
                    selectedDecision === 'approved' ? '#22c55e'
                    : selectedDecision === 'rejected' ? '#ef4444'
                    : '#eab308',
                  alignItems: 'center',
                }}
                accessibilityRole="button"
                accessibilityLabel={`Confirm ${selectedDecision ?? 'decision'}`}
              >
                <Text style={{ color: 'white', fontWeight: '700', fontSize: 15 }}>
                  {selectedDecision === 'approved' ? 'Approve'
                   : selectedDecision === 'rejected' ? 'Reject'
                   : 'Request Changes'}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}
