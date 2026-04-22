/**
 * MrrCard — MRR / ARR metric card for the founder ops dashboard.
 *
 * Displays:
 *   - MRR (monthly recurring revenue)
 *   - ARR (annualized)
 *   - 30-day and 90-day churn rates
 *   - Average LTV estimate
 *
 * WHY a dedicated component: The founder dashboard page is an orchestrator.
 * Each metric cluster gets its own component per CLAUDE.md component-first
 * architecture rules.
 *
 * @module components/dashboard/founder/MrrCard
 */

// ============================================================================
// Props
// ============================================================================

/**
 * Props for {@link MrrCard}.
 */
export interface MrrCardProps {
  mrrUsd: number;
  arrUsd: number;
  churnRate30d: number | null;
  churnRate90d: number | null;
  avgLtvUsd: number | null;
}

// ============================================================================
// Helpers
// ============================================================================

function fmtUsd(usd: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(usd);
}

function fmtPct(rate: number | null): string {
  if (rate === null) return '-';
  return `${(rate * 100).toFixed(1)}%`;
}

// ============================================================================
// Component
// ============================================================================

/**
 * Renders MRR, ARR, churn, and LTV metrics for the founder dashboard.
 *
 * @param props - See {@link MrrCardProps}
 * @returns React element
 *
 * @example
 * <MrrCard mrrUsd={4900} arrUsd={58800} churnRate30d={0.02} churnRate90d={0.06} avgLtvUsd={1200} />
 */
export function MrrCard({
  mrrUsd,
  arrUsd,
  churnRate30d,
  churnRate90d,
  avgLtvUsd,
}: MrrCardProps) {
  return (
    <div className="rounded-xl border border-border/60 bg-card/60 p-5">
      <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-4">
        Revenue
      </h3>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div>
          <p className="text-xs text-muted-foreground mb-1">MRR</p>
          <p className="text-2xl font-bold text-foreground">{fmtUsd(mrrUsd)}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground mb-1">ARR</p>
          <p className="text-2xl font-bold text-foreground">{fmtUsd(arrUsd)}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground mb-1">Churn (30d)</p>
          <p className="text-2xl font-bold text-foreground">{fmtPct(churnRate30d)}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground mb-1">Avg LTV</p>
          <p className="text-2xl font-bold text-foreground">
            {avgLtvUsd !== null ? fmtUsd(avgLtvUsd) : '-'}
          </p>
        </div>
      </div>
      {churnRate90d !== null && (
        <p className="text-xs text-muted-foreground mt-3">
          90-day trailing churn: {fmtPct(churnRate90d)}
        </p>
      )}
    </div>
  );
}
