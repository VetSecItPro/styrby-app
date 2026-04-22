/**
 * Session Cost Drill-In Screen — /session/:id/costs
 *
 * Mobile parity for the web SessionCostDrillIn modal.
 * Shows per-message cost breakdown for a single session:
 *   - Summary header: total cost, token breakdown, billing model
 *   - Mixed-source warning banner
 *   - Per-message cost list, sortable by cost / time
 *
 * Navigation: pushed from the session detail screen.
 * Data: fetched from /api/sessions/:id/costs via the Supabase anon client
 * after obtaining the user's auth token.
 *
 * @route /session/:id/costs
 * @module app/session/[id]/costs
 */

import { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  ActivityIndicator,
  Pressable,
} from 'react-native';
import { useLocalSearchParams, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../../src/lib/supabase';
import { BillingModelChip, SourceBadge } from '../../../src/components/costs/BillingModelChip';
import type { BillingModel, CostSource } from 'styrby-shared';

// ============================================================================
// Types
// ============================================================================

interface CostMessage {
  id: string;
  recordedAt: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  model: string;
  agentType: string;
  billingModel: BillingModel;
  source: CostSource;
  creditsConsumed: number | null;
  subscriptionFractionUsed: number | null;
}

interface SessionCostData {
  sessionId: string;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  billingModel: BillingModel;
  sourceMix: { agentReported: number; styrbyEstimate: number };
  messages: CostMessage[];
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Format token count with K/M suffix.
 *
 * @param n - Raw token count
 * @returns Formatted string
 */
function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

/**
 * Format ISO timestamp to HH:MM local time.
 *
 * @param iso - ISO 8601 string
 * @returns Time string
 */
function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

// ============================================================================
// Screen
// ============================================================================

/**
 * Session cost breakdown screen.
 *
 * Fetches and renders per-message cost data for the session identified
 * by the `:id` route parameter.
 *
 * @returns Scrollable cost breakdown screen
 */
export default function SessionCostsScreen() {
  const { id: sessionId } = useLocalSearchParams<{ id: string }>();
  const [data, setData] = useState<SessionCostData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<'cost' | 'time'>('cost');

  const fetchData = useCallback(async () => {
    if (!sessionId) return;
    setLoading(true);
    setError(null);

    try {
      // Get the current session's access token for the API call.
      // WHY: The /api/sessions/:id/costs endpoint requires Bearer auth.
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData?.session?.access_token;

      if (!accessToken) {
        setError('Not authenticated');
        return;
      }

      const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
      // WHY: We call the Next.js API route through the web app's URL.
      // The mobile app and web app share the same Supabase project so
      // auth tokens are interchangeable.
      const appUrl = process.env.EXPO_PUBLIC_APP_URL ?? 'https://app.styrbyapp.com';
      const res = await fetch(`${appUrl}/api/sessions/${sessionId}/costs`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }

      const json = await res.json() as SessionCostData;
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load cost data');
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  const hasMixedSources =
    data != null &&
    data.sourceMix.agentReported > 0 &&
    data.sourceMix.styrbyEstimate > 0;

  const sortedMessages = data
    ? [...data.messages].sort((a, b) =>
        sortBy === 'cost'
          ? b.costUsd - a.costUsd
          : a.recordedAt.localeCompare(b.recordedAt)
      )
    : [];

  return (
    <>
      <Stack.Screen options={{ title: 'Cost Breakdown' }} />

      <ScrollView className="flex-1 bg-background" contentContainerStyle={{ paddingBottom: 32 }}>
        {loading && (
          <View className="flex-1 items-center justify-center py-16">
            <ActivityIndicator size="large" color="#f97316" />
            <Text className="text-zinc-500 mt-3 text-sm">Loading cost data...</Text>
          </View>
        )}

        {error && (
          <View className="mx-4 mt-6 rounded-xl bg-red-500/10 border border-red-500/20 p-4">
            <Text className="text-red-400 text-sm">{error}</Text>
            <Pressable onPress={fetchData} className="mt-3 active:opacity-80">
              <Text className="text-red-400 font-semibold text-sm">Try again</Text>
            </Pressable>
          </View>
        )}

        {data && (
          <>
            {/* Summary cards */}
            <View className="px-4 pt-4">
              <View className="flex-row flex-wrap gap-3 mb-4">
                {[
                  { label: 'Total Cost', value: `$${data.totalCostUsd.toFixed(4)}` },
                  { label: 'Input', value: fmt(data.totalInputTokens) },
                  { label: 'Output', value: fmt(data.totalOutputTokens) },
                  { label: 'Cache Read', value: fmt(data.totalCacheReadTokens) },
                ].map(({ label, value }) => (
                  <View
                    key={label}
                    className="flex-1 min-w-[130px] rounded-xl bg-background-secondary border border-zinc-800 px-3 py-3 items-center"
                  >
                    <Text className="text-zinc-500 text-xs mb-1">{label}</Text>
                    <Text className="text-white font-semibold text-base">{value}</Text>
                  </View>
                ))}
              </View>

              {/* Mixed-source warning */}
              {hasMixedSources && (
                <View className="mb-4 flex-row items-start gap-2 rounded-xl bg-amber-500/5 border border-amber-500/20 px-3 py-2.5">
                  <Ionicons name="warning-outline" size={14} color="#fbbf24" style={{ marginTop: 2 }} />
                  <Text className="flex-1 text-xs text-amber-400 leading-5">
                    Mixed sources: {data.sourceMix.agentReported} agent-reported,{' '}
                    {data.sourceMix.styrbyEstimate} estimated. Estimated values may differ from actual billing.
                  </Text>
                </View>
              )}

              {/* Sort controls */}
              <View className="flex-row items-center gap-2 mb-4">
                <Text className="text-zinc-500 text-xs">Sort:</Text>
                {(['cost', 'time'] as const).map((s) => (
                  <Pressable
                    key={s}
                    onPress={() => setSortBy(s)}
                    className={`rounded-lg px-3 py-1.5 active:opacity-70 ${
                      sortBy === s ? 'bg-orange-500/20' : 'bg-zinc-800'
                    }`}
                    accessibilityRole="button"
                    accessibilityState={{ selected: sortBy === s }}
                  >
                    <Text
                      className={`text-xs font-medium ${sortBy === s ? 'text-orange-300' : 'text-zinc-400'}`}
                    >
                      {s === 'cost' ? 'Cost' : 'Time'}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>

            {/* Messages list */}
            <View className="px-4">
              {sortedMessages.length === 0 ? (
                <View className="rounded-xl bg-background-secondary p-6 items-center">
                  <Text className="text-zinc-500 text-sm">No cost records for this session yet.</Text>
                </View>
              ) : (
                sortedMessages.map((msg, i) => (
                  <View
                    key={msg.id}
                    className={`py-3 ${i > 0 ? 'border-t border-zinc-800' : ''}`}
                  >
                    <View className="flex-row items-center justify-between mb-1.5">
                      <View className="flex-row items-center gap-2">
                        <Text className="text-zinc-600 text-xs font-mono">{fmtTime(msg.recordedAt)}</Text>
                        <BillingModelChip billingModel={msg.billingModel} />
                        <SourceBadge source={msg.source} />
                      </View>
                      <Text className="text-white text-xs font-semibold">
                        {msg.billingModel === 'subscription' && msg.subscriptionFractionUsed != null
                          ? `${(msg.subscriptionFractionUsed * 100).toFixed(1)}% quota`
                          : msg.billingModel === 'credit' && msg.creditsConsumed != null
                          ? `${msg.creditsConsumed} cr`
                          : `$${msg.costUsd.toFixed(5)}`}
                      </Text>
                    </View>
                    <Text className="text-zinc-400 text-xs mb-1.5 truncate">{msg.model}</Text>
                    <View className="flex-row gap-4">
                      <Text className="text-zinc-600 text-xs">In: {fmt(msg.inputTokens)}</Text>
                      <Text className="text-zinc-600 text-xs">Out: {fmt(msg.outputTokens)}</Text>
                      <Text className="text-zinc-600 text-xs">Cache: {fmt(msg.cacheReadTokens)}</Text>
                    </View>
                  </View>
                ))
              )}
            </View>
          </>
        )}
      </ScrollView>
    </>
  );
}
