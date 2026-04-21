/**
 * DecisionModal — Confirmation dialog for the chosen review decision.
 *
 * Captures an optional "overall comment" alongside the per-file comments
 * already collected, then triggers the parent's submit handler.
 *
 * @module components/review/DecisionModal
 */

import React from 'react';
import { View, Text, Pressable, TextInput, Modal } from 'react-native';
import { COLOR_MUTED, COLOR_PLACEHOLDER, COLOR_SURFACE, STATUS_COLOR } from './constants';
import type { CodeReviewStatus, DecisionModalProps } from '@/types/review';

/**
 * Returns the modal title for a given decision.
 *
 * @param decision - Selected decision (or null when modal is closed)
 * @returns Title string for the modal heading
 */
function titleFor(decision: CodeReviewStatus | null): string {
  if (decision === 'approved') return 'Approve Changes?';
  if (decision === 'rejected') return 'Reject Changes?';
  return 'Request Changes?';
}

/**
 * Returns the explanatory body text for a given decision.
 *
 * @param decision - Selected decision (or null when modal is closed)
 * @returns Description string explaining what the decision does
 */
function bodyFor(decision: CodeReviewStatus | null): string {
  if (decision === 'approved') {
    return 'This will signal the CLI to proceed with applying these changes.';
  }
  if (decision === 'rejected') {
    return 'This will tell the CLI to discard these changes.';
  }
  return 'The CLI will pause and wait for the changes to be revised.';
}

/**
 * Returns the confirm-button label for a given decision.
 *
 * @param decision - Selected decision (or null when modal is closed)
 * @returns Action label rendered on the confirm button
 */
function confirmLabelFor(decision: CodeReviewStatus | null): string {
  if (decision === 'approved') return 'Approve';
  if (decision === 'rejected') return 'Reject';
  return 'Request Changes';
}

/**
 * Modal sheet that confirms the reviewer's decision and collects an optional
 * overall comment for the agent.
 *
 * @param props - See `DecisionModalProps`
 * @returns React element
 */
export function DecisionModal({
  visible,
  selectedDecision,
  overallComment,
  onOverallCommentChange,
  onCancel,
  onConfirm,
}: DecisionModalProps) {
  // WHY: STATUS_COLOR is keyed on non-pending statuses only, fall back to the
  // approved color when the modal is opened without a decision (defensive — in
  // practice `selectedDecision` is always set before `visible` flips to true).
  const confirmColor =
    selectedDecision && selectedDecision !== 'pending'
      ? STATUS_COLOR[selectedDecision]
      : STATUS_COLOR.approved;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onCancel}
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
            backgroundColor: COLOR_SURFACE,
            borderRadius: 16,
            padding: 20,
          }}
        >
          <Text style={{ color: 'white', fontWeight: '700', fontSize: 17, marginBottom: 4 }}>
            {titleFor(selectedDecision)}
          </Text>
          <Text style={{ color: COLOR_MUTED, fontSize: 14, marginBottom: 16 }}>
            {bodyFor(selectedDecision)}
          </Text>

          <Text style={{ color: '#a1a1aa', fontSize: 13, marginBottom: 6 }}>
            Overall comment (optional)
          </Text>
          <TextInput
            value={overallComment}
            onChangeText={onOverallCommentChange}
            placeholder="Leave a note for the agent..."
            placeholderTextColor={COLOR_PLACEHOLDER}
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
              onPress={onCancel}
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
              <Text style={{ color: COLOR_MUTED, fontWeight: '600' }}>Cancel</Text>
            </Pressable>

            <Pressable
              onPress={onConfirm}
              style={{
                flex: 2,
                paddingVertical: 14,
                borderRadius: 10,
                backgroundColor: confirmColor,
                alignItems: 'center',
              }}
              accessibilityRole="button"
              accessibilityLabel={`Confirm ${selectedDecision ?? 'decision'}`}
            >
              <Text style={{ color: 'white', fontWeight: '700', fontSize: 15 }}>
                {confirmLabelFor(selectedDecision)}
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}
