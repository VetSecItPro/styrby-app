/**
 * McpApprovalEventRow — audit-event renderer for the dashboard feed.
 *
 * Renders a single MCP-approval-lifecycle audit_log row in the dashboard's
 * notification stream. Three states are supported:
 *
 *   - `mcp_approval_requested` (still pending) → "Pending approval — bash"
 *     with a Review button that deep-links to the MCP approval screen.
 *   - `mcp_approval_decided` → "Approved bash" or "Denied bash" with the
 *     decision timestamp.
 *   - `mcp_approval_timeout` → "Approval expired — bash".
 *
 * Pulled into its own component to keep the dashboard renderer thin and so
 * the row can be unit-tested without mounting the full dashboard tree.
 *
 * @module components/audit/McpApprovalEventRow
 */

import React, { memo, useCallback } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

// ============================================================================
// Types
// ============================================================================

/**
 * Lifecycle phase encoded by the audit_log.action enum value.
 *
 * WHY string union (not enum): enums require value imports across files;
 * using string literals matches the audit_action Postgres enum exactly and
 * keeps the type narrow at every call site.
 */
export type McpApprovalEventKind =
  | 'mcp_approval_requested'
  | 'mcp_approval_decided'
  | 'mcp_approval_timeout';

/**
 * Props for {@link McpApprovalEventRow}.
 */
export interface McpApprovalEventRowProps {
  /** Lifecycle phase of this row. */
  kind: McpApprovalEventKind;
  /** Approval row UUID, used for deep-linking the Review button. */
  approvalId: string;
  /**
   * Display label for the MCP tool action (e.g. "bash", "edit").
   * Pulled from `audit_log.metadata.requested_action` upstream.
   */
  requestedAction: string;
  /**
   * For decided rows only — the user's binary verdict.
   * Read from `audit_log.metadata.decision`.
   */
  decision?: 'approved' | 'denied';
  /** ISO 8601 timestamp from audit_log.created_at. */
  timestamp: string;
  /**
   * True when this is a `requested` row that has NOT yet been resolved by
   * a matching `decided` or `timeout` row. Drives the Review button.
   */
  isPending?: boolean;
  /**
   * Called when the user taps the Review button on a pending row.
   * The orchestrator handles navigation so this component stays presentational.
   */
  onReview?: (approvalId: string) => void;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Picks the icon + colour for the row based on kind/decision/pending state.
 *
 * WHY a single function instead of inline branches: keeps the JSX focused
 * on layout and lets the visual mapping be tested independently if we ever
 * extract a snapshot test for the row.
 */
function pickVisual(
  kind: McpApprovalEventKind,
  decision: 'approved' | 'denied' | undefined,
  isPending: boolean,
): {
  icon: keyof typeof Ionicons.glyphMap;
  color: string;
  label: (action: string) => string;
} {
  if (kind === 'mcp_approval_requested' && isPending) {
    return {
      icon: 'lock-closed',
      color: '#f59e0b',
      label: (action) => `Pending approval - ${action}`,
    };
  }
  if (kind === 'mcp_approval_decided' && decision === 'approved') {
    return {
      icon: 'checkmark-circle',
      color: '#22c55e',
      label: (action) => `Approved ${action}`,
    };
  }
  if (kind === 'mcp_approval_decided' && decision === 'denied') {
    return {
      icon: 'close-circle',
      color: '#ef4444',
      label: (action) => `Denied ${action}`,
    };
  }
  if (kind === 'mcp_approval_timeout') {
    return {
      icon: 'time-outline',
      color: '#9ca3af',
      label: (action) => `Approval expired - ${action}`,
    };
  }
  // Resolved request row (paired with a later decided/timeout row).
  return {
    icon: 'shield-checkmark-outline',
    color: '#9ca3af',
    label: (action) => `Approval handled - ${action}`,
  };
}

// ============================================================================
// Component
// ============================================================================

/**
 * Single MCP approval lifecycle event row.
 */
export const McpApprovalEventRow = memo(function McpApprovalEventRow({
  kind,
  approvalId,
  requestedAction,
  decision,
  timestamp,
  isPending = false,
  onReview,
}: McpApprovalEventRowProps) {
  const visual = pickVisual(kind, decision, isPending);

  const handleReview = useCallback(() => {
    onReview?.(approvalId);
  }, [approvalId, onReview]);

  const showReviewButton = isPending && kind === 'mcp_approval_requested';

  return (
    <View style={styles.row} accessibilityRole="summary">
      <Ionicons name={visual.icon} size={18} color={visual.color} />
      <View style={styles.body}>
        <Text style={styles.label} numberOfLines={1}>
          {visual.label(requestedAction)}
        </Text>
        <Text style={styles.timestamp}>{new Date(timestamp).toLocaleTimeString()}</Text>
      </View>
      {showReviewButton && onReview && (
        <TouchableOpacity
          style={styles.reviewButton}
          onPress={handleReview}
          accessibilityRole="button"
          accessibilityLabel={`Review pending MCP approval for ${requestedAction}`}
        >
          <Text style={styles.reviewText}>Review</Text>
        </TouchableOpacity>
      )}
    </View>
  );
});

// ============================================================================
// Styles
// ============================================================================

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  body: {
    flex: 1,
  },
  label: {
    fontSize: 14,
    color: '#e5e7eb',
    fontWeight: '600',
  },
  timestamp: {
    fontSize: 11,
    color: '#9ca3af',
    marginTop: 2,
  },
  reviewButton: {
    backgroundColor: '#f97316',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
  },
  reviewText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '700',
  },
});
