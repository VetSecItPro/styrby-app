/**
 * Compact budget-alerts summary card for the costs dashboard.
 *
 * Displays different content based on state:
 * - Loading: skeleton placeholder
 * - Free tier or no alerts: "Set up budget alerts" link
 * - Has alerts: shows the most critical alert (highest % used) as a card
 *
 * WHY: We show a single most-critical alert rather than the full list because
 * the costs screen is already dense. Users drill into the dedicated screen
 * via the "Manage Alerts" affordance for the full picture.
 *
 * @module components/costs/BudgetAlertsSummary
 */

import { View, Text, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getAlertProgressColor, getPeriodLabel } from '../../hooks/useBudgetAlerts';
import type { BudgetAlertsSummaryProps } from '../../types/costs';
import { formatBudgetCost } from './pricing';

/**
 * Loading skeleton shown while alerts are being fetched.
 */
function LoadingSkeleton() {
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

/**
 * Empty/setup CTA shown when the user has no active alerts (or is on free tier).
 */
function SetupPrompt({
  tier,
  onPress,
}: {
  tier: BudgetAlertsSummaryProps['tier'];
  onPress: () => void;
}) {
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

/**
 * Renders the budget-alerts summary card. Routes to one of three states
 * (loading / setup / critical-alert) based on props.
 *
 * @param props - {@link BudgetAlertsSummaryProps}
 * @returns Rendered card
 */
export function BudgetAlertsSummary({ alerts, tier, isLoading, onPress }: BudgetAlertsSummaryProps) {
  if (isLoading) return <LoadingSkeleton />;

  const activeAlerts = alerts.filter((a) => a.enabled);
  if (activeAlerts.length === 0) {
    return <SetupPrompt tier={tier} onPress={onPress} />;
  }

  // WHY: Find the most critical alert (highest percentUsed) to show as the
  // compact summary. This surfaces the alert most likely to need attention.
  const mostCritical = activeAlerts.reduce((prev, curr) =>
    curr.percentUsed > prev.percentUsed ? curr : prev
  );

  const progressColor = getAlertProgressColor(mostCritical.percentUsed);
  const progressWidth = Math.min(mostCritical.percentUsed, 100);

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
              {formatBudgetCost(mostCritical.currentSpend)} / {formatBudgetCost(mostCritical.threshold)}{' '}
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
