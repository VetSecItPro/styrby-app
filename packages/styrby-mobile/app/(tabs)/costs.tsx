/**
 * Costs Screen
 *
 * Main cost dashboard showing spending summaries, agent breakdown,
 * and a 7-day cost chart. Users can track their AI coding costs here.
 */

import { View, Text, ScrollView, RefreshControl, ActivityIndicator, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useCosts, formatCost, formatTokens } from '../../src/hooks/useCosts';
import { useBudgetAlerts, getAlertProgressColor, getPeriodLabel } from '../../src/hooks/useBudgetAlerts';
import type { BudgetAlert } from '../../src/hooks/useBudgetAlerts';
import type { SubscriptionTier } from 'styrby-shared';
import { CostCard } from '../../src/components/CostCard';
import { AgentCostBar, AgentCostBarEmpty } from '../../src/components/AgentCostBar';
import { DailyMiniChart, DailyMiniChartEmpty, DailyMiniChartSkeleton } from '../../src/components/DailyMiniChart';

// ============================================================================
// Budget Alerts Summary (inline component for costs screen)
// ============================================================================

/**
 * Props for the BudgetAlertsSummary component.
 */
interface BudgetAlertsSummaryProps {
  /** All budget alerts for the current user */
  alerts: BudgetAlert[];
  /** User's subscription tier */
  tier: SubscriptionTier;
  /** Whether alerts data is still loading */
  isLoading: boolean;
  /** Callback when the section is pressed (navigate to budget-alerts screen) */
  onPress: () => void;
}

/**
 * Compact budget alerts summary for the costs dashboard.
 *
 * Displays different content based on state:
 * - Loading: Skeleton placeholder
 * - Free tier: "Set up budget alerts" link prompting upgrade
 * - No alerts (paid tier): "Set up budget alerts" link
 * - Has alerts: Shows the most critical alert (highest % used) as a compact card
 *
 * WHY: We show the single most critical alert rather than all alerts because
 * the costs screen is already dense with data. The full list is accessible
 * via the "Manage Alerts" button which navigates to the dedicated screen.
 *
 * @param props - Component props
 * @returns Rendered budget alerts summary
 */
function BudgetAlertsSummary({ alerts, tier, isLoading, onPress }: BudgetAlertsSummaryProps) {
  // Loading skeleton
  if (isLoading) {
    return (
      <View className="bg-background-secondary rounded-xl p-4 flex-row items-center">
        <View className="w-10 h-10 rounded-xl bg-zinc-800 mr-3" />
        <View className="flex-1">
          <View className="w-24 h-4 bg-zinc-800 rounded mb-1.5" />
          <View className="w-40 h-3 bg-zinc-800 rounded" />
        </View>
      </View>
    );
  }

  // No alerts or free tier: show setup link
  const activeAlerts = alerts.filter((a) => a.enabled);
  if (activeAlerts.length === 0) {
    return (
      <Pressable
        onPress={onPress}
        className="bg-background-secondary rounded-xl p-4 flex-row items-center active:opacity-80"
        accessibilityRole="button"
        accessibilityLabel={
          tier === 'free'
            ? 'Set up budget alerts, requires Pro plan'
            : 'Set up budget alerts'
        }
      >
        <View className="w-10 h-10 rounded-xl bg-yellow-500/20 items-center justify-center mr-3">
          <Ionicons name="notifications" size={20} color="#eab308" />
        </View>
        <View className="flex-1">
          <Text className="text-white font-medium">
            {tier === 'free' ? 'Budget Alerts' : 'Set Up Budget Alerts'}
          </Text>
          <Text className="text-zinc-500 text-sm">
            {tier === 'free'
              ? 'Upgrade to Pro to monitor spending'
              : 'Create your first alert to track spending'}
          </Text>
        </View>
        <Ionicons name="chevron-forward" size={20} color="#71717a" />
      </Pressable>
    );
  }

  // WHY: Find the most critical alert (highest percentUsed) to show as the
  // compact summary. This surfaces the alert most likely to need attention.
  const mostCritical = activeAlerts.reduce((prev, curr) =>
    curr.percentUsed > prev.percentUsed ? curr : prev
  );

  const progressColor = getAlertProgressColor(mostCritical.percentUsed);
  const progressWidth = Math.min(mostCritical.percentUsed, 100);

  /**
   * Format a cost value for compact display.
   *
   * @param value - Cost in USD
   * @returns Formatted string
   */
  const fmtCost = (value: number): string => {
    if (value === 0) return '$0.00';
    if (value < 0.01) return `$${value.toFixed(4)}`;
    if (value < 1) return `$${value.toFixed(3)}`;
    return `$${value.toFixed(2)}`;
  };

  return (
    <Pressable
      onPress={onPress}
      className="bg-background-secondary rounded-xl p-4 active:opacity-80"
      accessibilityRole="button"
      accessibilityLabel={`Budget alerts: ${mostCritical.name} at ${mostCritical.percentUsed.toFixed(0)}% used. Tap to manage alerts.`}
    >
      {/* Most Critical Alert */}
      <View className="flex-row items-center justify-between mb-2.5">
        <View className="flex-row items-center flex-1">
          <View className="w-8 h-8 rounded-lg bg-yellow-500/20 items-center justify-center mr-2.5">
            <Ionicons
              name={mostCritical.percentUsed > 100 ? 'warning' : 'notifications'}
              size={16}
              color={mostCritical.percentUsed > 100 ? '#ef4444' : '#eab308'}
            />
          </View>
          <View className="flex-1">
            <Text className="text-white font-medium text-sm" numberOfLines={1}>
              {mostCritical.name}
            </Text>
            <Text className="text-zinc-500 text-xs">
              {fmtCost(mostCritical.currentSpend)} / {fmtCost(mostCritical.threshold)}{' '}
              {getPeriodLabel(mostCritical.period)}
            </Text>
          </View>
        </View>
        <Text className="text-sm font-semibold ml-2" style={{ color: progressColor }}>
          {mostCritical.percentUsed.toFixed(0)}%
        </Text>
      </View>

      {/* Mini Progress Bar */}
      <View className="h-1.5 bg-zinc-800 rounded-full overflow-hidden mb-3">
        <View
          className="h-full rounded-full"
          style={{
            width: `${progressWidth}%`,
            backgroundColor: progressColor,
            minWidth: mostCritical.currentSpend > 0 ? 3 : 0,
          }}
        />
      </View>

      {/* Manage Button */}
      <View className="flex-row items-center justify-between">
        <Text className="text-zinc-500 text-xs">
          {activeAlerts.length} active alert{activeAlerts.length !== 1 ? 's' : ''}
        </Text>
        <View className="flex-row items-center">
          <Text className="text-brand text-xs font-medium mr-1">Manage Alerts</Text>
          <Ionicons name="chevron-forward" size={14} color="#f97316" />
        </View>
      </View>
    </Pressable>
  );
}

// ============================================================================
// Main Screen
// ============================================================================

/**
 * Cost Dashboard Screen
 *
 * Displays:
 * - Cost summaries for today, this week, and this month
 * - Cost breakdown by agent with visual progress bars
 * - 7-day cost chart
 * - Budget alerts summary with link to full management screen
 * - Pull-to-refresh functionality
 */
export default function CostsScreen() {
  const { data, isLoading, isRefreshing, error, refresh } = useCosts();
  const { alerts, tier, isLoading: alertsLoading } = useBudgetAlerts();
  const router = useRouter();

  // Loading state
  if (isLoading) {
    return (
      <View className="flex-1 bg-background items-center justify-center">
        <ActivityIndicator size="large" color="#f97316" />
        <Text className="text-zinc-500 mt-4">Loading costs...</Text>
      </View>
    );
  }

  // Error state
  if (error) {
    return (
      <View className="flex-1 bg-background items-center justify-center px-6">
        <Ionicons name="alert-circle-outline" size={48} color="#ef4444" />
        <Text className="text-white text-lg font-semibold mt-4">Failed to Load Costs</Text>
        <Text className="text-zinc-500 text-center mt-2">{error}</Text>
        <Pressable
          onPress={refresh}
          className="bg-brand px-6 py-3 rounded-xl mt-6 active:opacity-80"
        >
          <Text className="text-white font-semibold">Try Again</Text>
        </Pressable>
      </View>
    );
  }

  // No data state (shouldn't happen normally, but handle gracefully)
  if (!data) {
    return (
      <View className="flex-1 bg-background items-center justify-center">
        <Text className="text-zinc-500">No cost data available</Text>
      </View>
    );
  }

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerStyle={{ paddingBottom: 24 }}
      refreshControl={
        <RefreshControl
          refreshing={isRefreshing}
          onRefresh={refresh}
          tintColor="#f97316"
          colors={['#f97316']}
        />
      }
    >
      {/* Cost Summary Cards */}
      <View className="px-4 pt-4">
        <Text className="text-zinc-400 text-sm font-medium mb-3">SPENDING</Text>

        {/* Today - featured card */}
        <CostCard
          title="Today"
          amount={data.today.totalCost}
          subtitle={`${data.today.requestCount} requests`}
          icon="today"
          iconColor="#f97316"
        />

        {/* Week and Month - compact row */}
        <View className="flex-row mt-3 gap-3">
          <CostCard
            title="This Week"
            amount={data.week.totalCost}
            subtitle={`${data.week.requestCount} req`}
            icon="calendar"
            iconColor="#3b82f6"
            compact
          />
          <CostCard
            title="This Month"
            amount={data.month.totalCost}
            subtitle={`${data.month.requestCount} req`}
            icon="calendar-number"
            iconColor="#22c55e"
            compact
          />
        </View>
      </View>

      {/* 7-Day Chart */}
      <View className="px-4 mt-6">
        {data.dailyCosts.length > 0 ? (
          <DailyMiniChart data={data.dailyCosts} />
        ) : (
          <DailyMiniChartEmpty />
        )}
      </View>

      {/* Agent Breakdown */}
      <View className="px-4 mt-6">
        <Text className="text-zinc-400 text-sm font-medium mb-3">BY AGENT</Text>
        <View className="bg-background-secondary rounded-xl p-4">
          {data.byAgent.length > 0 ? (
            data.byAgent.map((agent) => (
              <AgentCostBar
                key={agent.agent}
                agent={agent.agent}
                cost={agent.cost}
                percentage={agent.percentage}
                requestCount={agent.requestCount}
              />
            ))
          ) : (
            <AgentCostBarEmpty />
          )}
        </View>
      </View>

      {/* Token Usage Summary */}
      <View className="px-4 mt-6">
        <Text className="text-zinc-400 text-sm font-medium mb-3">TOKEN USAGE (MONTH)</Text>
        <View className="bg-background-secondary rounded-xl p-4">
          <View className="flex-row">
            {/* Input Tokens */}
            <View className="flex-1 items-center">
              <View className="flex-row items-center mb-1">
                <Ionicons name="arrow-up-circle" size={16} color="#3b82f6" />
                <Text className="text-zinc-400 text-xs ml-1">Input</Text>
              </View>
              <Text className="text-white font-semibold text-lg">
                {formatTokens(data.month.inputTokens)}
              </Text>
            </View>

            {/* Divider */}
            <View className="w-px bg-zinc-800 mx-4" />

            {/* Output Tokens */}
            <View className="flex-1 items-center">
              <View className="flex-row items-center mb-1">
                <Ionicons name="arrow-down-circle" size={16} color="#22c55e" />
                <Text className="text-zinc-400 text-xs ml-1">Output</Text>
              </View>
              <Text className="text-white font-semibold text-lg">
                {formatTokens(data.month.outputTokens)}
              </Text>
            </View>

            {/* Divider */}
            <View className="w-px bg-zinc-800 mx-4" />

            {/* Total */}
            <View className="flex-1 items-center">
              <View className="flex-row items-center mb-1">
                <Ionicons name="analytics" size={16} color="#f97316" />
                <Text className="text-zinc-400 text-xs ml-1">Total</Text>
              </View>
              <Text className="text-white font-semibold text-lg">
                {formatTokens(data.month.inputTokens + data.month.outputTokens)}
              </Text>
            </View>
          </View>
        </View>
      </View>

      {/* Budget Alerts Section */}
      <View className="px-4 mt-6">
        <Text className="text-zinc-400 text-sm font-medium mb-3">BUDGET ALERTS</Text>
        <BudgetAlertsSummary
          alerts={alerts}
          tier={tier}
          isLoading={alertsLoading}
          onPress={() => router.push('/budget-alerts')}
        />
      </View>
    </ScrollView>
  );
}
