/**
 * Shared date and cost formatters for admin dossier cards.
 *
 * WHY this module exists: before extraction, each dossier card (ProfileCard,
 * SubscriptionCard, TeamsCard, SessionsCard, RecentAuditCard) defined its own
 * local `fmtDate` / `fmtDateTime` helper with slightly different locale options.
 * This produced inconsistent UX — SessionsCard omitted the year, RecentAuditCard
 * included it, TeamsCard used `toLocaleDateString` while others used `toLocaleString`.
 * An admin comparing dates across cards could see mismatched formats for the same
 * timestamp. Consolidating here enforces consistent output and a single place to
 * update if locale requirements change.
 *
 * @module components/admin/dossier/formatters
 */

/**
 * Format a timestamp as a human-readable date (no time).
 *
 * Example output: "Apr 23, 2026"
 *
 * @param iso - ISO 8601 timestamp string (nullable / undefined)
 * @returns Formatted date string, "—" for null/empty, "Unknown" for unparseable
 */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return 'Unknown';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * Format a timestamp with date + time + year.
 *
 * Example output: "Apr 23, 2026, 10:00 AM"
 *
 * WHY include year: admin audit entries can span years; showing "Apr 20" with no
 * year is ambiguous in historical log review. Year is always shown for audit
 * timestamps and any date-time field where historical context matters.
 *
 * @param iso - ISO 8601 timestamp string (nullable / undefined)
 * @returns Formatted date-time string, "—" for null/empty, "Unknown" for unparseable
 */
export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return 'Unknown';
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * Format a USD cost value as a fixed-4-decimal string.
 *
 * Example output: "$0.0142" or "$0.0000"
 *
 * WHY 4 decimal places: AI token costs are often sub-cent; showing only 2 decimal
 * places would display "$0.00" for most individual sessions, which is meaningless
 * for ops cost debugging. 4 places preserves precision without being overwhelming.
 *
 * @param usd - Cost in USD (nullable / undefined / NaN)
 * @returns Formatted cost string, "$0.0000" for null / undefined / NaN
 */
export function fmtCost(usd: number | null | undefined): string {
  if (usd === null || usd === undefined || isNaN(usd)) return '$0.0000';
  return `$${usd.toFixed(4)}`;
}
