/**
 * Segmented control for selecting the cost dashboard time range.
 *
 * WHY: The web dashboard uses a dropdown for 7/30/90 day views. On mobile,
 * a segmented control is more touch-friendly and discoverable than a
 * dropdown — three taps are visible at all times, no extra tap to open.
 *
 * @module components/costs/TimeRangeSelector
 */

import { View, Text, Pressable } from 'react-native';
import type { CostTimeRange } from '../../hooks/useCosts';
import type { TimeRangeSelectorProps } from '../../types/costs';

/**
 * Available time-range options. Hoisted to module level so the array isn't
 * re-allocated on every render.
 */
const OPTIONS: ReadonlyArray<{ value: CostTimeRange; label: string }> = [
  { value: 7, label: '7D' },
  { value: 30, label: '30D' },
  { value: 90, label: '90D' },
];

/**
 * Renders a 3-segment radio control for picking the cost dashboard range.
 *
 * @param props - {@link TimeRangeSelectorProps}
 * @returns Rendered segmented control
 */
export function TimeRangeSelector({ selected, onSelect }: TimeRangeSelectorProps) {
  return (
    <View
      className="flex-row bg-zinc-800 rounded-xl p-1"
      accessibilityRole="radiogroup"
      accessibilityLabel="Time range selector"
    >
      {OPTIONS.map((option) => {
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
