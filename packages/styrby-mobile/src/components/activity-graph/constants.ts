/**
 * Layout dimensions + color palettes for the activity heatmap.
 *
 * Extracted from ActivityGraph.tsx (Cluster A2 split). Kept as plain constants
 * so the grid math, the styles, and the cell renderer all share one source of
 * truth for sizing and color.
 *
 * @module components/activity-graph/constants
 */

/** Maximum weeks fetched from Supabase. */
export const MAX_WEEKS = 52;

/** Cell size in dp. */
export const CELL_SIZE = 12;

/** Gap between cells in dp. */
export const CELL_GAP = 3;

/** Total cell+gap stride. */
export const CELL_STRIDE = CELL_SIZE + CELL_GAP;

/** Days per week. */
export const DAYS_PER_WEEK = 7;

/** Month abbreviations for x-axis. */
export const MONTH_LABELS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/**
 * Session mode palette (emerald tones).
 *
 * WHY hard-coded hex, not Tailwind: React Native doesn't resolve Tailwind
 * classes for dynamic per-cell `backgroundColor`; the intensity index maps
 * directly to a hex value here.
 */
export const SESSION_COLORS: Record<0 | 1 | 2 | 3 | 4, string> = {
  0: '#27272a', // zinc-800 (no activity)
  1: '#064e3b', // emerald-900
  2: '#047857', // emerald-700
  3: '#10b981', // emerald-500
  4: '#34d399', // emerald-400
};

/** Cost mode palette (amber tones). */
export const COST_COLORS: Record<0 | 1 | 2 | 3 | 4, string> = {
  0: '#27272a', // zinc-800 (no activity)
  1: '#78350f', // amber-900
  2: '#b45309', // amber-700
  3: '#f59e0b', // amber-500
  4: '#fbbf24', // amber-400
};

/** Which metric drives intensity bucketing. */
export type ActivityMode = 'sessions' | 'cost';
