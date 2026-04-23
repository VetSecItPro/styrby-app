/**
 * ApprovalRequestCard — Mobile approval action UI (Phase 2.4)
 *
 * Renders a pending tool-call approval request from the CLI.  Approvers see:
 *   - Tool name, risk level badge, estimated cost
 *   - Request payload preview (command / arguments)
 *   - Time remaining before the request expires
 *   - "Approve" and "Deny" action buttons
 *   - "View details" link (opens `ApprovalDetailScreen`)
 *
 * This component is rendered in two contexts:
 *   1. The `approvals/` tab (full card in a list of pending requests).
 *   2. As a deep-linked screen when the user taps the push notification
 *      with action buttons "Approve / Deny / View diff" that was sent by
 *      the `resolve-approval` edge function in Phase 2.4.
 *
 * WHY this is a presentational component (no fetch calls):
 *   State management (fetch, optimistic updates, error handling) lives in
 *   `useApprovalActions` (co-located hook). Separating concerns lets us test
 *   the UI rendering without mocking network calls, and lets the same card
 *   render from different data sources (Realtime subscription, push payload).
 *
 * @module components/approvals/ApprovalRequestCard
 */

import React, { memo, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

// ============================================================================
// Types
// ============================================================================

/**
 * Risk classification as returned by the CLI policyEngine.
 * Drives the badge colour on the card.
 */
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

/**
 * Approval request data shape passed to the card.
 *
 * Matches the response from `GET /api/approval/[id]` with camelCase fields.
 */
export interface ApprovalRequest {
  /** UUID of the approval row. */
  id: string;
  /** Team the approval belongs to. */
  teamId: string;
  /** Tool name requested by the CLI (e.g. "Bash", "Edit"). */
  toolName: string;
  /** Estimated USD cost of the tool call, or null if unknown. */
  estimatedCostUsd: number | null;
  /** Raw request payload from the CLI — shown as a JSON preview. */
  requestPayload: Record<string, unknown>;
  /** Current lifecycle status. Card is only shown for 'pending' status. */
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled';
  /** Requester's user ID (not the display name — resolved by parent). */
  requesterUserId: string;
  /** Human-readable display name of the requester (resolved by parent). */
  requesterDisplayName?: string;
  /** Risk level derived from the policyEngine at submit time. */
  riskLevel?: RiskLevel;
  /** ISO 8601 expiry timestamp. After this the row becomes 'expired'. */
  expiresAt: string;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
}

/**
 * Callbacks provided by the parent (orchestrator or screen).
 */
export interface ApprovalRequestCardCallbacks {
  /**
   * Called when the approver taps "Approve" or "Deny".
   * The parent (useApprovalActions hook) handles the API call.
   *
   * @param approvalId - The approval row UUID.
   * @param vote - The approver's decision.
   */
  onVote: (approvalId: string, vote: 'approved' | 'denied') => void;

  /**
   * Called when the user taps "View details". Navigates to the detail screen.
   *
   * @param approvalId - The approval row UUID to open.
   */
  onViewDetails: (approvalId: string) => void;
}

/** Props for {@link ApprovalRequestCard}. */
export interface ApprovalRequestCardProps extends ApprovalRequestCardCallbacks {
  /** The approval request to render. */
  approval: ApprovalRequest;
  /** True while a vote API call is in-flight (disables both buttons). */
  isVoting?: boolean;
  /** Error message from a failed vote (rendered below the buttons). */
  voteError?: string | null;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Colour palette for risk level badges.
 *
 * WHY defined as a constant object rather than inline:
 *   Avoids repeated object creation during render. This map is read-only
 *   and shared across all card instances.
 */
const RISK_COLORS: Record<RiskLevel, { background: string; text: string; label: string }> = {
  low: { background: '#dcfce7', text: '#15803d', label: 'Low Risk' },
  medium: { background: '#fef9c3', text: '#a16207', label: 'Medium Risk' },
  high: { background: '#fee2e2', text: '#dc2626', label: 'High Risk' },
  critical: { background: '#fde8e9', text: '#991b1b', label: 'Critical' },
};

// ============================================================================
// Helpers
// ============================================================================

/**
 * Formats an ISO 8601 expiry timestamp into a human-readable countdown.
 *
 * Returns null if the request has already expired.
 *
 * WHY we compute this on each render rather than using a timer:
 *   The card list auto-refreshes via Supabase Realtime; stale data is evicted
 *   by the parent subscription. Computing inline keeps the component stateless
 *   and avoids timer leaks when cards unmount.
 *
 * @param expiresAt - ISO 8601 expiry timestamp.
 * @returns Human-readable string like "8m remaining", "< 1m", or null if expired.
 */
function formatTimeRemaining(expiresAt: string): string | null {
  const msRemaining = new Date(expiresAt).getTime() - Date.now();
  if (msRemaining <= 0) return null;

  const minutesRemaining = Math.floor(msRemaining / 60_000);
  if (minutesRemaining < 1) return '< 1m remaining';
  if (minutesRemaining < 60) return `${minutesRemaining}m remaining`;

  const hoursRemaining = Math.floor(minutesRemaining / 60);
  return `${hoursRemaining}h ${minutesRemaining % 60}m remaining`;
}

/**
 * Extracts a preview string from the request payload.
 *
 * Shows the most relevant field for the tool type:
 *   - `command` or `cmd` — Bash/shell execution
 *   - `path` or `file_path` — file operations
 *   - falls back to the first string value, or "(no preview)"
 *
 * @param payload - Raw request payload from the CLI.
 * @returns One-line preview string (truncated to 120 chars).
 */
function extractPayloadPreview(payload: Record<string, unknown>): string {
  const candidates = ['command', 'cmd', 'path', 'file_path', 'message', 'query'];
  for (const key of candidates) {
    if (typeof payload[key] === 'string') {
      const value = payload[key] as string;
      return value.length > 120 ? `${value.slice(0, 117)}...` : value;
    }
  }

  // Fallback: first string value in the object
  for (const value of Object.values(payload)) {
    if (typeof value === 'string' && value.length > 0) {
      return value.length > 120 ? `${value.slice(0, 117)}...` : value;
    }
  }

  return '(no preview available)';
}

// ============================================================================
// Component
// ============================================================================

/**
 * ApprovalRequestCard
 *
 * Presentational card component for a single pending approval request.
 * All side-effectful operations (network calls) are delegated to callbacks.
 *
 * @param props - See {@link ApprovalRequestCardProps}.
 */
export const ApprovalRequestCard = memo(function ApprovalRequestCard({
  approval,
  isVoting = false,
  voteError,
  onVote,
  onViewDetails,
}: ApprovalRequestCardProps) {
  const timeRemaining = formatTimeRemaining(approval.expiresAt);
  const riskConfig = RISK_COLORS[approval.riskLevel ?? 'medium'];
  const payloadPreview = extractPayloadPreview(approval.requestPayload);

  const handleApprove = useCallback(() => {
    if (!isVoting) onVote(approval.id, 'approved');
  }, [approval.id, isVoting, onVote]);

  const handleDeny = useCallback(() => {
    if (!isVoting) onVote(approval.id, 'denied');
  }, [approval.id, isVoting, onVote]);

  const handleViewDetails = useCallback(() => {
    onViewDetails(approval.id);
  }, [approval.id, onViewDetails]);

  return (
    <View style={styles.card}>
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <View style={styles.header}>
        <View style={styles.toolInfo}>
          <Ionicons name="terminal-outline" size={18} color="#374151" />
          <Text style={styles.toolName}>{approval.toolName}</Text>
        </View>

        {/* Risk badge */}
        <View style={[styles.riskBadge, { backgroundColor: riskConfig.background }]}>
          <Text style={[styles.riskLabel, { color: riskConfig.text }]}>
            {riskConfig.label}
          </Text>
        </View>
      </View>

      {/* ── Requester ──────────────────────────────────────────────────── */}
      <Text style={styles.requester}>
        Requested by{' '}
        <Text style={styles.requesterName}>
          {approval.requesterDisplayName ?? approval.requesterUserId.slice(0, 8) + '…'}
        </Text>
      </Text>

      {/* ── Payload preview ────────────────────────────────────────────── */}
      <View style={styles.payloadPreview}>
        <Text style={styles.payloadText} numberOfLines={2}>
          {payloadPreview}
        </Text>
      </View>

      {/* ── Meta row (cost + expiry) ────────────────────────────────────── */}
      <View style={styles.metaRow}>
        {approval.estimatedCostUsd !== null && (
          <Text style={styles.metaText}>
            ~${approval.estimatedCostUsd.toFixed(4)}
          </Text>
        )}

        {timeRemaining !== null ? (
          <Text style={[styles.metaText, timeRemaining.startsWith('<') && styles.urgentText]}>
            {timeRemaining}
          </Text>
        ) : (
          <Text style={[styles.metaText, styles.expiredText]}>Expired</Text>
        )}
      </View>

      {/* ── Vote error ─────────────────────────────────────────────────── */}
      {voteError && (
        <View style={styles.errorBanner}>
          <Ionicons name="alert-circle-outline" size={14} color="#dc2626" />
          <Text style={styles.errorText}>{voteError}</Text>
        </View>
      )}

      {/* ── Action buttons ─────────────────────────────────────────────── */}
      <View style={styles.buttonRow}>
        {/* Deny button */}
        <TouchableOpacity
          style={[styles.button, styles.denyButton, isVoting && styles.buttonDisabled]}
          onPress={handleDeny}
          disabled={isVoting || timeRemaining === null}
          accessibilityLabel="Deny this tool call approval request"
          accessibilityRole="button"
        >
          {isVoting ? (
            <ActivityIndicator size="small" color="#dc2626" />
          ) : (
            <>
              <Ionicons name="close-circle-outline" size={16} color="#dc2626" />
              <Text style={styles.denyText}>Deny</Text>
            </>
          )}
        </TouchableOpacity>

        {/* Approve button */}
        <TouchableOpacity
          style={[styles.button, styles.approveButton, isVoting && styles.buttonDisabled]}
          onPress={handleApprove}
          disabled={isVoting || timeRemaining === null}
          accessibilityLabel="Approve this tool call approval request"
          accessibilityRole="button"
        >
          {isVoting ? (
            <ActivityIndicator size="small" color="#ffffff" />
          ) : (
            <>
              <Ionicons name="checkmark-circle-outline" size={16} color="#ffffff" />
              <Text style={styles.approveText}>Approve</Text>
            </>
          )}
        </TouchableOpacity>
      </View>

      {/* ── View details link ─────────────────────────────────────────── */}
      <TouchableOpacity
        style={styles.detailsLink}
        onPress={handleViewDetails}
        accessibilityLabel="View full approval request details"
        accessibilityRole="link"
      >
        <Ionicons name="open-outline" size={13} color="#6b7280" />
        <Text style={styles.detailsText}>View details</Text>
      </TouchableOpacity>
    </View>
  );
});

// ============================================================================
// Styles
// ============================================================================

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    // Subtle elevation to distinguish from background
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
    borderWidth: 1,
    borderColor: '#f3f4f6',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  toolInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  toolName: {
    fontSize: 15,
    fontWeight: '600',
    color: '#111827',
  },
  riskBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  riskLabel: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.2,
  },
  requester: {
    fontSize: 13,
    color: '#6b7280',
    marginBottom: 8,
  },
  requesterName: {
    fontWeight: '600',
    color: '#374151',
  },
  payloadPreview: {
    backgroundColor: '#f9fafb',
    borderRadius: 6,
    padding: 10,
    marginBottom: 10,
    borderLeftWidth: 3,
    borderLeftColor: '#e5e7eb',
  },
  payloadText: {
    fontFamily: 'monospace',
    fontSize: 12,
    color: '#374151',
    lineHeight: 18,
  },
  metaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  metaText: {
    fontSize: 12,
    color: '#9ca3af',
  },
  urgentText: {
    color: '#f59e0b',
    fontWeight: '600',
  },
  expiredText: {
    color: '#ef4444',
    fontWeight: '600',
  },
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#fef2f2',
    borderRadius: 6,
    padding: 8,
    marginBottom: 10,
  },
  errorText: {
    fontSize: 12,
    color: '#dc2626',
    flex: 1,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 10,
  },
  button: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    borderRadius: 8,
    gap: 6,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  denyButton: {
    backgroundColor: '#fef2f2',
    borderWidth: 1,
    borderColor: '#fecaca',
  },
  denyText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#dc2626',
  },
  approveButton: {
    backgroundColor: '#16a34a',
  },
  approveText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#ffffff',
  },
  detailsLink: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: 4,
  },
  detailsText: {
    fontSize: 12,
    color: '#6b7280',
  },
});
