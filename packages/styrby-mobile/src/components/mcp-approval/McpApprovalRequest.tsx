/**
 * McpApprovalRequest — presentational view for an MCP approval request.
 *
 * Pure render component: receives the loaded request + state from the
 * orchestrator and exposes onApprove/onDeny callbacks. All side effects
 * (fetch, biometric, write) live in {@link useMcpApproval}.
 *
 * @module components/mcp-approval/McpApprovalRequest
 */

import React, { memo, useCallback, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  StyleSheet,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { McpApprovalRequest as McpApprovalRequestModel } from './useMcpApproval';
import type { RiskLevel } from '@/components/approvals/ApprovalRequestCard';

// ============================================================================
// Constants — palette reused from ApprovalRequestCard for visual consistency
// ============================================================================

/**
 * Risk badge colour palette.
 *
 * WHY duplicated rather than imported from ApprovalRequestCard: the legacy
 * card's palette is exported as a private const inside its module. Promoting
 * it to a shared module is out of scope for D-02 (would touch the legacy
 * approval surface area). A targeted dupe with a comment is the safe move;
 * a follow-up cleanup task can extract a shared `risk-palette.ts` module.
 */
const RISK_COLORS: Record<
  RiskLevel,
  { background: string; text: string; label: string }
> = {
  low: { background: '#dcfce7', text: '#15803d', label: 'Low Risk' },
  medium: { background: '#fef9c3', text: '#a16207', label: 'Medium Risk' },
  high: { background: '#fee2e2', text: '#dc2626', label: 'High Risk' },
  critical: { background: '#fde8e9', text: '#991b1b', label: 'Critical' },
};

/**
 * Maximum length for the optional user_message TextInput.
 * Mirrors `MAX_USER_MESSAGE_LENGTH` in services/mcp-approval.ts.
 */
const MAX_NOTE_LENGTH = 280;

// ============================================================================
// Helpers
// ============================================================================

/**
 * Formats a seconds value as "M:SS" for the countdown row.
 *
 * WHY "M:SS" not "Xm Ys": the request expires inside a 5-minute window so
 * the user is reading sub-minute precision frequently. A clock-style display
 * is more legible at a glance than mixed-unit text.
 */
function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * Renders a context blob as a pretty-printed JSON code block.
 *
 * WHY JSON.stringify with no HTML interpolation: React Native Text nodes
 * cannot interpret HTML, so there is no XSS surface — but stringifying
 * defensively also prevents `[object Object]` rendering and prevents
 * accidental rendering of functions or symbols if the metadata is ever
 * tampered with.
 */
function renderContext(context: Record<string, unknown> | null): string {
  if (!context || Object.keys(context).length === 0) return '';
  try {
    return JSON.stringify(context, null, 2);
  } catch {
    return '[unserialisable context]';
  }
}

// ============================================================================
// Component
// ============================================================================

/**
 * Props for {@link McpApprovalRequest}.
 */
export interface McpApprovalRequestProps {
  /** Loaded request data. Component must not render until this resolves. */
  request: McpApprovalRequestModel;
  /** True while the decision write is in-flight. Disables both buttons. */
  isSubmitting: boolean;
  /** Submission error message; rendered inline above the buttons. */
  submitError: string | null;
  /** Seconds remaining before the CLI poll loop times out. */
  secondsRemaining: number;
  /** Approve callback; receives the optional user note. */
  onApprove: (userMessage: string) => void;
  /** Deny callback; receives the optional user note. */
  onDeny: (userMessage: string) => void;
}

/**
 * Renders the MCP approval request screen body.
 */
export const McpApprovalRequest = memo(function McpApprovalRequest({
  request,
  isSubmitting,
  submitError,
  secondsRemaining,
  onApprove,
  onDeny,
}: McpApprovalRequestProps) {
  const [note, setNote] = useState('');

  const riskConfig = RISK_COLORS[request.risk] ?? RISK_COLORS.medium;
  const machineDisplay = request.machineId.slice(0, 8);
  const contextBlock = renderContext(request.context);
  const expired = secondsRemaining <= 0;
  const buttonsDisabled = isSubmitting || expired;

  const handleApprove = useCallback(() => {
    if (!buttonsDisabled) onApprove(note);
  }, [buttonsDisabled, note, onApprove]);

  const handleDeny = useCallback(() => {
    if (!buttonsDisabled) onDeny(note);
  }, [buttonsDisabled, note, onDeny]);

  return (
    <ScrollView contentContainerStyle={styles.container}>
      {/* ── Header ───────────────────────────────────────────────────────── */}
      <Text style={styles.title}>Approval requested</Text>
      <Text style={styles.subtitle}>From machine {machineDisplay}…</Text>

      {/* ── Action chip + risk badge ─────────────────────────────────────── */}
      <View style={styles.headerRow}>
        <View style={styles.actionChip}>
          <Ionicons name="terminal-outline" size={18} color="#374151" />
          <Text style={styles.actionText}>{request.requestedAction}</Text>
        </View>
        <View style={[styles.riskBadge, { backgroundColor: riskConfig.background }]}>
          <Text style={[styles.riskLabel, { color: riskConfig.text }]}>
            {riskConfig.label}
          </Text>
        </View>
      </View>

      {/* ── Reason ───────────────────────────────────────────────────────── */}
      <Text style={styles.sectionLabel}>Reason</Text>
      <Text style={styles.reasonText}>{request.reason}</Text>

      {/* ── Context preview ──────────────────────────────────────────────── */}
      {contextBlock.length > 0 && (
        <>
          <Text style={styles.sectionLabel}>Context</Text>
          <ScrollView
            style={styles.contextBlock}
            horizontal
            accessibilityLabel="Approval request context payload"
          >
            <Text style={styles.contextText}>{contextBlock}</Text>
          </ScrollView>
        </>
      )}

      {/* ── Optional message ─────────────────────────────────────────────── */}
      <Text style={styles.sectionLabel}>Add a note (optional)</Text>
      <TextInput
        style={styles.noteInput}
        value={note}
        onChangeText={setNote}
        placeholder="Visible in the audit log"
        placeholderTextColor="#9ca3af"
        maxLength={MAX_NOTE_LENGTH}
        multiline
        accessibilityLabel="Optional note to attach to the approval decision"
      />

      {/* ── Countdown ────────────────────────────────────────────────────── */}
      <Text
        style={[
          styles.countdown,
          expired && styles.countdownExpired,
          !expired && secondsRemaining < 30 && styles.countdownUrgent,
        ]}
        accessibilityLabel={
          expired
            ? 'Approval request has expired'
            : `Approval expires in ${formatCountdown(secondsRemaining)}`
        }
      >
        {expired
          ? 'This request has expired'
          : `Expires in ${formatCountdown(secondsRemaining)}`}
      </Text>

      {/* ── Submission error banner ──────────────────────────────────────── */}
      {submitError && (
        <View style={styles.errorBanner}>
          <Ionicons name="alert-circle-outline" size={14} color="#dc2626" />
          <Text style={styles.errorText}>{submitError}</Text>
        </View>
      )}

      {/* ── Actions ──────────────────────────────────────────────────────── */}
      <View style={styles.buttonRow}>
        <TouchableOpacity
          style={[styles.button, styles.denyButton, buttonsDisabled && styles.buttonDisabled]}
          onPress={handleDeny}
          disabled={buttonsDisabled}
          accessibilityRole="button"
          accessibilityLabel="Deny this MCP approval request"
        >
          {isSubmitting ? (
            <ActivityIndicator size="small" color="#dc2626" />
          ) : (
            <>
              <Ionicons name="close-circle-outline" size={16} color="#dc2626" />
              <Text style={styles.denyText}>Deny</Text>
            </>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.button, styles.approveButton, buttonsDisabled && styles.buttonDisabled]}
          onPress={handleApprove}
          disabled={buttonsDisabled}
          accessibilityRole="button"
          accessibilityLabel="Approve this MCP approval request"
        >
          {isSubmitting ? (
            <ActivityIndicator size="small" color="#ffffff" />
          ) : (
            <>
              <Ionicons name="checkmark-circle-outline" size={16} color="#ffffff" />
              <Text style={styles.approveText}>Approve</Text>
            </>
          )}
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
});

// ============================================================================
// Styles
// ============================================================================

const styles = StyleSheet.create({
  container: {
    padding: 20,
    backgroundColor: '#0a0a0a',
    flexGrow: 1,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: '#f5f5f5',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 13,
    color: '#9ca3af',
    marginBottom: 20,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 18,
  },
  actionChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#1f2937',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  actionText: {
    fontSize: 18,
    fontWeight: '700',
    color: '#f5f5f5',
  },
  riskBadge: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
  },
  riskLabel: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: '#9ca3af',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 16,
    marginBottom: 6,
  },
  reasonText: {
    fontSize: 15,
    color: '#e5e7eb',
    lineHeight: 22,
  },
  contextBlock: {
    backgroundColor: '#111827',
    borderRadius: 8,
    padding: 12,
    borderWidth: 1,
    borderColor: '#1f2937',
    maxHeight: 200,
  },
  contextText: {
    fontFamily: 'monospace',
    fontSize: 12,
    color: '#d1d5db',
    lineHeight: 18,
  },
  noteInput: {
    backgroundColor: '#111827',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#1f2937',
    color: '#f5f5f5',
    padding: 12,
    fontSize: 14,
    minHeight: 60,
    textAlignVertical: 'top',
  },
  countdown: {
    fontSize: 13,
    color: '#9ca3af',
    marginTop: 16,
    textAlign: 'center',
  },
  countdownUrgent: {
    color: '#f59e0b',
    fontWeight: '600',
  },
  countdownExpired: {
    color: '#ef4444',
    fontWeight: '600',
  },
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#7f1d1d',
    borderRadius: 8,
    padding: 10,
    marginTop: 12,
  },
  errorText: {
    fontSize: 13,
    color: '#fecaca',
    flex: 1,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 20,
  },
  button: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    borderRadius: 10,
    gap: 8,
  },
  buttonDisabled: {
    opacity: 0.55,
  },
  denyButton: {
    backgroundColor: '#1f2937',
    borderWidth: 1,
    borderColor: '#7f1d1d',
  },
  denyText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#fca5a5',
  },
  approveButton: {
    backgroundColor: '#16a34a',
  },
  approveText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#ffffff',
  },
});
