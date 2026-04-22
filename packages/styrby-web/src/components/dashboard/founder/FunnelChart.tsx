/**
 * FunnelChart — onboarding funnel visualization for the founder dashboard.
 *
 * Renders a horizontal funnel table:
 *   Total users -> Onboarded -> First session -> 7d active -> 30d active
 *
 * Each step shows the absolute count and the conversion rate from the
 * previous step so the founder can immediately spot drop-off points.
 *
 * WHY a table not an SVG funnel: An SVG funnel chart with proper trap shapes
 * requires a charting library or custom path math. The same information is
 * conveyed more precisely (and accessibly) in a responsive table with a
 * progress-bar column. Screen readers can consume this natively.
 *
 * @module components/dashboard/founder/FunnelChart
 */

// ============================================================================
// Types
// ============================================================================

/**
 * One step in the funnel.
 */
export interface FunnelStep {
  step: string;
  count: number;
  /** Fraction of the previous step (null for first step). */
  conversionFromPrev: number | null;
}

/**
 * Props for {@link FunnelChart}.
 */
export interface FunnelChartProps {
  steps: FunnelStep[];
}

// ============================================================================
// Component
// ============================================================================

/**
 * Renders the onboarding-to-active funnel as an accessible table.
 *
 * @param props - See {@link FunnelChartProps}
 * @returns React element
 *
 * @example
 * <FunnelChart steps={funnel} />
 */
export function FunnelChart({ steps }: FunnelChartProps) {
  const maxCount = Math.max(...steps.map((s) => s.count), 1);

  return (
    <div className="rounded-xl border border-border/60 bg-card/60 p-5">
      <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-4">
        Onboarding Funnel
      </h3>
      <div className="space-y-3">
        {steps.map((step) => {
          const barFrac = step.count / maxCount;
          const convPct =
            step.conversionFromPrev !== null
              ? `${(step.conversionFromPrev * 100).toFixed(0)}% from prev`
              : null;

          return (
            <div key={step.step}>
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm text-foreground font-medium">{step.step}</span>
                <div className="flex items-center gap-2">
                  {convPct && (
                    <span className="text-xs text-muted-foreground">{convPct}</span>
                  )}
                  <span className="text-sm font-semibold text-foreground w-12 text-right">
                    {step.count.toLocaleString()}
                  </span>
                </div>
              </div>
              <div className="h-1.5 bg-secondary/60 rounded-full overflow-hidden">
                <div
                  className="h-1.5 rounded-full bg-orange-500 transition-all duration-300"
                  style={{ width: `${barFrac * 100}%` }}
                  role="progressbar"
                  aria-valuenow={step.count}
                  aria-valuemin={0}
                  aria-valuemax={maxCount}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
