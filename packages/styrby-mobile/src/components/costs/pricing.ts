/**
 * Pure formatting helpers for the costs screen.
 *
 * WHY: Pure data transforms don't belong in JSX files. Extracting them
 * here keeps the screen file focused on rendering and lets these helpers
 * be unit-tested in isolation without mounting React.
 *
 * @module components/costs/pricing
 */

/**
 * Format a USD price-per-1M-tokens value for the model pricing reference table.
 *
 * Sub-cent prices (e.g. Gemini Flash at $0.075/1M) need 3 decimals so they
 * don't render as "$0.00", while normal prices use 2 decimals to match
 * conventional currency formatting.
 *
 * @param price - USD price per 1,000,000 tokens
 * @returns Formatted string like '$3.00', '$0.075', '$0.003'
 *
 * @example
 * formatPricePer1M(3);     // '$3.00'
 * formatPricePer1M(0.075); // '$0.075'
 * formatPricePer1M(0);     // '$0.000'
 */
export function formatPricePer1M(price: number): string {
  if (price < 0.01) return `$${price.toFixed(3)}`;
  if (price < 1) return `$${price.toFixed(3)}`;
  return `$${price.toFixed(2)}`;
}

/**
 * Compact USD formatter used inside the BudgetAlertsSummary card.
 *
 * WHY: Tiny budget thresholds (e.g. $0.0050) would round to "$0.00" with
 * standard 2-decimal formatting and confuse users. We adapt precision to
 * magnitude so the displayed value is always meaningful.
 *
 * @param value - Cost in USD
 * @returns Formatted string like '$0.00', '$0.0042', '$0.123', '$12.34'
 */
export function formatBudgetCost(value: number): string {
  if (value === 0) return '$0.00';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}
