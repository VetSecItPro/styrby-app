/**
 * Pure formatting helpers for the `styrby costs` command.
 *
 * Extracted from cli/handlers/costs.ts so they can be unit-tested without
 * standing up the full handler (which dynamically imports the cost
 * aggregation lib + writes to console).
 *
 * NOTE: there are sibling formatters in `ui/welcome.ts` (smaller — only
 * handles K-scale, not M-scale) and `commands/cloud.ts` (chalk-colored,
 * null-tolerant). They should be consolidated to use these helpers in a
 * follow-up dedup PR; this file is the canonical M-scale token formatter
 * and 4-decimal-USD formatter.
 *
 * @module cli/handlers/costs-helpers
 */

/**
 * Format a token count for human-readable display.
 *
 * - Counts ≥ 1,000,000 → "X.YYM" (millions, 2 decimal places)
 * - Counts ≥ 1,000     → "X.YK"  (thousands, 1 decimal place)
 * - Counts < 1,000     → exact integer string
 *
 * @param n - The token count (must be a non-negative integer; behavior
 *            is unspecified for negatives or fractions but won't throw).
 * @returns Formatted string suitable for terminal output.
 *
 * @example
 * formatTokens(0);          // "0"
 * formatTokens(999);        // "999"
 * formatTokens(1234);       // "1.2K"
 * formatTokens(1_500_000);  // "1.50M"
 */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

/**
 * Format a cost in USD to 4 decimal places with a leading dollar sign.
 *
 * Why 4 decimals: token-level costs are often in the $0.0042 range; with
 * 2 decimals everything would round to $0.00 and the dashboard would be
 * useless.
 *
 * @param n - The cost in USD as a number (can be 0).
 * @returns Formatted string like "$0.0042".
 *
 * @example
 * formatCost(0);        // "$0.0000"
 * formatCost(0.00123);  // "$0.0012"
 * formatCost(42.5);     // "$42.5000"
 */
export function formatCost(n: number): string {
  return `$${n.toFixed(4)}`;
}
