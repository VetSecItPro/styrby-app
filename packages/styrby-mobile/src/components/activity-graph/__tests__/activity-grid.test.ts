/**
 * Tests for the activity heatmap grid math (Cluster A2 split).
 *
 * These pure helpers were untested while embedded in ActivityGraph.tsx;
 * extracting them made them directly testable.
 *
 * @module components/activity-graph/__tests__/activity-grid
 */

import type { ActivityDay } from 'styrby-shared';
import {
  toDateStr,
  computeIntensity,
  buildGrid,
  gridToColumns,
  formatTokens,
} from '../activity-grid';
import { MAX_WEEKS, DAYS_PER_WEEK } from '../constants';

describe('toDateStr', () => {
  it('returns the YYYY-MM-DD portion of a date', () => {
    expect(toDateStr(new Date('2026-06-12T15:30:00Z'))).toBe('2026-06-12');
  });
});

describe('computeIntensity', () => {
  it('returns 0 when the value is zero', () => {
    expect(computeIntensity(0, 100)).toBe(0);
  });
  it('returns 0 when the max is zero (avoids divide-by-zero)', () => {
    expect(computeIntensity(5, 0)).toBe(0);
  });
  it('buckets by ratio thresholds', () => {
    expect(computeIntensity(10, 100)).toBe(1); // 0.10 <= 0.15
    expect(computeIntensity(15, 100)).toBe(1); // 0.15 boundary
    expect(computeIntensity(30, 100)).toBe(2); // 0.30 <= 0.40
    expect(computeIntensity(60, 100)).toBe(3); // 0.60 <= 0.70
    expect(computeIntensity(100, 100)).toBe(4); // > 0.70
  });
});

describe('buildGrid', () => {
  it('produces MAX_WEEKS * DAYS_PER_WEEK cells regardless of sparsity', () => {
    const grid = buildGrid(new Map(), 'sessions');
    expect(grid).toHaveLength(MAX_WEEKS * DAYS_PER_WEEK);
  });

  it('fills empty days with zeroed cells (intensity 0)', () => {
    const grid = buildGrid(new Map(), 'sessions');
    expect(grid.every((d) => d.intensity === 0 && d.sessionCount === 0)).toBe(true);
  });

  it('assigns the max-value day the top intensity in sessions mode', () => {
    const today = toDateStr(new Date());
    const data = new Map<string, ActivityDay>([
      [today, { date: today, sessionCount: 10, totalCostUsd: 1, totalTokens: 0, agents: [], intensity: 0 }],
    ]);
    const grid = buildGrid(data, 'sessions');
    const todayCell = grid.find((d) => d.date === today);
    expect(todayCell?.intensity).toBe(4);
  });

  it('buckets by cost when mode is cost', () => {
    const today = toDateStr(new Date());
    const data = new Map<string, ActivityDay>([
      [today, { date: today, sessionCount: 1, totalCostUsd: 5, totalTokens: 0, agents: [], intensity: 0 }],
    ]);
    const grid = buildGrid(data, 'cost');
    expect(grid.find((d) => d.date === today)?.intensity).toBe(4);
  });
});

describe('gridToColumns', () => {
  it('splits a flat grid into 7-day week columns', () => {
    const grid = buildGrid(new Map(), 'sessions');
    const columns = gridToColumns(grid);
    expect(columns).toHaveLength(MAX_WEEKS);
    expect(columns.every((c) => c.length === DAYS_PER_WEEK)).toBe(true);
  });
});

describe('formatTokens', () => {
  it('formats millions with M', () => {
    expect(formatTokens(2_500_000)).toBe('2.5M');
  });
  it('formats thousands with K', () => {
    expect(formatTokens(1_200)).toBe('1.2K');
  });
  it('leaves small counts as-is', () => {
    expect(formatTokens(900)).toBe('900');
  });
});
