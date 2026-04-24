/**
 * Utility helpers for the Admin Audit Log page.
 *
 * WHY separate file (not in page.tsx):
 *   Next.js 15 restricts what may be exported from a page file — only the
 *   default export (the page component) and a small set of framework-recognised
 *   named exports (generateMetadata, generateStaticParams, etc.) are permitted.
 *   Exporting parseCursor directly from page.tsx caused a build-time type error:
 *     "'parseCursor' is not a valid Page export field."
 *   Moving it here lets tests import it without violating the page contract.
 *   SOC 2 CC6.1, OWASP A03:2021.
 *
 * @module app/dashboard/admin/audit/utils
 */

/**
 * Parses and validates a cursor string from the URL query param.
 *
 * WHY parseInt with NaN guard: the cursor is user-controlled (URL param).
 * A non-numeric or negative value must not reach the DB query.
 * Returning null falls back to "first page" behavior (no WHERE clause).
 *
 * Invalid or out-of-range cursors (NaN, negative, huge integers beyond the
 * bigserial PK range) silently collapse to "first page" since the WHERE clause
 * `id < :cursor` naturally returns the most recent rows for any cursor larger
 * than the max id. No error leak.
 *
 * @param raw - Raw cursor string from ?cursor= param
 * @returns Positive integer cursor, or null if absent/invalid
 */
export function parseCursor(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = parseInt(raw, 10);
  // WHY isNaN + positive check: negative IDs are invalid in a serial PK table.
  // Coercing negative cursors to null is safe (returns first page) rather than
  // passing them to the DB where they'd return 0 rows (confusing).
  if (isNaN(n) || n <= 0) return null;
  return n;
}
