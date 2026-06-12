/**
 * DayDetailModal — bottom-sheet detail view for a tapped heatmap cell.
 *
 * Extracted from ActivityGraph.tsx (Cluster A2 split). Pure presentational:
 * given a day + visibility, it renders the stats sheet. All data lives in the
 * parent.
 *
 * @module components/activity-graph/DayDetailModal
 */

import React from 'react';
import { View, Text, Modal, Pressable, TouchableOpacity } from 'react-native';
import type { ActivityDay } from 'styrby-shared';
import { formatTokens } from './activity-grid';
import { styles } from './styles';

/** Props for the DayDetailModal. */
export interface DayDetailModalProps {
  /** The day whose stats to show, or null when nothing is selected. */
  day: ActivityDay | null;
  /** Whether the sheet is visible. */
  visible: boolean;
  /** Dismiss handler. */
  onClose: () => void;
}

/**
 * Bottom-sheet style modal showing detailed stats for a tapped heatmap cell.
 *
 * @param props - Modal visibility state and day data.
 * @returns The detail sheet, or null when no day is selected.
 */
export function DayDetailModal({ day, visible, onClose }: DayDetailModalProps) {
  if (!day) return null;

  const date = new Date(day.date + 'T12:00:00');
  const formatted = date.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.modalOverlay} onPress={onClose}>
        <View style={styles.modalSheet}>
          {/* Handle bar */}
          <View style={styles.modalHandle} />

          <Text style={styles.modalDate}>{formatted}</Text>

          {day.sessionCount === 0 ? (
            <Text style={styles.modalNoActivity}>No activity on this day</Text>
          ) : (
            <View style={styles.modalStats}>
              <View style={styles.modalStatRow}>
                <Text style={styles.modalStatLabel}>Sessions</Text>
                <Text style={styles.modalStatValue}>{day.sessionCount}</Text>
              </View>
              <View style={styles.modalStatRow}>
                <Text style={styles.modalStatLabel}>Total Cost</Text>
                <Text style={styles.modalStatValue}>${day.totalCostUsd.toFixed(4)}</Text>
              </View>
              {day.totalTokens > 0 && (
                <View style={styles.modalStatRow}>
                  <Text style={styles.modalStatLabel}>Tokens</Text>
                  <Text style={styles.modalStatValue}>{formatTokens(day.totalTokens)}</Text>
                </View>
              )}
              {day.agents.length > 0 && (
                <View style={styles.modalStatRow}>
                  <Text style={styles.modalStatLabel}>Agents</Text>
                  <Text style={styles.modalStatValue}>{day.agents.join(', ')}</Text>
                </View>
              )}
            </View>
          )}

          <TouchableOpacity style={styles.modalCloseBtn} onPress={onClose} accessibilityRole="button">
            <Text style={styles.modalCloseBtnText}>Close</Text>
          </TouchableOpacity>
        </View>
      </Pressable>
    </Modal>
  );
}
