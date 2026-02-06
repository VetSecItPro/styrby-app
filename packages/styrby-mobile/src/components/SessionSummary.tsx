/**
 * Session Summary Component
 *
 * Displays an AI-generated summary of a completed coding session.
 * Shows different states based on:
 * - Session status (active vs completed)
 * - Summary availability
 * - User's subscription tier (Pro+ only)
 *
 * @component
 */

import { View, Text, Pressable } from 'react-native';
import { useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';

/* ──────────────────────────── Types ──────────────────────────── */

/**
 * Props for the SessionSummary component.
 */
export interface SessionSummaryProps {
  /** The session's current summary (null if not generated yet) */
  summary: string | null;

  /** When the summary was generated (null if not yet) */
  summaryGeneratedAt: string | null;

  /** The session's current status */
  sessionStatus: string;

  /** The user's subscription tier */
  userTier: 'free' | 'pro' | 'power';
}

/* ──────────────────────────── Helper ──────────────────────────── */

/**
 * Formats a timestamp into a relative or absolute date string.
 *
 * @param isoTimestamp - ISO 8601 timestamp string
 * @returns Formatted date string
 */
function formatSummaryDate(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/* ──────────────────────────── Component ──────────────────────── */

/**
 * Renders the session summary in a collapsible card.
 *
 * WHY collapsible: Summaries can be several paragraphs long. Making it
 * collapsible keeps the session detail view clean while still providing
 * quick access to the summary when needed.
 *
 * WHY tier gating: AI summary generation costs money (OpenAI API).
 * Free tier users see an upgrade prompt to encourage conversion.
 *
 * @param props - Component configuration
 */
export function SessionSummary({
  summary,
  summaryGeneratedAt,
  sessionStatus,
  userTier,
}: SessionSummaryProps) {
  const [isExpanded, setIsExpanded] = useState(true);

  // Determine if the session is in a completed state
  const isSessionCompleted = ['stopped', 'expired', 'error'].includes(sessionStatus);
  const isSessionActive = ['starting', 'running', 'idle', 'paused'].includes(sessionStatus);

  // Check if user has access to summaries
  const hasSummaryAccess = userTier === 'pro' || userTier === 'power';

  // ──────────────────────────────────────────
  // Render: Free tier upgrade prompt
  // ──────────────────────────────────────────
  if (!hasSummaryAccess) {
    return (
      <View className="mx-4 mb-4 rounded-2xl bg-zinc-900 border border-zinc-800 overflow-hidden">
        <View className="p-5 items-center">
          <View className="w-12 h-12 rounded-full bg-brand/20 items-center justify-center mb-3">
            <Ionicons name="lock-closed" size={24} color="#f97316" />
          </View>

          <Text className="text-white text-lg font-semibold text-center mb-2">
            AI Session Summaries
          </Text>

          <Text className="text-zinc-400 text-sm text-center mb-4">
            Get AI-generated summaries of your coding sessions. Quickly understand
            what was accomplished without reading through the entire chat history.
          </Text>

          <Pressable
            onPress={() => router.push('/(tabs)/settings')}
            className="bg-brand px-5 py-2.5 rounded-xl flex-row items-center active:opacity-80"
            accessibilityRole="button"
            accessibilityLabel="Upgrade to Pro for AI summaries"
          >
            <Ionicons name="sparkles" size={18} color="white" />
            <Text className="text-white font-semibold ml-2">Upgrade to Pro</Text>
          </Pressable>

          <Text className="text-zinc-600 text-xs mt-3">
            Available on Pro and Power plans
          </Text>
        </View>
      </View>
    );
  }

  // ──────────────────────────────────────────
  // Render: Active session (no summary yet)
  // ──────────────────────────────────────────
  if (isSessionActive) {
    return (
      <View className="mx-4 mb-4 rounded-2xl bg-zinc-900 border border-zinc-800 overflow-hidden">
        <View className="p-5 items-center">
          <View className="w-12 h-12 rounded-full bg-blue-500/20 items-center justify-center mb-3">
            <Ionicons name="sparkles" size={24} color="#3b82f6" />
          </View>

          <Text className="text-white text-lg font-semibold text-center mb-2">
            Summary Available After Session
          </Text>

          <Text className="text-zinc-400 text-sm text-center">
            An AI summary will be automatically generated when this session ends.
            The summary captures key goals, actions taken, and outcomes.
          </Text>
        </View>
      </View>
    );
  }

  // ──────────────────────────────────────────
  // Render: Generating state
  // ──────────────────────────────────────────
  if (isSessionCompleted && !summary && !summaryGeneratedAt) {
    return (
      <View className="mx-4 mb-4 rounded-2xl bg-zinc-900 border border-zinc-800 overflow-hidden">
        <View className="p-5 items-center">
          <View className="w-12 h-12 rounded-full bg-purple-500/20 items-center justify-center mb-3">
            <Ionicons name="time" size={24} color="#a855f7" />
          </View>

          <Text className="text-white text-lg font-semibold text-center mb-2">
            Generating Summary...
          </Text>

          <Text className="text-zinc-400 text-sm text-center">
            Our AI is analyzing your session to create a concise summary.
            This usually takes 10-30 seconds.
          </Text>
        </View>
      </View>
    );
  }

  // ──────────────────────────────────────────
  // Render: No summary available (old session)
  // ──────────────────────────────────────────
  if (isSessionCompleted && !summary) {
    return (
      <View className="mx-4 mb-4 rounded-2xl bg-zinc-900 border border-zinc-800 overflow-hidden">
        <View className="p-5 items-center">
          <View className="w-12 h-12 rounded-full bg-zinc-800 items-center justify-center mb-3">
            <Ionicons name="sparkles" size={24} color="#71717a" />
          </View>

          <Text className="text-white text-lg font-semibold text-center mb-2">
            No Summary Available
          </Text>

          <Text className="text-zinc-400 text-sm text-center">
            This session was created before AI summaries were enabled.
            Summaries are automatically generated for new sessions when they complete.
          </Text>
        </View>
      </View>
    );
  }

  // ──────────────────────────────────────────
  // Render: Summary available
  // ──────────────────────────────────────────
  return (
    <View className="mx-4 mb-4 rounded-2xl bg-zinc-900 border border-zinc-800 overflow-hidden">
      {/* Collapsible header */}
      <Pressable
        onPress={() => setIsExpanded(!isExpanded)}
        className="flex-row items-center justify-between p-4 active:bg-zinc-800/50"
        accessibilityRole="button"
        accessibilityLabel={`AI Summary, ${isExpanded ? 'collapse' : 'expand'}`}
        accessibilityState={{ expanded: isExpanded }}
      >
        <View className="flex-row items-center flex-1">
          <View className="w-8 h-8 rounded-full bg-purple-500/20 items-center justify-center mr-3">
            <Ionicons name="sparkles" size={16} color="#a855f7" />
          </View>
          <View className="flex-1">
            <Text className="text-white text-sm font-semibold">AI Summary</Text>
            {summaryGeneratedAt && (
              <Text className="text-zinc-500 text-xs">
                Generated {formatSummaryDate(summaryGeneratedAt)}
              </Text>
            )}
          </View>
        </View>

        <Ionicons
          name={isExpanded ? 'chevron-up' : 'chevron-down'}
          size={20}
          color="#71717a"
        />
      </Pressable>

      {/* Collapsible content */}
      {isExpanded && (
        <View className="px-4 pb-4 border-t border-zinc-800/50">
          <Text className="text-zinc-300 text-sm leading-relaxed pt-4">
            {summary}
          </Text>
        </View>
      )}
    </View>
  );
}
