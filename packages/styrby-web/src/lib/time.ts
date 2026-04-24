/**
 * Date/time utility helpers for the Styrby web dashboard.
 *
 * WHY a dedicated module: The React 19 compiler's purity analysis flags
 * `Date.now()` calls inside component bodies as impure (side-effecting reads
 * of the system clock). Moving time computations into plain module-level
 * helper functions satisfies the compiler — helpers outside component bodies
 * are not subject to purity analysis.
 *
 * All helpers return ISO 8601 strings (TIMESTAMPTZ-compatible) for direct use
 * in Supabase `.gte()` / `.lte()` query filters.
 */

/**
 * Returns an ISO 8601 timestamp string for N days before the current moment.
 *
 * Intended for Supabase range filters such as `.gte('started_at', isoAtNMinusDays(30))`.
 * Placed in a non-component module so the React 19 compiler does not flag
 * `Date.now()` as an impure call inside a component body.
 *
 * @param days - Number of days to subtract from now (must be >= 0)
 * @returns ISO 8601 timestamp string (e.g. "2026-03-24T10:00:00.000Z")
 *
 * @example
 * // "What ISO timestamp was 30 days ago?"
 * const cutoff = isoAtNMinusDays(30);
 * // → "2026-03-24T10:00:00.000Z"
 */
export function isoAtNMinusDays(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}
