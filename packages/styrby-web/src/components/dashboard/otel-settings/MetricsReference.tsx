/**
 * MetricsReference — collapsible table of the metrics OTEL export emits.
 *
 * Extracted from otel-settings.tsx (Cluster A2 split). Static reference content.
 *
 * @module components/dashboard/otel-settings/MetricsReference
 */

/** The metrics the Styrby CLI exports over OTLP, with type + attributes. */
const EXPORTED_METRICS: { metric: string; type: string; attrs: string }[] = [
  { metric: 'styrby.session.duration_ms', type: 'Gauge', attrs: 'agent, model, status' },
  { metric: 'styrby.tokens.input', type: 'Sum', attrs: 'agent, model' },
  { metric: 'styrby.tokens.output', type: 'Sum', attrs: 'agent, model' },
  { metric: 'styrby.tokens.cache_read', type: 'Sum', attrs: 'agent, model' },
  { metric: 'styrby.tokens.cache_write', type: 'Sum', attrs: 'agent, model' },
  { metric: 'styrby.cost.usd', type: 'Sum', attrs: 'agent, model' },
  { metric: 'styrby.errors.count', type: 'Sum', attrs: 'agent, error_source' },
];

/**
 * Collapsible reference table listing every exported metric.
 */
export function MetricsReference() {
  return (
    <details className="rounded-lg border border-border/40">
      <summary className="px-4 py-3 cursor-pointer text-sm font-medium text-foreground hover:text-muted-foreground transition-colors list-none flex items-center justify-between">
        Exported Metrics Reference
        <svg
          className="h-4 w-4 text-muted-foreground"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </summary>
      <div className="px-4 pb-4 border-t border-border/40">
        <table className="w-full mt-3 text-xs">
          <thead>
            <tr className="text-muted-foreground">
              <th className="text-left py-1.5 font-medium">Metric</th>
              <th className="text-left py-1.5 font-medium">Type</th>
              <th className="text-left py-1.5 font-medium">Attributes</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/20">
            {EXPORTED_METRICS.map((row) => (
              <tr key={row.metric}>
                <td className="py-1.5 font-mono text-amber-400">{row.metric}</td>
                <td className="py-1.5 text-muted-foreground">{row.type}</td>
                <td className="py-1.5 text-muted-foreground">{row.attrs}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
