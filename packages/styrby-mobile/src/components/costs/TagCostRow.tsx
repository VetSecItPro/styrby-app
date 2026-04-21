/**
 * Single row in the COST BY TAG breakdown.
 *
 * @module components/costs/TagCostRow
 */

import { View, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { formatCost } from '../../hooks/useCosts';
import type { TagCostRowProps } from '../../types/costs';

/**
 * Renders one tag's cost line: tag icon + name + session count + cost.
 *
 * @param props - {@link TagCostRowProps}
 * @returns Rendered row
 */
export function TagCostRow({ item }: TagCostRowProps) {
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
