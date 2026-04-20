/**
 * ActivityGraph Component (Mobile)
 *
 * Horizontal-scrollable heatmap showing 12 weeks of coding activity
 * (scrollable back to 52 weeks). Each cell represents one calendar day,
 * colored by activity intensity (0–4).
 *
 * Tapping a cell opens a bottom sheet / modal with detailed stats for that day.
 *
 * Data is fetched from Supabase (sessions table) and grouped by date client-side.
 * The component uses the same intensity bucketing algorithm as the web version
 * so both surfaces look consistent.
 *
 * @module components/ActivityGraph
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  Pressable,
  Modal,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { supabase } from '../lib/supabase';
import type { ActivityDay, AgentType } from 'styrby-shared';

// ============================================================================
// Constants
// ============================================================================

/** Maximum weeks fetched from Supabase. */
const MAX_WEEKS = 52;

/** Cell size in dp. */
const CELL_SIZE = 12;

/** Gap between cells in dp. */
const CELL_GAP = 3;

/** Total cell+gap stride. */
const CELL_STRIDE = CELL_SIZE + CELL_GAP;

/** Days per week. */
const DAYS_PER_WEEK = 7;

/** Month abbreviations for x-axis. */
const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ============================================================================
// Color palettes (dark theme — React Native doesn't support Tailwind classes)
// ============================================================================

/** Session mode: emerald tones */
const SESSION_COLORS: Record<0 | 1 | 2 | 3 | 4, string> = {
  0: '#27272a', // zinc-800 (no activity)
  1: '#064e3b', // emerald-900
  2: '#047857', // emerald-700
  3: '#10b981', // emerald-500
  4: '#34d399', // emerald-400
};

/** Cost mode: amber tones */
const COST_COLORS: Record<0 | 1 | 2 | 3 | 4, string> = {
  0: '#27272a', // zinc-800 (no activity)
  1: '#78350f', // amber-900
  2: '#b45309', // amber-700
  3: '#f59e0b', // amber-500
  4: '#fbbf24', // amber-400
};

// ============================================================================
// Helpers
// ============================================================================

/**
 * Format a date as YYYY-MM-DD.
 *
 * @param date - Date to format
 * @returns ISO date string
 */
function toDateStr(date: Date): string {
  return date.toISOString().split('T')[0];
}

/**
 * Compute intensity bucket (0–4) from a raw value relative to a maximum.
 *
 * WHY: Relative bucketing ensures light users see variation just like heavy
 * users. Fixed thresholds would always render intensity 1 for low-volume
 * users, defeating the purpose of a heatmap.
 *
 * @param value - Raw value for this day
 * @param max - Maximum value across all days
 * @returns Intensity 0–4
 */
function computeIntensity(value: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (value === 0 || max === 0) return 0;
  const ratio = value / max;
  if (ratio <= 0.15) return 1;
  if (ratio <= 0.40) return 2;
  if (ratio <= 0.70) return 3;
  return 4;
}

/**
 * Build the full grid (MAX_WEEKS × DAYS_PER_WEEK), oldest day first.
 *
 * WHY: Pre-populates all cells with zeros so the grid always has the right
 * number of cells regardless of data sparsity.
 *
 * @param rawData - Map of YYYY-MM-DD → ActivityDay from Supabase
 * @param mode - Which metric to use for intensity computation
 * @returns Flat array of ActivityDay objects, oldest-first
 */
function buildGrid(rawData: Map<string, ActivityDay>, mode: 'sessions' | 'cost'): ActivityDay[] {
  const today = new Date();
  const totalDays = MAX_WEEKS * DAYS_PER_WEEK;
  const grid: ActivityDay[] = [];

  let maxValue = 0;
  for (const day of rawData.values()) {
    const v = mode === 'sessions' ? day.sessionCount : day.totalCostUsd;
    if (v > maxValue) maxValue = v;
  }

  for (let i = totalDays - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = toDateStr(d);
    const existing = rawData.get(dateStr);

    if (existing) {
      const value = mode === 'sessions' ? existing.sessionCount : existing.totalCostUsd;
      grid.push({ ...existing, intensity: computeIntensity(value, maxValue) });
    } else {
      grid.push({
        date: dateStr,
        sessionCount: 0,
        totalCostUsd: 0,
        totalTokens: 0,
        agents: [],
        intensity: 0,
      });
    }
  }

  return grid;
}

/**
 * Arrange flat grid into week columns.
 *
 * @param grid - Flat ActivityDay array, oldest-first
 * @returns Array of week columns, each with 7 days
 */
function gridToColumns(grid: ActivityDay[]): ActivityDay[][] {
  const totalWeeks = Math.floor(grid.length / DAYS_PER_WEEK);
  const columns: ActivityDay[][] = [];
  for (let col = 0; col < totalWeeks; col++) {
    columns.push(grid.slice(col * DAYS_PER_WEEK, (col + 1) * DAYS_PER_WEEK));
  }
  return columns;
}

/**
 * Format token count with K/M suffix.
 *
 * @param tokens - Raw token count
 * @returns Formatted string
 */
function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return tokens.toString();
}

// ============================================================================
// Day Detail Modal
// ============================================================================

/**
 * Props for the DayDetailModal.
 */
interface DayDetailModalProps {
  day: ActivityDay | null;
  visible: boolean;
  onClose: () => void;
}

/**
 * Bottom-sheet style modal showing detailed stats for a tapped heatmap cell.
 *
 * @param props - Modal visibility state and day data
 */
function DayDetailModal({ day, visible, onClose }: DayDetailModalProps) {
  if (!day) return null;

  const date = new Date(day.date + 'T12:00:00');
  const formatted = date.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
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

          <TouchableOpacity style={styles.modalCloseBtn} onPress={onClose}>
            <Text style={styles.modalCloseBtnText}>Close</Text>
          </TouchableOpacity>
        </View>
      </Pressable>
    </Modal>
  );
}

// ============================================================================
// Main Component
// ============================================================================

/**
 * Props for the ActivityGraph component.
 */
export interface ActivityGraphProps {
  /** Whether to show a section title above the graph. Default: true. */
  showTitle?: boolean;
}

/**
 * Horizontal-scrollable heatmap showing coding session activity.
 *
 * Renders the last 12 weeks by default; the user can scroll left to
 * see up to 52 weeks of history. Tapping a cell shows a detail modal
 * with session count, cost, token count, and agents used.
 *
 * @param props - Component props
 * @returns The activity heatmap component
 *
 * @example
 * // Add to the dashboard home tab
 * <ActivityGraph showTitle />
 */
export function ActivityGraph({ showTitle = true }: ActivityGraphProps) {
  const [mode, setMode] = useState<'sessions' | 'cost'>('sessions');
  const [rawData, setRawData] = useState<Map<string, ActivityDay>>(new Map());
  const [isLoading, setIsLoading] = useState(true);
  const [selectedDay, setSelectedDay] = useState<ActivityDay | null>(null);
  const [modalVisible, setModalVisible] = useState(false);

  // ── Data Fetching ──────────────────────────────────────────────────────────

  /**
   * Fetch session data from Supabase and aggregate by date.
   *
   * WHY: We query `sessions` (not `cost_records`) because sessions have a
   * `started_at` date that naturally represents the coding contribution date.
   * Using cost record dates would fragment a session that spans midnight.
   */
  const fetchData = useCallback(async () => {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - MAX_WEEKS * DAYS_PER_WEEK);
    const cutoffStr = toDateStr(cutoff);

    const { data, error } = await supabase
      .from('sessions')
      .select('started_at, total_cost_usd, agent_type, context_window_used')
      .gte('started_at', cutoffStr + 'T00:00:00Z')
      .order('started_at', { ascending: true });

    if (error) {
      console.error('[ActivityGraph] Fetch error:', __DEV__ ? error : error.message);
      return;
    }

    const map = new Map<string, ActivityDay>();

    for (const row of data ?? []) {
      const dateStr = (row.started_at as string).split('T')[0];
      const cost = Number(row.total_cost_usd) || 0;
      const tokens = Number(row.context_window_used) || 0;
      const agent = (row.agent_type as string) || 'unknown';

      const existing = map.get(dateStr) ?? {
        date: dateStr,
        sessionCount: 0,
        totalCostUsd: 0,
        totalTokens: 0,
        agents: [] as AgentType[],
        intensity: 0 as const,
      };

      const agents = (existing.agents as string[]).includes(agent)
        ? existing.agents
        : ([...existing.agents, agent] as AgentType[]);

      map.set(dateStr, {
        date: dateStr,
        sessionCount: existing.sessionCount + 1,
        totalCostUsd: existing.totalCostUsd + cost,
        totalTokens: existing.totalTokens + tokens,
        agents,
        intensity: 0, // recomputed in buildGrid
      });
    }

    setRawData(map);
  }, []);

  useEffect(() => {
    const load = async () => {
      setIsLoading(true);
      await fetchData();
      setIsLoading(false);
    };
    load();
  }, [fetchData]);

  // ── Grid Computation ────────────────────────────────────────────────────────

  const grid = buildGrid(rawData, mode);
  const columns = gridToColumns(grid);

  // ── Summary Stats ──────────────────────────────────────────────────────────

  const totalSessions = Array.from(rawData.values()).reduce((sum, d) => sum + d.sessionCount, 0);
  const activeDays = Array.from(rawData.values()).filter((d) => d.sessionCount > 0).length;

  // ── Handlers ───────────────────────────────────────────────────────────────

  const handleCellPress = useCallback((day: ActivityDay) => {
    setSelectedDay(day);
    setModalVisible(true);
  }, []);

  const handleModalClose = useCallback(() => {
    setModalVisible(false);
  }, []);

  // ── Render ─────────────────────────────────────────────────────────────────

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
        >
          <Text style={[styles.toggleBtnText, mode === 'sessions' && styles.toggleBtnTextActive]}>
            Sessions
          </Text>
        </Pressable>
        <Pressable
          style={[styles.toggleBtn, mode === 'cost' && styles.toggleBtnActive]}
          onPress={() => setMode('cost')}
        >
          <Text style={[styles.toggleBtnText, mode === 'cost' && styles.toggleBtnTextActive]}>
            Cost
          </Text>
        </Pressable>
      </View>

      {/* Scrollable heatmap — scrolls right-to-left (recent weeks on the right) */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
        // Scroll to the rightmost (most recent) content by default
        ref={(ref) => {
          if (ref) {
            // Scroll to end on initial render
            setTimeout(() => ref.scrollToEnd({ animated: false }), 0);
          }
        }}
      >
        {/* Month labels above columns */}
        <View>
          <View style={styles.monthRow}>
            {columns.map((week, colIndex) => {
              // Show month label at the first week of each new month
              const firstDay = week[0];
              if (!firstDay) return <View key={colIndex} style={{ width: CELL_STRIDE }} />;
              const month = new Date(firstDay.date + 'T12:00:00').getMonth();
              const prevWeek = columns[colIndex - 1];
              const prevMonth = prevWeek?.[0]
                ? new Date(prevWeek[0].date + 'T12:00:00').getMonth()
                : -1;

              return (
                <View key={colIndex} style={{ width: CELL_STRIDE }}>
                  {month !== prevMonth && (
                    <Text style={styles.monthLabel}>{MONTH_LABELS[month]}</Text>
                  )}
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
          <View
            key={level}
            style={[styles.legendCell, { backgroundColor: colors[level] }]}
          />
        ))}
        <Text style={styles.legendLabel}>More</Text>
      </View>

      {/* Day detail modal */}
      <DayDetailModal
        day={selectedDay}
        visible={modalVisible}
        onClose={handleModalClose}
      />
    </View>
  );
}

// ============================================================================
// Styles
// ============================================================================

const styles = StyleSheet.create({
  container: {
    backgroundColor: 'rgba(24, 24, 27, 0.6)',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(63, 63, 70, 0.4)',
    padding: 16,
  },
  loadingContainer: {
    height: 120,
    alignItems: 'center',
    justifyContent: 'center',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 8,
    marginBottom: 10,
  },
  title: {
    fontSize: 14,
    fontWeight: '600',
    color: '#f4f4f5',
  },
  subtitle: {
    fontSize: 11,
    color: '#71717a',
  },
  toggleRow: {
    flexDirection: 'row',
    gap: 1,
    marginBottom: 12,
    alignSelf: 'flex-start',
    borderRadius: 6,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(63, 63, 70, 0.6)',
  },
  toggleBtn: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: '#18181b',
  },
  toggleBtnActive: {
    backgroundColor: '#3f3f46',
  },
  toggleBtnText: {
    fontSize: 11,
    color: '#71717a',
  },
  toggleBtnTextActive: {
    color: '#f4f4f5',
  },
  scrollContent: {
    paddingRight: 4,
  },
  monthRow: {
    flexDirection: 'row',
    marginBottom: 2,
    height: 14,
  },
  monthLabel: {
    fontSize: 9,
    color: 'rgba(113, 113, 122, 0.7)',
    position: 'absolute',
  },
  gridRow: {
    flexDirection: 'row',
    gap: CELL_GAP,
  },
  weekColumn: {
    flexDirection: 'column',
    gap: CELL_GAP,
  },
  cell: {
    width: CELL_SIZE,
    height: CELL_SIZE,
    borderRadius: 2,
  },
  legendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 3,
    marginTop: 8,
  },
  legendLabel: {
    fontSize: 9,
    color: 'rgba(113, 113, 122, 0.6)',
  },
  legendCell: {
    width: CELL_SIZE,
    height: CELL_SIZE,
    borderRadius: 2,
  },
  // Modal styles
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    justifyContent: 'flex-end',
  },
  modalSheet: {
    backgroundColor: '#18181b',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 24,
    paddingBottom: 40,
    borderTopWidth: 1,
    borderColor: 'rgba(63, 63, 70, 0.4)',
  },
  modalHandle: {
    width: 40,
    height: 4,
    backgroundColor: '#3f3f46',
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: 20,
  },
  modalDate: {
    fontSize: 15,
    fontWeight: '600',
    color: '#f4f4f5',
    marginBottom: 16,
  },
  modalNoActivity: {
    fontSize: 14,
    color: '#71717a',
    textAlign: 'center',
    marginVertical: 16,
  },
  modalStats: {
    gap: 10,
  },
  modalStatRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  modalStatLabel: {
    fontSize: 13,
    color: '#a1a1aa',
  },
  modalStatValue: {
    fontSize: 13,
    fontWeight: '600',
    color: '#f4f4f5',
  },
  modalCloseBtn: {
    marginTop: 24,
    backgroundColor: '#27272a',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  modalCloseBtnText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#f4f4f5',
  },
});
