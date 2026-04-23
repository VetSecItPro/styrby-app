'use client';

/**
 * ForecastQualityCard — Founder dashboard panel for predictive alert quality.
 *
 * Shows, for each user who hit their quota cap in the last 30 days:
 *   - Whether a predictive alert was sent before they hit the cap
 *   - How many days in advance the alert was sent (lead time)
 *
 * Aggregated metrics:
 *   - Median warning lead-time (days) across all users who hit the cap
 *   - Count: users who got an advance warning vs. users who got no warning
 *   - Alert coverage rate: warned / (warned + not warned)
 *
 * WHY this panel exists:
 *   The Phase 3.4 predictive alert cron job claims to warn users 7 days in
 *   advance. This panel closes the loop — if median lead-time is 1 day or
 *   the coverage rate is low, the EMA model needs to be recalibrated or the
 *   alert window needs to be extended. It is the accountability surface for
 *   the cron's quality promise.
 *
 * WHY client component:
 *   Forecast quality data is fetched client-side so the founder dashboard
 *   can render its other sections (MRR, funnel) immediately while this
 *   panel loads asynchronously. The data is admin-only (non-blocking for
 *   most users).
 *
 * @module components/dashboard/founder/ForecastQualityCard
 */

import { useEffect, useState } from 'react';
import { TrendingUp, AlertTriangle, CheckCircle } from 'lucide-react';

// ============================================================================
// Types
// ============================================================================

/**
 * A single user-cap-hit event with alert timing metadata.
 *
 * Returned by GET /api/admin/forecast-quality (Phase 3.4 admin endpoint).
 */
interface CapHitEvent {
  /** Obfuscated user identifier for display (not the real UUID). */
  userId: string;

  /** Date the user hit their quota cap (YYYY-MM-DD). */
  capHitDate: string;

  /**
   * Date the predictive alert was sent (YYYY-MM-DD), or null if no alert
   * was sent before cap exhaustion.
   */
  alertSentDate: string | null;

  /**
   * Days between alert sent and cap hit. Positive = alert sent in advance.
   * Null when no alert was sent.
   */
  leadTimeDays: number | null;
}

/**
 * Full response from the forecast quality API endpoint.
 */
interface ForecastQualityPayload {
  /** Users who hit their cap in the last 30 days and received a prior alert. */
  warned: CapHitEvent[];

  /** Users who hit their cap but received no predictive alert first. */
  notWarned: CapHitEvent[];

  /** Median lead-time in days across all warned users. Null if no warned users. */
  medianLeadTimeDays: number | null;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Computes the median of an array of numbers.
 * Returns null for an empty array.
 *
 * @param nums - Sorted or unsorted number array
 * @returns Median value or null
 */
function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

// ============================================================================
// Component
// ============================================================================

/**
 * ForecastQualityCard renders the predictive alert quality panel.
 *
 * Fetches data from /api/admin/forecast-quality on mount.
 * Shows a loading skeleton, then the coverage and lead-time metrics.
 *
 * @returns React element
 *
 * @example
 * <ForecastQualityCard />
 */
export function ForecastQualityCard() {
  const [data, setData] = useState<ForecastQualityPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    fetch('/api/admin/forecast-quality')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<ForecastQualityPayload>;
      })
      .then(setData)
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="rounded-xl border border-border/60 bg-card/60 p-5 animate-pulse">
        <div className="h-4 w-40 bg-secondary/60 rounded mb-4" />
        <div className="h-8 w-20 bg-secondary/40 rounded mb-2" />
        <div className="h-4 w-56 bg-secondary/30 rounded" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="rounded-xl border border-border/60 bg-card/60 p-5">
        <p className="text-sm text-muted-foreground">Forecast quality data unavailable.</p>
      </div>
    );
  }

  const totalCapHits = data.warned.length + data.notWarned.length;
  const coverageRate = totalCapHits > 0 ? data.warned.length / totalCapHits : 0;
  const coveragePct = Math.round(coverageRate * 100);

  // Recompute median from warned events in case API doesn't include it.
  const leadTimes = data.warned
    .map((e) => e.leadTimeDays)
    .filter((d): d is number => d !== null);
  const medianLead = data.medianLeadTimeDays ?? median(leadTimes);

  // Coverage color: >= 80% green, >= 50% amber, < 50% red.
  const coverageColor =
    coveragePct >= 80
      ? 'text-green-400'
      : coveragePct >= 50
      ? 'text-amber-400'
      : 'text-red-400';

  return (
    <div className="rounded-xl border border-border/60 bg-card/60 p-5">
      {/* Header */}
      <div className="flex items-center gap-2 mb-4">
        <TrendingUp className="w-4 h-4 text-muted-foreground" aria-hidden="true" />
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
          Forecast Quality (last 30 days)
        </h3>
      </div>

      {totalCapHits === 0 ? (
        <p className="text-sm text-muted-foreground">
          No users hit their quota cap in the last 30 days. Nothing to measure.
        </p>
      ) : (
        <>
          {/* Summary metrics */}
          <div className="grid grid-cols-3 gap-4 mb-6">
            <div>
              <p className="text-xs text-muted-foreground mb-1">Cap hits (30d)</p>
              <p className="text-2xl font-bold text-foreground">{totalCapHits}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1">Alert coverage</p>
              <p className={`text-2xl font-bold ${coverageColor}`}>{coveragePct}%</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1">Median lead time</p>
              <p className="text-2xl font-bold text-foreground">
                {medianLead !== null ? `${medianLead}d` : 'n/a'}
              </p>
            </div>
          </div>

          {/* Warned vs. not-warned breakdown */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <CheckCircle className="w-4 h-4 text-green-400 flex-shrink-0" aria-hidden="true" />
              <span className="text-sm text-foreground">
                {data.warned.length} user{data.warned.length !== 1 ? 's' : ''} warned in advance
              </span>
            </div>
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0" aria-hidden="true" />
              <span className="text-sm text-foreground">
                {data.notWarned.length} user{data.notWarned.length !== 1 ? 's' : ''} hit cap without a prior alert
              </span>
            </div>
          </div>

          {/* Interpretation guidance */}
          {coveragePct < 80 && (
            <div className="mt-4 rounded-lg bg-amber-950/30 border border-amber-800/40 p-3">
              <p className="text-xs text-amber-300">
                Coverage below 80% may indicate the 7-day alert window is too narrow
                or the EMA-blend alpha needs recalibration. Review burn patterns for
                uncovered users.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
