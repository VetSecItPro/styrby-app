/**
 * Costs Screen
 *
 * Main cost dashboard showing spending summaries, agent breakdown,
 * model breakdown, tag breakdown, and a daily cost chart. Users can
 * track their AI coding costs here with configurable time ranges.
 */

import { useState } from 'react';
import { View, Text, ScrollView, RefreshControl, ActivityIndicator, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useCosts, formatTokens, formatCost } from '../../src/hooks/useCosts';
import type { CostTimeRange, ModelCostBreakdown, TagCostBreakdown } from '../../src/hooks/useCosts';
import { useBudgetAlerts, getAlertProgressColor, getPeriodLabel } from '../../src/hooks/useBudgetAlerts';
import type { BudgetAlert } from '../../src/hooks/useBudgetAlerts';
import type { SubscriptionTier } from 'styrby-shared';
import { CostCard } from '../../src/components/CostCard';
import { AgentCostBar, AgentCostBarEmpty } from '../../src/components/AgentCostBar';
import { DailyMiniChart, DailyMiniChartEmpty } from '../../src/components/DailyMiniChart';

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
// Time Range Selector
// ============================================================================

/**
 * Segmented control for selecting the cost dashboard time range.
 *
 * WHY: The web dashboard has a dropdown for 7/30/90 day views. On mobile,
 * a segmented control is more natural and touch-friendly than a dropdown.
 *
 * @param props.selected - Currently selected time range
 * @param props.onSelect - Callback when a new range is selected
 * @returns Rendered segmented control
 */
function TimeRangeSelector({
  selected,
  onSelect,
}: {
  selected: CostTimeRange;
  onSelect: (range: CostTimeRange) => void;
}) {
  const options: { value: CostTimeRange; label: string }[] = [
    { value: 7, label: '7D' },
    { value: 30, label: '30D' },
    { value: 90, label: '90D' },
  ];

  return (
    <View
      className="flex-row bg-zinc-800 rounded-xl p-1"
      accessibilityRole="radiogroup"
      accessibilityLabel="Time range selector"
    >
      {options.map((option) => {
        const isSelected = option.value === selected;
        return (
          <Pressable
            key={option.value}
            onPress={() => onSelect(option.value)}
            className={`flex-1 py-2 rounded-lg items-center ${
              isSelected ? 'bg-brand' : ''
            }`}
            accessibilityRole="radio"
            accessibilityState={{ checked: isSelected }}
            accessibilityLabel={`${option.label} time range`}
          >
            <Text
              className={`text-sm font-semibold ${
                isSelected ? 'text-white' : 'text-zinc-500'
              }`}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// ============================================================================
// Connection Status Indicator
// ============================================================================

/**
 * Small badge showing whether the realtime cost subscription is connected.
 *
 * WHY: The web dashboard shows a connection status badge and live ticker.
 * Mobile users also need to know whether cost data is updating in real time
 * or if they're seeing stale data.
 *
 * @param props.isConnected - Whether the realtime subscription is active
 * @returns Rendered connection status badge
 */
function ConnectionStatus({ isConnected }: { isConnected: boolean }) {
  return (
    <View
      className="flex-row items-center"
      accessibilityLabel={isConnected ? 'Live data connection active' : 'Data connection offline'}
    >
      <View
        className={`w-2 h-2 rounded-full mr-1.5 ${
          isConnected ? 'bg-green-500' : 'bg-orange-500'
        }`}
      />
      <Text className={`text-xs font-medium ${
        isConnected ? 'text-green-500' : 'text-orange-500'
      }`}>
        {isConnected ? 'Live' : 'Offline'}
      </Text>
    </View>
  );
}

// ============================================================================
// Collapsible Section
// ============================================================================

/**
 * A collapsible section with a header that toggles visibility of children.
 *
 * @param props.title - Section header text
 * @param props.isExpanded - Whether the section is currently expanded
 * @param props.onToggle - Callback to toggle expanded state
 * @param props.children - Content to show when expanded
 * @returns Rendered collapsible section
 */
function CollapsibleSection({
  title,
  isExpanded,
  onToggle,
  children,
}: {
  title: string;
  isExpanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <View className="bg-background-secondary rounded-xl">
      <Pressable
        onPress={onToggle}
        className="flex-row items-center justify-between p-4 active:opacity-80"
        accessibilityRole="button"
        accessibilityLabel={`${title}, ${isExpanded ? 'collapse' : 'expand'}`}
        accessibilityState={{ expanded: isExpanded }}
      >
        <Text className="text-zinc-400 text-sm font-medium">{title}</Text>
        <Ionicons
          name={isExpanded ? 'chevron-up' : 'chevron-down'}
          size={18}
          color="#71717a"
        />
      </Pressable>
      {isExpanded && <View className="px-4 pb-4">{children}</View>}
    </View>
  );
}

// ============================================================================
// Model Cost Row
// ============================================================================

/**
 * Displays a single row in the cost-by-model breakdown.
 *
 * @param props.item - Model cost breakdown data
 * @returns Rendered model cost row
 */
function ModelCostRow({ item }: { item: ModelCostBreakdown }) {
  return (
    <View className="flex-row items-center justify-between py-2.5 border-b border-zinc-800/50">
      <View className="flex-1 mr-3">
        <Text className="text-white text-sm font-medium" numberOfLines={1}>
          {item.model}
        </Text>
        <Text className="text-zinc-500 text-xs mt-0.5">
          {item.requestCount} req  ·  {formatTokens(item.inputTokens + item.outputTokens)} tokens
        </Text>
      </View>
      <Text className="text-white text-sm font-semibold">
        {formatCost(item.cost)}
      </Text>
    </View>
  );
}

// ============================================================================
// Tag Cost Row
// ============================================================================

/**
 * Displays a single row in the cost-by-tag breakdown.
 *
 * @param props.item - Tag cost breakdown data
 * @returns Rendered tag cost row
 */
function TagCostRow({ item }: { item: TagCostBreakdown }) {
  return (
    <View className="flex-row items-center justify-between py-2.5 border-b border-zinc-800/50">
      <View className="flex-1 mr-3">
        <View className="flex-row items-center">
          <Ionicons name="pricetag" size={12} color="#71717a" />
          <Text className="text-white text-sm font-medium ml-1.5" numberOfLines={1}>
            {item.tag}
          </Text>
        </View>
        <Text className="text-zinc-500 text-xs mt-0.5">
          {item.sessionCount} session{item.sessionCount !== 1 ? 's' : ''}
        </Text>
      </View>
      <Text className="text-white text-sm font-semibold">
        {formatCost(item.cost)}
      </Text>
    </View>
  );
}

// ============================================================================
// Model Pricing Reference
// ============================================================================

/**
 * AI model pricing entry for the reference table.
 * Prices are in USD per 1 million tokens.
 */
interface ModelPricingEntry {
  /** Display name of the model (e.g. 'Claude 3.5 Sonnet') */
  name: string;
  /** AI provider name for grouping */
  provider: string;
  /** Cost per 1M input tokens in USD */
  inputPer1M: number;
  /** Cost per 1M output tokens in USD */
  outputPer1M: number;
}

/**
 * Static model pricing data for the reference table.
 *
 * WHY static: Pricing data is not fetched from the database — it's a
 * reference table that matches what the CLI uses to calculate costs.
 * Updated here when provider pricing changes.
 *
 * Last verified: 2026-02-05
 * Sources: anthropic.com/pricing, openai.com/pricing, ai.google.dev/pricing
 */
const MODEL_PRICING: ModelPricingEntry[] = [
  // Anthropic
  { name: 'Claude 3.5 Sonnet', provider: 'Anthropic', inputPer1M: 3.0, outputPer1M: 15.0 },
  { name: 'Claude 3.5 Haiku', provider: 'Anthropic', inputPer1M: 0.8, outputPer1M: 4.0 },
  { name: 'Claude 3 Opus', provider: 'Anthropic', inputPer1M: 15.0, outputPer1M: 75.0 },
  // OpenAI
  { name: 'GPT-4o', provider: 'OpenAI', inputPer1M: 2.5, outputPer1M: 10.0 },
  { name: 'o1', provider: 'OpenAI', inputPer1M: 15.0, outputPer1M: 60.0 },
  // Google
  { name: 'Gemini 1.5 Pro', provider: 'Google', inputPer1M: 1.25, outputPer1M: 5.0 },
  { name: 'Gemini 1.5 Flash', provider: 'Google', inputPer1M: 0.075, outputPer1M: 0.3 },
];

/**
 * Formats a price per million tokens for table display.
 * Shows up to 3 decimal places to handle sub-cent prices (e.g. $0.075).
 *
 * @param price - USD price per 1M tokens
 * @returns Formatted string like '$3.00' or '$0.075'
 */
function formatPricePer1M(price: number): string {
  if (price < 0.01) return `$${price.toFixed(3)}`;
  if (price < 1) return `$${price.toFixed(3)}`;
  return `$${price.toFixed(2)}`;
}

/**
 * A single row in the model pricing reference table.
 *
 * @param props.entry - The model pricing data to display
 * @returns Rendered table row
 */
function ModelPricingRow({ entry }: { entry: ModelPricingEntry }) {
  return (
    <View className="flex-row items-center py-2.5 border-b border-zinc-800/50">
      <View className="flex-1 mr-2">
        <Text className="text-white text-xs font-medium" numberOfLines={1}>
          {entry.name}
        </Text>
        <Text className="text-zinc-500 text-xs">{entry.provider}</Text>
      </View>
      <Text className="text-zinc-300 text-xs font-medium w-16 text-right">
        {formatPricePer1M(entry.inputPer1M)}
      </Text>
      <Text className="text-zinc-300 text-xs font-medium w-16 text-right">
        {formatPricePer1M(entry.outputPer1M)}
      </Text>
    </View>
  );
}

// ============================================================================
// Main Screen
// ============================================================================

/**
 * Cost Dashboard Screen
 *
 * Displays:
 * - Connection status indicator (live/offline)
 * - Time range selector (7D / 30D / 90D)
 * - Cost summaries for today, this week, and this month
 * - Cost breakdown by agent with visual progress bars
 * - Cost breakdown by model (collapsible)
 * - Cost breakdown by tag (collapsible)
 * - Daily cost chart for the selected time range
 * - Budget alerts summary with link to full management screen
 * - Pull-to-refresh functionality
 */
export default function CostsScreen() {
  const { data, isLoading, isRefreshing, error, refresh, timeRange, setTimeRange, isRealtimeConnected } = useCosts();
  const { alerts, tier, isLoading: alertsLoading } = useBudgetAlerts();
  const router = useRouter();
  const [modelExpanded, setModelExpanded] = useState(false);
  const [tagExpanded, setTagExpanded] = useState(false);
  /**
   * Whether the Model Pricing reference table is expanded.
   * WHY: The pricing table is reference data — useful occasionally but not
   * the primary content. Collapsible keeps the dashboard clean by default.
   */
  const [pricingExpanded, setPricingExpanded] = useState(false);

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
      {/* Header: Connection Status + Time Range */}
      <View className="px-4 pt-4 mb-3">
        <View className="flex-row items-center justify-between mb-3">
          <Text className="text-zinc-400 text-sm font-medium">SPENDING</Text>
          <ConnectionStatus isConnected={isRealtimeConnected} />
        </View>
        <TimeRangeSelector selected={timeRange} onSelect={setTimeRange} />
      </View>

      {/* Cost Summary Cards */}
      <View className="px-4">

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

        {/* 90 Days - full width compact card */}
        <View className="mt-3">
          <CostCard
            title="Last 90 Days"
            amount={data.quarter.totalCost}
            subtitle={`${data.quarter.requestCount} req`}
            icon="calendar-number-outline"
            iconColor="#a855f7"
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

      {/* Cost by Model (Collapsible) */}
      <View className="px-4 mt-6">
        <CollapsibleSection
          title="COST BY MODEL"
          isExpanded={modelExpanded}
          onToggle={() => setModelExpanded((v) => !v)}
        >
          {data.byModel.length > 0 ? (
            data.byModel.map((item) => (
              <ModelCostRow key={item.model} item={item} />
            ))
          ) : (
            <Text className="text-zinc-500 text-sm text-center py-4">
              No model data yet
            </Text>
          )}
        </CollapsibleSection>
      </View>

      {/* Cost by Tag (Collapsible) */}
      <View className="px-4 mt-6">
        <CollapsibleSection
          title="COST BY TAG"
          isExpanded={tagExpanded}
          onToggle={() => setTagExpanded((v) => !v)}
        >
          {data.byTag.length > 0 ? (
            data.byTag.map((item) => (
              <TagCostRow key={item.tag} item={item} />
            ))
          ) : (
            <Text className="text-zinc-500 text-sm text-center py-4">
              Tag sessions from the CLI to track costs per project
            </Text>
          )}
        </CollapsibleSection>
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

      {/* Model Pricing Reference Table (Collapsible) */}
      <View className="px-4 mt-6 mb-6">
        <CollapsibleSection
          title="MODEL PRICING REFERENCE"
          isExpanded={pricingExpanded}
          onToggle={() => setPricingExpanded((v) => !v)}
        >
          {/* Table Header */}
          <View className="flex-row items-center pb-2 border-b border-zinc-700 mb-1">
            <Text className="flex-1 text-zinc-500 text-xs font-semibold mr-2">Model</Text>
            <Text className="text-zinc-500 text-xs font-semibold w-16 text-right">Input/1M</Text>
            <Text className="text-zinc-500 text-xs font-semibold w-16 text-right">Output/1M</Text>
          </View>

          {/* Pricing Rows */}
          {MODEL_PRICING.map((entry) => (
            <ModelPricingRow key={entry.name} entry={entry} />
          ))}

          {/* Footer note */}
          <Text className="text-zinc-600 text-xs mt-3 text-center">
            Prices in USD per 1M tokens · Last verified Feb 2026
          </Text>
        </CollapsibleSection>
      </View>
    </ScrollView>
  );
}
