/**
 * Cost Card Component
 *
 * Displays a single cost metric with title, amount, and optional subtitle.
 * Used on the cost dashboard to show today/week/month totals.
 */

import { View, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

/**
 * Props for the CostCard component.
 */
interface CostCardProps {
  /** Card title (e.g., "Today", "This Week") */
  title: string;
  /** Cost amount in USD */
  amount: number;
  /** Optional subtitle text (e.g., "12 requests") */
  subtitle?: string;
  /** Icon name from Ionicons */
  icon?: keyof typeof Ionicons.glyphMap;
  /** Icon color (defaults to brand orange) */
  iconColor?: string;
  /** Whether this is a compact card (used in horizontal row) */
  compact?: boolean;
}

/**
 * Cost Card displays a cost metric with visual styling.
 *
 * @param props - Component props
 * @returns Rendered cost card
 *
 * @example
 * <CostCard
 *   title="Today"
 *   amount={12.34}
 *   subtitle="5 requests"
 *   icon="today"
 *   iconColor="#f97316"
 * />
 */
export function CostCard({
  title,
  amount,
  subtitle,
  icon = 'wallet',
  iconColor = '#f97316',
  compact = false,
}: CostCardProps) {
  /**
   * Format the cost amount for display.
   * Shows more decimals for small amounts.
   */
  const formatAmount = (value: number): string => {
    if (value === 0) return '$0.00';
    if (value < 0.01) return `$${value.toFixed(4)}`;
    if (value < 1) return `$${value.toFixed(3)}`;
    return `$${value.toFixed(2)}`;
  };

  if (compact) {
    return (
      <View className="flex-1 bg-background-secondary rounded-xl p-4">
        <View className="flex-row items-center mb-2">
          <Ionicons name={icon} size={16} color={iconColor} />
          <Text className="text-zinc-400 text-xs font-medium ml-1.5">{title}</Text>
        </View>
        <Text className="text-white text-lg font-bold">{formatAmount(amount)}</Text>
        {subtitle && <Text className="text-zinc-500 text-xs mt-0.5">{subtitle}</Text>}
      </View>
    );
  }

  return (
    <View className="bg-background-secondary rounded-xl p-4">
      <View className="flex-row items-center justify-between">
        <View className="flex-row items-center">
          <View
            className="w-10 h-10 rounded-xl items-center justify-center"
            style={{ backgroundColor: `${iconColor}20` }}
          >
            <Ionicons name={icon} size={20} color={iconColor} />
          </View>
          <View className="ml-3">
            <Text className="text-zinc-400 text-sm">{title}</Text>
            <Text className="text-white text-2xl font-bold">{formatAmount(amount)}</Text>
          </View>
        </View>
        {subtitle && (
          <View className="items-end">
            <Text className="text-zinc-500 text-sm">{subtitle}</Text>
          </View>
        )}
      </View>
    </View>
  );
}
