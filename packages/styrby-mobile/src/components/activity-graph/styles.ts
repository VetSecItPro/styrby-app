/**
 * Shared StyleSheet for the activity heatmap + its day-detail modal.
 *
 * Extracted from ActivityGraph.tsx (Cluster A2 split) so both the orchestrator
 * and the DayDetailModal sub-component reference one stylesheet.
 *
 * @module components/activity-graph/styles
 */

import { StyleSheet } from 'react-native';
import { CELL_SIZE, CELL_GAP } from './constants';

export const styles = StyleSheet.create({
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
