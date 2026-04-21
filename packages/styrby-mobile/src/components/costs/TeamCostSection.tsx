/**
 * Per-member cost breakdown for Power-tier teams.
 *
 * Shows each team member's spend as a labelled horizontal bar proportional
 * to their share of the team total. Non-eligible users see a contextual
 * gate (not Power tier, or Power but no team).
 *
 * @module components/costs/TeamCostSection
 */

import { View, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { MemberCostRow } from '../../hooks/useTeamCosts';
import type { TeamCostSectionProps } from '../../types/costs';

/**
 * Three skeleton rows shown while team cost data is loading.
 */
function LoadingSkeleton() {
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

/**
 * Generic upgrade/empty gate. Used for both "needs Power" and "no team yet"
 * — only the icon background, copy, and icon color differ.
 *
 * WHY: The two gate states share identical structure. A single primitive
 * driven by props avoids near-duplicate JSX (reviewer flagged this pattern
 * in SessionsFilterBar last batch).
 */
function GateMessage({
  iconBgClass,
  iconColor,
  title,
  body,
}: {
  iconBgClass: string;
  iconColor: string;
  title: string;
  body: string;
}) {
  return (
    <View className="py-4 items-center">
      <View className={`w-10 h-10 rounded-xl items-center justify-center mb-3 ${iconBgClass}`}>
        <Ionicons name="people-outline" size={22} color={iconColor} />
      </View>
      <Text className="text-white font-semibold mb-1">{title}</Text>
      <Text className="text-zinc-500 text-sm text-center">{body}</Text>
    </View>
  );
}

/**
 * Single member row: name + tokens + USD + percentage + proportional bar.
 */
function MemberRow({ member }: { member: MemberCostRow }) {
  return (
    <View className="mb-4">
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
  );
}

/**
 * Renders the team-costs body, dispatching to loading/gate/error/empty/data.
 *
 * @param props - {@link TeamCostSectionProps}
 * @returns Rendered section
 */
export function TeamCostSection({
  memberCosts,
  teamTotal,
  isLoading,
  error,
  isEligible,
  userTier,
}: TeamCostSectionProps) {
  if (isLoading) return <LoadingSkeleton />;

  if (userTier !== 'power') {
    return (
      <GateMessage
        iconBgClass="bg-orange-500/15"
        iconColor="#f97316"
        title="Team Costs"
        body="Upgrade to Power to monitor team spending and per-member cost breakdowns."
      />
    );
  }

  if (!isEligible) {
    return (
      <GateMessage
        iconBgClass="bg-zinc-800"
        iconColor="#71717a"
        title="No Team Yet"
        body="Create a team and invite members to see per-user cost breakdowns here."
      />
    );
  }

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

  if (memberCosts.length === 0) {
    return (
      <Text className="text-zinc-500 text-sm text-center py-4">
        No team cost data for this period.
      </Text>
    );
  }

  return (
    <View>
      <View className="flex-row items-center justify-between mb-4">
        <Text className="text-zinc-400 text-xs">
          {memberCosts.length} member{memberCosts.length !== 1 ? 's' : ''}
        </Text>
        <View className="items-end">
          <Text className="text-zinc-500 text-xs">Team Total</Text>
          <Text className="text-white text-base font-bold">${teamTotal.toFixed(2)}</Text>
        </View>
      </View>

      {memberCosts.map((member) => (
        <MemberRow key={member.userId} member={member} />
      ))}

      <Text className="text-zinc-700 text-xs text-center mt-1">
        Team cost data visible to all Power plan members
      </Text>
    </View>
  );
}
