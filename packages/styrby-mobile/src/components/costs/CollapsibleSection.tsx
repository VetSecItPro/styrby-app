/**
 * Collapsible section primitive used by the costs dashboard for secondary
 * breakdowns (model, tag, team, pricing reference).
 *
 * WHY: The costs screen is data-dense. Defaulting reference/secondary data
 * to collapsed keeps the primary spend cards above the fold while still
 * letting users drill in when they need to.
 *
 * @module components/costs/CollapsibleSection
 */

import { View, Text, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { CollapsibleSectionProps } from '../../types/costs';

/**
 * Renders a header row that toggles visibility of its children.
 *
 * @param props - {@link CollapsibleSectionProps}
 * @returns Rendered collapsible section
 */
export function CollapsibleSection({
  title,
  isExpanded,
  onToggle,
  children,
}: CollapsibleSectionProps) {
  return (
    <View className="bg-background-secondary rounded-xl">
      <Pressable
        onPress={onToggle}
        className="flex-row items-center justify-between p-4 active:opacity-80"
        accessibilityRole="button"
        accessibilityLabel={`${title}, ${isExpanded ? 'collapse' : 'expand'}`}
        accessibilityState={{ expanded: isExpanded }}
      >
        <Text className="text-zinc-400 text-sm font-medium">{title}</Text>
        <Ionicons
          name={isExpanded ? 'chevron-up' : 'chevron-down'}
          size={18}
          color="#71717a"
        />
      </Pressable>
      {isExpanded && <View className="px-4 pb-4">{children}</View>}
    </View>
  );
}
