/**
 * SessionCostRow — session list item with inline cost pill.
 *
 * Renders a tappable row for a session showing:
 *   - Agent color dot + agent name
 *   - Session title (or truncated date)
 *   - Inline cost pill ($X.XX or "subscription" badge)
 *   - Right-chevron indicating drill-down available
 *
 * WHY a separate component: The session list (sessions tab) and the costs
 * screen both need per-session cost display. Having a single reusable row
 * component keeps the two surfaces visually consistent without duplicating
 * the formatting logic.
 *
 * @module components/costs/SessionCostRow
 */

import { View, Text, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import type { AgentType, BillingModel } from 'styrby-shared';

// ============================================================================
// Types
// ============================================================================

/**
 * Data for a single session row.
 */
export interface SessionCostData {
  /** Supabase UUID of the session. */
  id: string;
  /** Session title, or null to fall back to a formatted date. */
  title: string | null;
  /** Agent type string. */
  agentType: AgentType;
  /** Agent display name (e.g. "Claude Code"). */
  agentLabel: string;
  /** Brand hex color for the agent. */
  agentColor: string;
  /** Total cost in USD. Zero for subscription/free billing models. */
  totalCostUsd: number;
  /** Billing model for cost interpretation. */
  billingModel: BillingModel;
  /** Session start ISO timestamp. */
  startedAt: string;
  /** Input token count for the session. */
  inputTokens: number;
  /** Output token count for the session. */
  outputTokens: number;
  /** Cached read tokens. */
  cacheReadTokens: number;
}

/**
 * Props for {@link SessionCostRow}.
 */
export interface SessionCostRowProps {
  /** Session data to display. */
  session: SessionCostData;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Formats a session cost for display.
 *
 * WHY: Subscription billing shows "Sub" (not $0.00) to avoid confusing
 * users who expect to see a USD amount. Free shows "Free". API-key shows
 * the dollar amount with 4 decimal places if < $0.01.
 *
 * @param costUsd - Total cost in USD.
 * @param billingModel - Which billing model applies.
 * @returns Formatted cost string.
 */
function formatSessionCost(costUsd: number, billingModel: BillingModel): string {
  switch (billingModel) {
    case 'subscription':
      return 'Sub';
    case 'free':
      return 'Free';
    case 'credit':
      return `$${costUsd.toFixed(3)} cr`;
    case 'api-key':
    default:
      if (costUsd < 0.01 && costUsd > 0) {
        return `$${costUsd.toFixed(4)}`;
      }
      return `$${costUsd.toFixed(2)}`;
  }
}

/**
 * Returns a NativeWind text color class for the cost pill.
 *
 * WHY separate colors: Green for free/subscription (no variable cost),
 * zinc for cheap API calls, orange for sessions that cost noticeably.
 */
function costPillColor(costUsd: number, billingModel: BillingModel): string {
  if (billingModel === 'subscription' || billingModel === 'free') {
    return 'text-green-400';
  }
  if (costUsd >= 1.0) return 'text-orange-400';
  return 'text-zinc-300';
}

// ============================================================================
// Component
// ============================================================================

/**
 * SessionCostRow renders one row in a session-cost list.
 *
 * Tapping navigates to `/session/:id` for the full token breakdown.
 *
 * @param props - See {@link SessionCostRowProps}
 * @returns Pressable row
 *
 * @example
 * <SessionCostRow session={sessionData} />
 */
export function SessionCostRow({ session }: SessionCostRowProps) {
  const router = useRouter();

  const costLabel = formatSessionCost(session.totalCostUsd, session.billingModel);
  const costColor = costPillColor(session.totalCostUsd, session.billingModel);

  // Derive a human-readable date fallback when title is absent.
  const displayTitle =
    session.title ||
    new Date(session.startedAt).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });

  return (
    <Pressable
      onPress={() => router.push(`/session/${session.id}` as never)}
      className="flex-row items-center px-4 py-3 border-b border-zinc-800/60 active:bg-zinc-900"
      accessibilityRole="button"
      accessibilityLabel={`${displayTitle}, ${costLabel}`}
    >
      {/* Agent dot */}
      <View
        className="w-2.5 h-2.5 rounded-full mr-3 shrink-0"
        style={{ backgroundColor: session.agentColor }}
      />

      {/* Title + agent label */}
      <View className="flex-1 mr-3">
        <Text
          className="text-white text-sm font-medium"
          numberOfLines={1}
          ellipsizeMode="tail"
        >
          {displayTitle}
        </Text>
        <Text className="text-zinc-500 text-xs mt-0.5">{session.agentLabel}</Text>
      </View>

      {/* Cost pill */}
      <Text className={`text-sm font-semibold mr-2 ${costColor}`}>
        {costLabel}
      </Text>

      <Ionicons name="chevron-forward" size={14} color="#71717a" />
    </Pressable>
  );
}
