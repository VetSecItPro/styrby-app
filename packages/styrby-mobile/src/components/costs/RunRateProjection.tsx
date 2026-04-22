/**
 * RunRateProjection (Mobile)
 *
 * React Native parity for the web RunRateProjection component.
 * Shows a forward-looking spend projection at the top of the costs screen.
 *
 * Algorithm mirrors the web version:
 *   avgDailySpend = last7dSpend / 7
 *   daysUntilCap  = (monthlyCap - monthToDateSpend) / avgDailySpend
 *   capDate       = today + daysUntilCap
 *
 * Hides when:
 *   - fewer than 3 days of history
 *   - avgDailySpend === 0
 *   - no tier cap configured
 *   - daysUntilCap > 45 (too far out to be useful)
 *
 * @module components/costs/RunRateProjection
 */

import { View, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { BillingModel } from 'styrby-shared';

// ============================================================================
// Types
// ============================================================================

/**
 * Props for {@link RunRateProjection}.
 */
export interface RunRateProjectionProps {
  /** Sum of cost_usd over the last 7 calendar days. Null if insufficient history. */
  last7dSpendUsd: number | null;
  /** Number of distinct days with records in the last 7d. Show if >= 3. */
  historyDays: number;
  /** Month-to-date spend in USD. */
  monthToDateSpendUsd: number;
  /** Monthly cap in USD. Null when no cap configured. */
  monthlyCap: number | null;
  /** Dominant billing model — 'subscription' switches to quota-fraction copy. */
  billingModel: BillingModel;
  /** Avg daily quota fraction [0, 1] for subscription mode. */
  avgDailySubscriptionFraction?: number | null;
  /** Total subscription quota (1.0 = 100%). */
  subscriptionQuota?: number | null;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Format a future date as "Mon DD" (e.g. "Oct 28").
 *
 * @param date - Target date
 * @returns Short month + day string
 */
function formatCapDate(date: Date): string {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[date.getMonth()]} ${date.getDate()}`;
}

// ============================================================================
// Component
// ============================================================================

/**
 * Renders a run-rate projection banner on the mobile cost screen.
 *
 * Returns null when conditions to show are not met.
 *
 * @param props - Projection props
 * @returns Projection view or null
 *
 * @example
 * <RunRateProjection
 *   last7dSpendUsd={21.40}
 *   historyDays={7}
 *   monthToDateSpendUsd={37.00}
 *   monthlyCap={49.00}
 *   billingModel="api-key"
 * />
 */
export function RunRateProjection({
  last7dSpendUsd,
  historyDays,
  monthToDateSpendUsd,
  monthlyCap,
  billingModel,
  avgDailySubscriptionFraction,
  subscriptionQuota,
}: RunRateProjectionProps) {
  // ── Gate: need at least 3 days of history ──────────────────────────────────
  if (historyDays < 3) return null;
  if (last7dSpendUsd === null) return null;

  // ── Subscription variant ───────────────────────────────────────────────────
  if (billingModel === 'subscription') {
    if (
      avgDailySubscriptionFraction == null ||
      avgDailySubscriptionFraction <= 0 ||
      subscriptionQuota == null
    ) {
      return null;
    }

    const now = new Date();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const remainingDays = daysInMonth - now.getDate() + 1;
    const projectedFractionUsed = avgDailySubscriptionFraction * remainingDays;
    const projectedPct = Math.min(Math.round(projectedFractionUsed * subscriptionQuota * 100), 200);

    if (projectedPct < 50) return null;

    const isWarning = projectedPct >= 90;
    const bgColor = isWarning ? '#451a03' : '#172554';
    const borderColor = isWarning ? '#92400e' : '#1e3a8a';
    const textColor = isWarning ? '#fde68a' : '#93c5fd';

    return (
      <View
        className="mx-4 mb-3 rounded-xl flex-row items-start gap-2 p-3"
        style={{ backgroundColor: bgColor, borderWidth: 1, borderColor }}
        accessibilityRole="alert"
        accessibilityLabel="Subscription quota run rate projection"
      >
        <Ionicons
          name={isWarning ? 'warning-outline' : 'information-circle-outline'}
          size={16}
          color={textColor}
          style={{ marginTop: 2 }}
        />
        <Text className="flex-1 text-xs leading-5" style={{ color: textColor }}>
          At this pace you&apos;ll use approximately{' '}
          <Text style={{ fontWeight: '700' }}>{projectedPct}%</Text> of your subscription
          quota this month.
        </Text>
      </View>
    );
  }

  // ── API-key / credit / free variant ───────────────────────────────────────
  if (!monthlyCap || monthlyCap <= 0) return null;

  const avgDailySpend = last7dSpendUsd / 7;
  if (avgDailySpend <= 0) return null;

  const remaining = monthlyCap - monthToDateSpendUsd;

  if (remaining <= 0) {
    // Over cap
    return (
      <View
        className="mx-4 mb-3 rounded-xl flex-row items-start gap-2 p-3"
        style={{ backgroundColor: '#450a0a', borderWidth: 1, borderColor: '#7f1d1d' }}
        accessibilityRole="alert"
      >
        <Ionicons name="close-circle-outline" size={16} color="#fca5a5" style={{ marginTop: 2 }} />
        <Text className="flex-1 text-xs leading-5" style={{ color: '#fca5a5' }}>
          You&apos;ve exceeded your monthly cap of{' '}
          <Text style={{ fontWeight: '700' }}>${monthlyCap.toFixed(2)}</Text>. Current:{' '}
          <Text style={{ fontWeight: '700' }}>${monthToDateSpendUsd.toFixed(2)}</Text>.
        </Text>
      </View>
    );
  }

  const daysUntilCap = remaining / avgDailySpend;
  const daysRounded = Math.round(daysUntilCap);

  if (daysRounded > 45) return null;

  const capDate = new Date();
  capDate.setDate(capDate.getDate() + daysRounded);

  const isUrgent = daysRounded <= 7;
  const isMedium = daysRounded <= 14;
  const bgColor = isUrgent ? '#450a0a' : isMedium ? '#451a03' : '#172554';
  const borderColor = isUrgent ? '#7f1d1d' : isMedium ? '#92400e' : '#1e3a8a';
  const textColor = isUrgent ? '#fca5a5' : isMedium ? '#fde68a' : '#93c5fd';

  return (
    <View
      className="mx-4 mb-3 rounded-xl flex-row items-start gap-2 p-3"
      style={{ backgroundColor: bgColor, borderWidth: 1, borderColor }}
      accessibilityRole="alert"
      accessibilityLabel="Monthly spending run rate projection"
    >
      <Ionicons name="trending-up-outline" size={16} color={textColor} style={{ marginTop: 2 }} />
      <Text className="flex-1 text-xs leading-5" style={{ color: textColor }}>
        At current burn rate, you&apos;ll hit your cap on{' '}
        <Text style={{ fontWeight: '700' }}>{formatCapDate(capDate)}</Text> (
        {daysRounded} {daysRounded === 1 ? 'day' : 'days'} away).
        Avg: <Text style={{ fontWeight: '700' }}>${avgDailySpend.toFixed(2)}/day</Text>.
      </Text>
    </View>
  );
}
