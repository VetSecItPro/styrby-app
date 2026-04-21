/**
 * Date grouping helpers for the sessions list.
 *
 * WHY: Grouping logic is pure data transformation that does not belong in
 * the screen file. Extracting it here keeps SessionsScreen focused on UI
 * concerns and lets these helpers be unit-tested independently.
 */

import type { SessionRow } from '../../hooks/useSessions';
import type { SessionSection } from '../../types/sessions';

/**
 * Short day-of-week names for section headers.
 *
 * WHY: Hoisted to module level so this array is allocated once at import time.
 */
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/**
 * Short month names for section headers.
 */
const MONTH_ABBREVS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

/**
 * Format a date into a human-friendly section header label.
 *
 * Returns "Today", "Yesterday", or a short date like "Mon Mar 25" for
 * older dates. This matches the web app's date grouping behavior.
 *
 * @param date - The date to format
 * @returns A section header string
 *
 * @example
 * formatSectionDate(new Date()); // "Today"
 * formatSectionDate(yesterday);  // "Yesterday"
 * formatSectionDate(lastWeek);   // "Mon Mar 25"
 */
export function formatSectionDate(date: Date): string {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.floor(
    (today.getTime() - target.getTime()) / 86_400_000,
  );

  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';

  return `${DAY_NAMES[date.getDay()]} ${MONTH_ABBREVS[date.getMonth()]} ${date.getDate()}`;
}

/**
 * Derive a date-only key string (YYYY-MM-DD) from an ISO timestamp.
 *
 * WHY: We group sessions by the date portion of `started_at`. Using a
 * consistent key format ensures sessions that started on the same calendar
 * day (in the user's local timezone) are grouped together.
 *
 * @param isoTimestamp - An ISO 8601 timestamp string
 * @returns A date key string in YYYY-MM-DD format (local timezone)
 */
export function getDateKey(isoTimestamp: string): string {
  const d = new Date(isoTimestamp);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Group an array of sessions by their `started_at` date into sections
 * suitable for React Native's SectionList.
 *
 * Preserves the input order within each group (sessions are already sorted
 * by `updated_at DESC` from the hook).
 *
 * @param sessions - Array of session rows to group
 * @returns Array of sections, each with a title, count, and data
 *
 * @example
 * const sections = groupSessionsByDate(filteredSessions);
 * // [{ title: "Today", count: 3, data: [...] }, { title: "Yesterday", count: 1, data: [...] }]
 */
export function groupSessionsByDate(sessions: SessionRow[]): SessionSection[] {
  const groupMap = new Map<string, SessionRow[]>();

  for (const session of sessions) {
    const key = getDateKey(session.started_at);
    const existing = groupMap.get(key);
    if (existing) {
      existing.push(session);
    } else {
      groupMap.set(key, [session]);
    }
  }

  const sections: SessionSection[] = [];

  for (const [key, data] of groupMap) {
    // WHY: `new Date("YYYY-MM-DD")` parses as UTC midnight, not local midnight.
    // In negative UTC offsets (e.g., UTC-5) this causes "Mon Mar 25" to render
    // as "Sun Mar 24" because UTC midnight is still the previous day locally.
    // Splitting the key and constructing via (year, month-1, day) uses the
    // local timezone, matching how getDateKey() derived the key in the first place.
    const [year, month, day] = key.split('-').map(Number);
    sections.push({
      title: formatSectionDate(new Date(year, month - 1, day)),
      count: data.length,
      data,
    });
  }

  return sections;
}
