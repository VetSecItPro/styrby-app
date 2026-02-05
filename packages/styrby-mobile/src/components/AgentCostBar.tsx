/**
 * Agent Cost Bar Component
 *
 * Displays a horizontal progress bar showing an agent's cost contribution.
 * Includes agent name, cost amount, and percentage of total.
 */

import { View, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { AgentType } from 'styrby-shared';
import { getAgentHexColor, getAgentDisplayName, formatCost } from '../hooks/useCosts';

/**
 * Props for the AgentCostBar component.
 */
interface AgentCostBarProps {
  /** Agent type identifier */
  agent: AgentType;
  /** Cost amount in USD */
  cost: number;
  /** Percentage of total cost (0-100) */
  percentage: number;
  /** Number of requests made by this agent */
  requestCount?: number;
}

/**
 * Agent icon mapping.
 */
const AGENT_ICONS: Record<AgentType, keyof typeof Ionicons.glyphMap> = {
  claude: 'terminal',
  codex: 'code-slash',
  gemini: 'sparkles',
  opencode: 'logo-github',
  aider: 'git-branch',
};

/**
 * AgentCostBar displays a single agent's cost with a visual progress bar.
 *
 * @param props - Component props
 * @returns Rendered agent cost bar
 *
 * @example
 * <AgentCostBar
 *   agent="claude"
 *   cost={45.67}
 *   percentage={75}
 *   requestCount={42}
 * />
 */
export function AgentCostBar({ agent, cost, percentage, requestCount }: AgentCostBarProps) {
  const color = getAgentHexColor(agent);
  const name = getAgentDisplayName(agent);
  const icon = AGENT_ICONS[agent] || 'terminal';

  return (
    <View className="mb-4">
      {/* Header row: icon, name, cost, percentage */}
      <View className="flex-row items-center justify-between mb-2">
        <View className="flex-row items-center flex-1">
          <View
            className="w-8 h-8 rounded-lg items-center justify-center mr-2"
            style={{ backgroundColor: `${color}20` }}
          >
            <Ionicons name={icon} size={16} color={color} />
          </View>
          <View className="flex-1">
            <Text className="text-white font-medium">{name}</Text>
            {requestCount !== undefined && (
              <Text className="text-zinc-500 text-xs">{requestCount} requests</Text>
            )}
          </View>
        </View>
        <View className="items-end">
          <Text className="text-white font-semibold">{formatCost(cost)}</Text>
          <Text className="text-zinc-500 text-xs">{percentage.toFixed(1)}%</Text>
        </View>
      </View>

      {/* Progress bar */}
      <View className="h-2 bg-zinc-800 rounded-full overflow-hidden">
        <View
          className="h-full rounded-full"
          style={{
            backgroundColor: color,
            width: `${Math.min(100, Math.max(0, percentage))}%`,
          }}
        />
      </View>
    </View>
  );
}

/**
 * Empty state shown when there are no agent costs.
 */
export function AgentCostBarEmpty() {
  return (
    <View className="items-center py-6">
      <Ionicons name="analytics-outline" size={32} color="#3f3f46" />
      <Text className="text-zinc-500 mt-2 text-center">No cost data yet</Text>
      <Text className="text-zinc-600 text-sm text-center mt-1">
        Start using AI agents to see your costs here
      </Text>
    </View>
  );
}
