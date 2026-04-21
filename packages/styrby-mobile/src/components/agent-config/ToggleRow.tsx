/**
 * Agent Configuration — ToggleRow
 *
 * A single labeled switch row with optional subtitle and risk badge.
 *
 * WHY: This row appears four times in the Auto-Approve Rules section; pulling
 * it out keeps the orchestrator focused on layout and lets us evolve the row's
 * accessibility / styling in one place.
 */

import { View, Text, Switch } from 'react-native';
import type { RiskBadge } from '@/types/agent-config';
import { RiskLevelBadge } from './RiskLevelBadge';

export interface ToggleRowProps {
  /** Primary label text */
  title: string;
  /** Secondary description text */
  subtitle?: string;
  /** Risk level metadata for the badge */
  risk: RiskBadge;
  /** Current toggle state */
  value: boolean;
  /** Callback when the toggle changes */
  onValueChange: (val: boolean) => void;
}

/**
 * A toggle row with a label, optional subtitle, risk badge, and switch.
 *
 * @param props - Row configuration
 * @returns React element
 */
export function ToggleRow({
  title,
  subtitle,
  risk,
  value,
  onValueChange,
}: ToggleRowProps) {
  return (
    <View className="flex-row items-center px-4 py-3">
      <View className="flex-1">
        <View className="flex-row items-center">
          <Text className="text-white font-medium mr-2">{title}</Text>
          <RiskLevelBadge risk={risk} />
        </View>
        {subtitle ? (
          <Text className="text-zinc-500 text-sm mt-0.5">{subtitle}</Text>
        ) : null}
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        trackColor={{ false: '#3f3f46', true: '#f9731650' }}
        thumbColor={value ? '#f97316' : '#71717a'}
        accessibilityRole="switch"
        accessibilityLabel={`Toggle ${title}`}
      />
    </View>
  );
}
