/**
 * Single row in the COST BY MODEL breakdown.
 *
 * @module components/costs/ModelCostRow
 */

import { View, Text } from 'react-native';
import { formatTokens, formatCost } from '../../hooks/useCosts';
import type { ModelCostRowProps } from '../../types/costs';

/**
 * Renders one model's cost line: model name + request/token count + cost.
 *
 * @param props - {@link ModelCostRowProps}
 * @returns Rendered row
 */
export function ModelCostRow({ item }: ModelCostRowProps) {
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
