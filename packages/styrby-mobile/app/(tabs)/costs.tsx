/**
 * Costs Screen — orchestrator.
 *
 * WHY orchestrator-only: Per CLAUDE.md "Component-First Architecture", page
 * files own state, data fetching, and top-level layout — never presentation.
 * All sub-views live in src/components/costs/* and the export flow lives in
 * hooks/useCostExport. This file is intentionally a thin assembler.
 *
 * Responsibilities (this file):
 *  - Compose data hooks (useCosts, useBudgetAlerts, useTeamCosts, useCostExport,
 *    useRunRate, useSessionCosts)
 *  - Own collapsible-section state
 *  - Render top-level layout, loading/error/empty states, and pull-to-refresh
 *  - Wire navigation (router.push) to budget alerts management
 *
 * Sub-components own everything else (rows, gates, formatters, share flow).
 *
 * Phase 1.6.7 additions:
 *  - RunRateCard: today / MTD / projected + tier cap progress bar
 *  - TierUpgradeWarning: amber/red card with upgrade CTA at >= 80% of cap
 *  - AgentWeeklySparkline: per-agent 7-day bar chart + MTD total
 *  - SessionCostRow: recent sessions list with per-session cost pill
 */

import { useState, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  RefreshControl,
  ActivityIndicator,
  Pressable,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useCosts, formatTokens, getAgentHexColor, getAgentDisplayName } from '../../src/hooks/useCosts';
import { useBudgetAlerts } from '../../src/hooks/useBudgetAlerts';
import { useTeamCosts } from '../../src/hooks/useTeamCosts';
import { useCostExport } from '../../src/hooks/useCostExport';
import { useRunRate } from '../../src/hooks/useRunRate';
import { useSessionCosts } from '../../src/hooks/useSessionCosts';
import { MODEL_PRICING_TABLE, STATIC_PRICING_LAST_VERIFIED } from 'styrby-shared';
import { CostCard } from '../../src/components/CostCard';
import { AgentCostBar, AgentCostBarEmpty } from '../../src/components/AgentCostBar';
import { DailyMiniChart, DailyMiniChartEmpty } from '../../src/components/DailyMiniChart';
import {
  BudgetAlertsSummary,
  CollapsibleSection,
  CostConnectionStatus,
  ExportButton,
  ModelCostRow,
  ModelPricingRow,
  TagCostRow,
  TeamCostSection,
  TimeRangeSelector,
  RunRateCard,
  TierUpgradeWarning,
  AgentWeeklySparkline,
  AgentSparklineEmpty,
  SessionCostRow,
} from '../../src/components/costs';
import { BillingModelSummaryStrip } from '../../src/components/costs/BillingModelSummaryStrip';
import { ForecastCard } from '../../src/components/costs/ForecastCard';
import { useBillingBreakdown } from '../../src/components/costs/useBillingBreakdown';
import { useForecast } from '../../src/hooks/useForecast';

/**
 * Cost Dashboard Screen.
 *
 * Renders (top-to-bottom):
 *  1. Header: SPENDING label, Export button (Power-only), live/offline pill
 *  2. Run-rate projection card (today / MTD / projected + tier cap bar) — Phase 1.6.7
 *  3. Tier upgrade warning card (amber/red at >= 80% cap) — Phase 1.6.7
 *  4. Time-range selector (7D / 30D / 90D)
 *  5. Today / Week / Month / 90-Day cost cards
 *  6. Daily cost mini-chart
 *  7. Per-agent 7-day sparklines — Phase 1.6.7
 *  8. Cost-by-agent breakdown
 *  9. Cost-by-model (collapsible)
 * 10. Cost-by-tag (collapsible)
 * 11. Token-usage summary for the month
 * 12. Recent sessions with per-session cost — Phase 1.6.7
 * 13. Budget-alerts summary card (deep-link to manage)
 * 14. Team-costs (collapsible, Power + team gate)
 * 15. Model-pricing reference (collapsible)
 *
 * @returns Rendered costs screen
 */
export default function CostsScreen() {
  const {
    data,
    isLoading,
    isRefreshing,
    error,
    refresh,
    timeRange,
    setTimeRange,
    isRealtimeConnected,
  } = useCosts();
  const { alerts, tier, isLoading: alertsLoading } = useBudgetAlerts();
  const router = useRouter();

  // Phase 1.6.7: run-rate projection + recent session costs
  const { projection, isLoading: runRateLoading, refresh: refreshRunRate, tierLabel } = useRunRate();
  const { sessions: recentSessions, isLoading: sessionsLoading, refresh: refreshSessions } = useSessionCosts();

  // Phase 3.4: EMA-blend cost forecast + predictive exhaustion date
  const { forecast, isLoading: forecastLoading, error: forecastError } = useForecast();

  // WHY individual useState rather than a single object: each section toggles
  // independently, so colocated booleans keep re-renders narrow and code clear.
  const [modelExpanded, setModelExpanded] = useState(false);
  const [tagExpanded, setTagExpanded] = useState(false);
  const [sessionsExpanded, setSessionsExpanded] = useState(false);

  /**
   * Whether the Model Pricing reference table is expanded.
   * WHY collapsed by default: Reference data — useful occasionally, not the
   * primary content. Collapsed keeps the dashboard clean.
   */
  const [pricingExpanded, setPricingExpanded] = useState(false);

  /**
   * Whether the Team Costs section is expanded.
   * WHY collapsed by default: Most users don't have a team — collapsing
   * keeps the dashboard clean for solo users.
   */
  const [teamExpanded, setTeamExpanded] = useState(false);

  /**
   * Derive the range start date for the team-cost RPC from the selected
   * timeRange so individual + team cost windows stay in sync.
   *
   * WHY computed inline (no useMemo): Date construction is cheap and the
   * result is consumed by useTeamCosts which has its own caching.
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

  const { isExporting, showExportPicker } = useCostExport(timeRange);

  // WHY: Separate hook for billing breakdown — useCosts reads from the
  // materialized view which lacks billing_model/source. useBillingBreakdown
  // queries cost_records directly for those columns only.
  const { breakdown: billingBreakdown } = useBillingBreakdown(timeRange);

  /**
   * Composite refresh: pull-to-refresh on the ScrollView triggers all hooks.
   *
   * WHY useCallback: passed as a prop reference; stable identity prevents
   * unnecessary RefreshControl re-renders.
   */
  const handleRefreshAll = useCallback(() => {
    refresh();
    refreshRunRate();
    refreshSessions();
  }, [refresh, refreshRunRate, refreshSessions]);

  // Derive per-agent 7-day sparkline data from the daily cost dataset.
  // WHY derived here (not in a hook): useCosts already fetched the data;
  // re-shaping it for sparklines is pure JS - no extra network call needed.
  const agentSparklines = (() => {
    if (!data?.dailyCosts) return [];
    const last7 = data.dailyCosts.slice(-7);
    const agentKeys: (keyof typeof last7[0])[] = ['claude', 'codex', 'gemini', 'opencode', 'aider', 'goose', 'amp', 'crush', 'kilo', 'kiro', 'droid'];
    // Only include agents that had any cost in the last 7 days.
    return agentKeys
      .map((key) => {
        const agentType = key as string;
        const days = last7.map((d) => ({
          date: d.date,
          cost: (d[key] as number) || 0,
        }));
        const mtd = data.byAgent.find((a) => a.agent === agentType)?.cost ?? 0;
        return { agentType, days, mtd };
      })
      .filter((a) => a.days.some((d) => d.cost > 0));
  })();

  if (isLoading) {
    return (
      <View className="flex-1 bg-background items-center justify-center">
        <ActivityIndicator size="large" color="#f97316" />
        <Text className="text-zinc-500 mt-4">Loading costs...</Text>
      </View>
    );
  }

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

  // No-data fallback — shouldn't happen normally, but guard before deref.
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
          onRefresh={handleRefreshAll}
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
            <ExportButton
              tier={tier}
              isExporting={isExporting}
              onPress={showExportPicker}
            />
            <CostConnectionStatus isConnected={isRealtimeConnected} />
          </View>
        </View>
        <TimeRangeSelector selected={timeRange} onSelect={setTimeRange} />
      </View>

      {/* === Phase 1.6.7: Run-rate projection card === */}
      {/* WHY at the top: Users' most common question is "am I on track this month?"
          Surfacing the answer before the detailed charts means they get the answer
          without scrolling. */}
      {runRateLoading ? (
        <View className="px-4 mb-4">
          <View className="bg-background-secondary rounded-xl p-4 items-center justify-center h-20">
            <ActivityIndicator size="small" color="#f97316" />
          </View>
        </View>
      ) : projection !== null ? (
        <View className="px-4 mb-4">
          <RunRateCard projection={projection} />
          <TierUpgradeWarning projection={projection} tierLabel={tierLabel} />
        </View>
      ) : null}

      {/* === Phase 3.4: EMA-blend forecast card === */}
      {/* WHY below RunRateCard: RunRateCard answers "how am I doing now?"
          ForecastCard answers "what will happen next?" — sequential read
          guides the user from current state to future prediction. */}
      <View className="px-4 mb-4">
        <ForecastCard
          forecast={forecast}
          loading={forecastLoading}
          error={forecastError}
        />
      </View>

      {/* Billing Model Summary Strip — shows API / SUB / CR totals for the period */}
      {/* WHY: Users who mix billing models (e.g. API for Claude Code + credits
          for Kiro + subscription for Claude Max) need an at-a-glance view of
          where their spend comes from before scrolling to the detail charts. */}
      {billingBreakdown && (
        <BillingModelSummaryStrip breakdown={billingBreakdown} days={timeRange} />
      )}

      {/* Cost Summary Cards */}
      <View className="px-4">
        <CostCard
          title="Today"
          amount={data.today.totalCost}
          subtitle={`${data.today.requestCount} requests`}
          icon="today"
          iconColor="#f97316"
        />

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

      {/* === Phase 1.6.7: Per-agent 7-day sparklines === */}
      {/* WHY sparklines: The existing AgentCostBar shows period totals but not
          the trend over time. A 7-bar mini chart lets users see if an agent's
          spend is accelerating or declining without opening the full chart. */}
      <View className="px-4 mt-6">
        <Text className="text-zinc-400 text-sm font-medium mb-3">AGENT TREND (7 DAYS)</Text>
        <View className="bg-background-secondary rounded-xl px-4 py-2">
          {agentSparklines.length > 0 ? (
            agentSparklines.map(({ agentType, days, mtd }) => (
              <AgentWeeklySparkline
                key={agentType}
                agent={agentType as import('styrby-shared').AgentType}
                label={getAgentDisplayName(agentType as import('styrby-shared').AgentType)}
                color={getAgentHexColor(agentType as import('styrby-shared').AgentType)}
                days={days}
                mtdCostUsd={mtd}
              />
            ))
          ) : (
            <AgentSparklineEmpty />
          )}
        </View>
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
            data.byModel.map((item) => <ModelCostRow key={item.model} item={item} />)
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
            data.byTag.map((item) => <TagCostRow key={item.tag} item={item} />)
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
            <View className="flex-1 items-center">
              <View className="flex-row items-center mb-1">
                <Ionicons name="arrow-up-circle" size={16} color="#3b82f6" />
                <Text className="text-zinc-400 text-xs ml-1">Input</Text>
              </View>
              <Text className="text-white font-semibold text-lg">
                {formatTokens(data.month.inputTokens)}
              </Text>
            </View>

            <View className="w-px bg-zinc-800 mx-4" />

            <View className="flex-1 items-center">
              <View className="flex-row items-center mb-1">
                <Ionicons name="arrow-down-circle" size={16} color="#22c55e" />
                <Text className="text-zinc-400 text-xs ml-1">Output</Text>
              </View>
              <Text className="text-white font-semibold text-lg">
                {formatTokens(data.month.outputTokens)}
              </Text>
            </View>

            <View className="w-px bg-zinc-800 mx-4" />

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

      {/* === Phase 1.6.7: Recent sessions with per-session cost === */}
      {/* WHY: Users want to identify which session drove an unexpected spike in
          cost. Showing the last 20 sessions with cost and agent inline gives
          them the answer without navigating away from the Costs tab. Tapping
          a row drills into the session's full token breakdown. */}
      <View className="px-4 mt-6">
        <CollapsibleSection
          title="RECENT SESSIONS"
          isExpanded={sessionsExpanded}
          onToggle={() => setSessionsExpanded((v) => !v)}
        >
          {sessionsLoading ? (
            <View className="py-4 items-center">
              <ActivityIndicator size="small" color="#f97316" />
            </View>
          ) : recentSessions.length > 0 ? (
            <View className="-mx-4">
              {recentSessions.map((session) => (
                <SessionCostRow key={session.id} session={session} />
              ))}
            </View>
          ) : (
            <Text className="text-zinc-500 text-sm text-center py-4">
              No sessions yet
            </Text>
          )}
        </CollapsibleSection>
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

          {MODEL_PRICING_TABLE.map((entry) => (
            <ModelPricingRow key={entry.name} entry={entry} />
          ))}

          <Text className="text-zinc-600 text-xs mt-3 text-center">
            Prices in USD per 1M tokens · Last verified {STATIC_PRICING_LAST_VERIFIED}
          </Text>
        </CollapsibleSection>
      </View>
    </ScrollView>
  );
}
