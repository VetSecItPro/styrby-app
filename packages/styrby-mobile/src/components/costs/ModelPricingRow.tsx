/**
 * Single row in the MODEL PRICING REFERENCE table.
 *
 * WHY: ModelPricingEntry data lives in styrby-shared as the single source of
 * truth for both mobile and web. Both surfaces render the same rows so a
 * price update only needs to happen in one place.
 *
 * @module components/costs/ModelPricingRow
 */

import { View, Text } from 'react-native';
import { PROVIDER_DISPLAY_NAMES, type ModelPricingEntry } from 'styrby-shared';
import { formatPricePer1M } from './pricing';

/**
 * Props for the ModelPricingRow.
 */
export interface ModelPricingRowProps {
  /** The model pricing data to display */
  entry: ModelPricingEntry;
}

/**
 * Renders a row: model name + provider, input $/1M, output $/1M.
 *
 * @param props - {@link ModelPricingRowProps}
 * @returns Rendered row
 */
export function ModelPricingRow({ entry }: ModelPricingRowProps) {
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
