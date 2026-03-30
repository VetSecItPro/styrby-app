/**
 * Costs Screen
 *
 * Main cost dashboard showing spending summaries, agent breakdown,
 * model breakdown, tag breakdown, a daily cost chart, team cost breakdown
 * (Power tier + team required), and a cost data export button (Power tier).
 *
 * Users can track their AI coding costs here with configurable time ranges.
 */

import { useState, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  RefreshControl,
  ActivityIndicator,
  Pressable,
  ActionSheetIOS,
  Platform,
  Alert,
  Share,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useCosts, formatTokens, formatCost } from '../../src/hooks/useCosts';
import type { CostTimeRange, ModelCostBreakdown, TagCostBreakdown } from '../../src/hooks/useCosts';
import { useBudgetAlerts, getAlertProgressColor, getPeriodLabel } from '../../src/hooks/useBudgetAlerts';
import type { BudgetAlert } from '../../src/hooks/useBudgetAlerts';
import type { SubscriptionTier, ModelPricingEntry } from 'styrby-shared';
import { MODEL_PRICING_TABLE, PROVIDER_DISPLAY_NAMES, STATIC_PRICING_LAST_VERIFIED } from 'styrby-shared';
import { CostCard } from '../../src/components/CostCard';
import { AgentCostBar, AgentCostBarEmpty } from '../../src/components/AgentCostBar';
import { DailyMiniChart, DailyMiniChartEmpty } from '../../src/components/DailyMiniChart';
import { useTeamCosts } from '../../src/hooks/useTeamCosts';
import type { MemberCostRow } from '../../src/hooks/useTeamCosts';
import { supabase } from '../../src/lib/supabase';

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

// WHY: ModelPricingEntry type and MODEL_PRICING_TABLE data are imported from
// styrby-shared/src/pricing/static-pricing — the single source of truth for
// both mobile and web. Keeping it in shared means a price update only needs
// to happen once and both platforms stay in sync automatically.

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
        <Text className="text-zinc-500 text-xs">
          {PROVIDER_DISPLAY_NAMES[entry.provider]}
        </Text>
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
// Team Cost Section
// ============================================================================

/**
 * Props for the TeamCostSection component.
 */
interface TeamCostSectionProps {
  /** Per-member cost rows sorted by spend descending */
  memberCosts: MemberCostRow[];
  /** Combined team total in USD */
  teamTotal: number;
  /** Whether data is still loading */
  isLoading: boolean;
  /** Error message (null if no error) */
  error: string | null;
  /** Whether the current user is on Power tier and in a team */
  isEligible: boolean;
  /** User's subscription tier for gate messaging */
  userTier: SubscriptionTier;
}

/**
 * Renders per-member cost breakdown for Power-tier teams.
 *
 * Shows each team member's spend as a labelled horizontal bar proportional
 * to their share of the team total. Non-eligible users see a contextual
 * gate (not Power tier, or Power but no team).
 *
 * @param props - TeamCostSectionProps
 * @returns Rendered team cost section
 */
function TeamCostSection({
  memberCosts,
  teamTotal,
  isLoading,
  error,
  isEligible,
  userTier,
}: TeamCostSectionProps) {
  // Loading skeleton
  if (isLoading) {
    return (
      <View className="py-2">
        {[1, 2, 3].map((i) => (
          <View key={i} className="mb-4">
            <View className="flex-row justify-between mb-1.5">
              <View className="w-32 h-3.5 bg-zinc-800 rounded" />
              <View className="w-14 h-3.5 bg-zinc-800 rounded" />
            </View>
            <View className="h-1.5 w-full rounded-full bg-zinc-800" />
          </View>
        ))}
      </View>
    );
  }

  // Gate: user not on Power tier
  if (userTier !== 'power') {
    return (
      <View className="py-4 items-center">
        <View className="w-10 h-10 rounded-xl bg-orange-500/15 items-center justify-center mb-3">
          <Ionicons name="people-outline" size={22} color="#f97316" />
        </View>
        <Text className="text-white font-semibold mb-1">Team Costs</Text>
        <Text className="text-zinc-500 text-sm text-center">
          Upgrade to Power to monitor team spending and per-member cost breakdowns.
        </Text>
      </View>
    );
  }

  // Gate: Power tier but not in a team
  if (!isEligible) {
    return (
      <View className="py-4 items-center">
        <View className="w-10 h-10 rounded-xl bg-zinc-800 items-center justify-center mb-3">
          <Ionicons name="people-outline" size={22} color="#71717a" />
        </View>
        <Text className="text-white font-semibold mb-1">No Team Yet</Text>
        <Text className="text-zinc-500 text-sm text-center">
          Create a team and invite members to see per-user cost breakdowns here.
        </Text>
      </View>
    );
  }

  // Error state
  if (error) {
    return (
      <View className="py-3">
        <View className="flex-row items-center">
          <Ionicons name="alert-circle-outline" size={16} color="#ef4444" />
          <Text className="text-red-400 text-sm ml-2">{error}</Text>
        </View>
      </View>
    );
  }

  // Empty state: eligible but no data for period
  if (memberCosts.length === 0) {
    return (
      <Text className="text-zinc-500 text-sm text-center py-4">
        No team cost data for this period.
      </Text>
    );
  }

  return (
    <View>
      {/* Team total header */}
      <View className="flex-row items-center justify-between mb-4">
        <Text className="text-zinc-400 text-xs">
          {memberCosts.length} member{memberCosts.length !== 1 ? 's' : ''}
        </Text>
        <View className="items-end">
          <Text className="text-zinc-500 text-xs">Team Total</Text>
          <Text className="text-white text-base font-bold">${teamTotal.toFixed(2)}</Text>
        </View>
      </View>

      {/* Per-member rows */}
      {memberCosts.map((member) => (
        <View key={member.userId} className="mb-4">
          {/* Name + cost */}
          <View className="flex-row items-center justify-between mb-1.5">
            <View className="flex-1 mr-3">
              <Text className="text-white text-sm font-medium" numberOfLines={1}>
                {member.displayName}
              </Text>
              <Text className="text-zinc-600 text-xs">
                {(member.totalInputTokens + member.totalOutputTokens).toLocaleString()} tokens
              </Text>
            </View>
            <View className="items-end">
              <Text className="text-white text-sm font-semibold">
                ${member.totalCostUsd.toFixed(4)}
              </Text>
              <Text className="text-zinc-500 text-xs">
                {member.percentageOfTotal.toFixed(1)}%
              </Text>
            </View>
          </View>

          {/* Proportional cost bar */}
          <View className="h-1.5 w-full rounded-full bg-zinc-800 overflow-hidden">
            <View
              className="h-full rounded-full bg-orange-500/70"
              style={{
                width: `${Math.max(member.percentageOfTotal, member.totalCostUsd > 0 ? 2 : 0)}%`,
              }}
              accessibilityRole="progressbar"
              accessibilityLabel={`${member.displayName}: ${member.percentageOfTotal.toFixed(1)}% of team spend`}
            />
          </View>
        </View>
      ))}

      <Text className="text-zinc-700 text-xs text-center mt-1">
        Team cost data visible to all Power plan members
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
 * - Export button (Power tier only — CSV or JSON via native share sheet)
 * - Time range selector (7D / 30D / 90D)
 * - Cost summaries for today, this week, and this month
 * - Cost breakdown by agent with visual progress bars
 * - Cost breakdown by model (collapsible)
 * - Cost breakdown by tag (collapsible)
 * - Daily cost chart for the selected time range
 * - Budget alerts summary with link to full management screen
 * - Team costs section (Power tier + team required, collapsible)
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

  /**
   * Whether the Team Costs section is expanded.
   * WHY: Team costs are a secondary view — most users don't have a team.
   * Collapsed by default to keep the dashboard clean for solo users.
   */
  const [teamExpanded, setTeamExpanded] = useState(false);

  /**
   * Derive the range start date for the team cost RPC from the selected timeRange.
   * This keeps the team cost window in sync with the individual cost time range.
   */
  const rangeStartDate = (() => {
    const d = new Date();
    d.setDate(d.getDate() - timeRange);
    return d.toISOString().split('T')[0];
  })();

  const {
    memberCosts,
    teamTotal,
    isLoading: teamCostsLoading,
    error: teamCostsError,
    isEligible: isTeamEligible,
  } = useTeamCosts(rangeStartDate);

  /** Whether a cost export is in progress */
  const [isExporting, setIsExporting] = useState(false);

  /**
   * Exports cost data as CSV or JSON and shares via the native share sheet.
   *
   * WHY: Mobile can't trigger a browser download. Instead we fetch the export
   * endpoint, receive the file content as text, and share it via the native
   * Share sheet (which lets users save to Files, AirDrop, email, etc.).
   *
   * WHY we call the web API (/api/v1/costs/export): This is the canonical
   * export endpoint, already validated and rate-limited. Duplicating the
   * export logic in the mobile app would create two code paths to maintain.
   *
   * @param format - 'csv' or 'json'
   */
  const handleExport = useCallback(async (format: 'csv' | 'json') => {
    setIsExporting(true);
    try {
      const { data: { session: authSession } } = await supabase.auth.getSession();
      const token = authSession?.access_token;

      if (!token) {
        Alert.alert('Not Authenticated', 'Please log in to export cost data.');
        return;
      }

      const appUrl = process.env.EXPO_PUBLIC_APP_URL ?? 'https://app.styrby.com';
      const params = new URLSearchParams({ format, days: String(timeRange) });
      const res = await fetch(`${appUrl}/api/v1/costs/export?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (res.status === 403) {
        // WHY platform-conditional message: Apple Reader App rules (§3.1.3(a))
        // prohibit referencing pricing or upgrade flows in iOS apps.
        // On Android we can mention the pricing URL; on iOS we keep it neutral.
        Alert.alert(
          'Power Tier Required',
          Platform.OS === 'ios'
            ? 'Cost export requires a Power subscription. Manage your plan at styrbyapp.com.'
            : 'Cost export is available on the Power plan. Upgrade at styrbyapp.com/pricing.'
        );
        return;
      }

      if (res.status === 429) {
        Alert.alert('Rate Limited', 'Cost export is limited to once per hour. Try again later.');
        return;
      }

      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { message?: string };
        throw new Error(body.message ?? `Export failed (${res.status})`);
      }

      const content = await res.text();
      const today = new Date().toISOString().split('T')[0];
      const filename = `styrby-costs-${today}.${format}`;

      // Use native Share sheet to let user save to Files, email, AirDrop, etc.
      await Share.share({
        title: filename,
        message: content,
      });
    } catch (err) {
      Alert.alert(
        'Export Failed',
        err instanceof Error ? err.message : 'Failed to export cost data'
      );
      if (__DEV__) console.error('[CostsExport] Export error:', err);
    } finally {
      setIsExporting(false);
    }
  }, [timeRange]);

  /**
   * Shows a format picker (ActionSheet on iOS, Alert on Android) and then
   * calls handleExport with the chosen format.
   *
   * WHY ActionSheetIOS for iOS: It is the idiomatic iOS pattern for format
   * selection without adding a third-party bottom-sheet dependency. Android
   * falls back to an Alert with two buttons since ActionSheetIOS is iOS-only.
   */
  const showExportPicker = useCallback(() => {
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          title: 'Export Cost Data',
          message: `Last ${timeRange} days`,
          options: ['Cancel', 'Export as CSV', 'Export as JSON'],
          cancelButtonIndex: 0,
        },
        (buttonIndex) => {
          if (buttonIndex === 1) handleExport('csv');
          else if (buttonIndex === 2) handleExport('json');
        }
      );
    } else {
      // Android: use an Alert with action buttons as a fallback
      Alert.alert(
        'Export Cost Data',
        `Choose a format to export the last ${timeRange} days of cost data.`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Export CSV', onPress: () => handleExport('csv') },
          { text: 'Export JSON', onPress: () => handleExport('json') },
        ]
      );
    }
  }, [timeRange, handleExport]);

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
      {/* Header: Connection Status + Export + Time Range */}
      <View className="px-4 pt-4 mb-3">
        <View className="flex-row items-center justify-between mb-3">
          <Text className="text-zinc-400 text-sm font-medium">SPENDING</Text>
          <View className="flex-row items-center gap-3">
            {/* Export button — Power tier only */}
            <Pressable
              onPress={tier === 'power' ? showExportPicker : undefined}
              disabled={isExporting || tier !== 'power'}
              className={`flex-row items-center px-3 py-1.5 rounded-lg border gap-1.5 active:opacity-80 ${
                tier === 'power'
                  ? 'border-zinc-700 bg-zinc-800'
                  : 'border-zinc-800/50 opacity-40'
              }`}
              accessibilityRole="button"
              accessibilityLabel={
                tier !== 'power'
                  ? 'Export costs, requires Power plan'
                  : isExporting
                    ? 'Exporting...'
                    : 'Export cost data'
              }
            >
              <Ionicons
                name={isExporting ? 'hourglass-outline' : 'download-outline'}
                size={14}
                color="#a1a1aa"
              />
              <Text className="text-zinc-400 text-xs font-medium">
                {isExporting ? 'Exporting…' : 'Export'}
              </Text>
              {tier !== 'power' && (
                <Ionicons name="lock-closed" size={10} color="#52525b" />
              )}
            </Pressable>
            <ConnectionStatus isConnected={isRealtimeConnected} />
          </View>
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

      {/* Team Costs Section — Power tier + team required */}
      <View className="px-4 mt-6">
        <CollapsibleSection
          title="TEAM COSTS"
          isExpanded={teamExpanded}
          onToggle={() => setTeamExpanded((v) => !v)}
        >
          <TeamCostSection
            memberCosts={memberCosts}
            teamTotal={teamTotal}
            isLoading={teamCostsLoading}
            error={teamCostsError}
            isEligible={isTeamEligible}
            userTier={tier}
          />
        </CollapsibleSection>
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
          {MODEL_PRICING_TABLE.map((entry) => (
            <ModelPricingRow key={entry.name} entry={entry} />
          ))}

          {/* Footer note */}
          <Text className="text-zinc-600 text-xs mt-3 text-center">
            Prices in USD per 1M tokens · Last verified {STATIC_PRICING_LAST_VERIFIED}
          </Text>
        </CollapsibleSection>
      </View>
    </ScrollView>
  );
}
