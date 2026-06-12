/**
 * ActivityGraph Component (Mobile)
 *
 * Horizontal-scrollable heatmap showing 12 weeks of coding activity
 * (scrollable back to 52 weeks). Each cell represents one calendar day,
 * colored by activity intensity (0-4). Tapping a cell opens a bottom sheet
 * with detailed stats for that day.
 *
 * Data is fetched from Supabase and grouped by date client-side using the same
 * intensity bucketing algorithm as the web version, so both surfaces match.
 *
 * Orchestrator only (Cluster A2 split): data lives in `useActivityData`, grid
 * math in `activity-grid`, the detail sheet in `DayDetailModal`, and styling in
 * `activity-graph/styles`. This file wires them together.
 *
 * @module components/ActivityGraph
 */

import React, { useState, useCallback } from 'react';
import { View, Text, ScrollView, Pressable, ActivityIndicator } from 'react-native';
import type { ActivityDay } from 'styrby-shared';
import {
  CELL_STRIDE,
  MONTH_LABELS,
  SESSION_COLORS,
  COST_COLORS,
  type ActivityMode,
} from './activity-graph/constants';
import { toDateStr, buildGrid, gridToColumns } from './activity-graph/activity-grid';
import { useActivityData } from './activity-graph/useActivityData';
import { DayDetailModal } from './activity-graph/DayDetailModal';
import { styles } from './activity-graph/styles';

/** Props for the ActivityGraph component. */
export interface ActivityGraphProps {
  /** Whether to show a section title above the graph. Default: true. */
  showTitle?: boolean;
}

/**
 * Horizontal-scrollable heatmap showing coding session activity.
 *
 * Renders the last 12 weeks by default; the user can scroll left to see up to
 * 52 weeks of history. Tapping a cell shows a detail modal with session count,
 * cost, token count, and agents used.
 *
 * @param props - Component props.
 * @returns The activity heatmap component.
 *
 * @example
 * // Add to the dashboard home tab
 * <ActivityGraph showTitle />
 */
export function ActivityGraph({ showTitle = true }: ActivityGraphProps) {
  const [mode, setMode] = useState<ActivityMode>('sessions');
  const [selectedDay, setSelectedDay] = useState<ActivityDay | null>(null);
  const [modalVisible, setModalVisible] = useState(false);

  const { rawData, isLoading } = useActivityData();

  // ── Derived layout + summary stats ──────────────────────────────────────────
  const grid = buildGrid(rawData, mode);
  const columns = gridToColumns(grid);
  const totalSessions = Array.from(rawData.values()).reduce((sum, d) => sum + d.sessionCount, 0);
  const activeDays = Array.from(rawData.values()).filter((d) => d.sessionCount > 0).length;

  // ── Handlers ─────────────────────────────────────────────────────────────────
  const handleCellPress = useCallback((day: ActivityDay) => {
    setSelectedDay(day);
    setModalVisible(true);
  }, []);

  const handleModalClose = useCallback(() => {
    setModalVisible(false);
  }, []);

  // ── Render ───────────────────────────────────────────────────────────────────
  const colors = mode === 'sessions' ? SESSION_COLORS : COST_COLORS;
  const today = toDateStr(new Date());

  if (isLoading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="small" color="#71717a" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Header */}
      {showTitle && (
        <View style={styles.header}>
          <Text style={styles.title}>Activity</Text>
          <Text style={styles.subtitle}>
            {totalSessions} sessions · {activeDays} active days
          </Text>
        </View>
      )}

      {/* Mode toggle */}
      <View style={styles.toggleRow}>
        <Pressable
          style={[styles.toggleBtn, mode === 'sessions' && styles.toggleBtnActive]}
          onPress={() => setMode('sessions')}
          accessibilityRole="button"
        >
          <Text style={[styles.toggleBtnText, mode === 'sessions' && styles.toggleBtnTextActive]}>
            Sessions
          </Text>
        </Pressable>
        <Pressable
          style={[styles.toggleBtn, mode === 'cost' && styles.toggleBtnActive]}
          onPress={() => setMode('cost')}
          accessibilityRole="button"
        >
          <Text style={[styles.toggleBtnText, mode === 'cost' && styles.toggleBtnTextActive]}>
            Cost
          </Text>
        </Pressable>
      </View>

      {/* Scrollable heatmap — recent weeks on the right */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
        ref={(ref) => {
          if (ref) {
            // Scroll to the most recent (rightmost) content on initial render.
            setTimeout(() => ref.scrollToEnd({ animated: false }), 0);
          }
        }}
      >
        <View>
          {/* Month labels above columns */}
          <View style={styles.monthRow}>
            {columns.map((week, colIndex) => {
              const firstDay = week[0];
              if (!firstDay) return <View key={colIndex} style={{ width: CELL_STRIDE }} />;
              const month = new Date(firstDay.date + 'T12:00:00').getMonth();
              const prevWeek = columns[colIndex - 1];
              const prevMonth = prevWeek?.[0]
                ? new Date(prevWeek[0].date + 'T12:00:00').getMonth()
                : -1;

              return (
                <View key={colIndex} style={{ width: CELL_STRIDE }}>
                  {month !== prevMonth && <Text style={styles.monthLabel}>{MONTH_LABELS[month]}</Text>}
                </View>
              );
            })}
          </View>

          {/* Cell grid */}
          <View style={styles.gridRow}>
            {columns.map((week, colIndex) => (
              <View key={colIndex} style={styles.weekColumn}>
                {week.map((day, rowIndex) => {
                  const isFuture = day.date > today;
                  return (
                    <Pressable
                      key={`${colIndex}-${rowIndex}`}
                      onPress={() => !isFuture && handleCellPress(day)}
                      style={[
                        styles.cell,
                        { backgroundColor: isFuture ? 'transparent' : colors[day.intensity] },
                      ]}
                      accessibilityLabel={
                        isFuture
                          ? undefined
                          : `${day.date}: ${day.sessionCount} sessions, $${day.totalCostUsd.toFixed(2)}`
                      }
                    />
                  );
                })}
              </View>
            ))}
          </View>
        </View>
      </ScrollView>

      {/* Legend */}
      <View style={styles.legendRow}>
        <Text style={styles.legendLabel}>Less</Text>
        {([0, 1, 2, 3, 4] as const).map((level) => (
          <View key={level} style={[styles.legendCell, { backgroundColor: colors[level] }]} />
        ))}
        <Text style={styles.legendLabel}>More</Text>
      </View>

      {/* Day detail modal */}
      <DayDetailModal day={selectedDay} visible={modalVisible} onClose={handleModalClose} />
    </View>
  );
}
