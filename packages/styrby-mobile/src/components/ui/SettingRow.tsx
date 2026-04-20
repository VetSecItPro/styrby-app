/**
 * SettingRow — A single row in a settings list.
 *
 * WHY: Previously inlined in `app/(tabs)/settings.tsx` (2,828 LOC monolith). Extracted
 * to `components/ui/` as part of the Phase 0.6.1 settings refactor so every
 * sub-screen (Account, Notifications, Appearance, Voice, Agents, Metrics, Support)
 * can consume the same primitive without duplication.
 *
 * @see docs/planning/settings-refactor-plan-2026-04-19.md §5 (Component Inventory)
 */

import { View, Text, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { ReactNode } from 'react';

export interface SettingRowProps {
  /** Ionicons icon name */
  icon: keyof typeof Ionicons.glyphMap;
  /** Background tint color for the icon badge */
  iconColor?: string;
  /** Primary label text */
  title: string;
  /** Secondary description text */
  subtitle?: string;
  /** Press handler — row shows a chevron when provided (and no trailing) */
  onPress?: () => void;
  /** Custom trailing element (e.g. a Switch) */
  trailing?: ReactNode;
}

/**
 * A single settings row with an icon, title, optional subtitle, and
 * either a trailing element or a chevron indicator.
 *
 * @param props - Row configuration
 * @returns React element
 */
export function SettingRow({
  icon,
  iconColor = '#71717a',
  title,
  subtitle,
  onPress,
  trailing,
}: SettingRowProps) {
  return (
    <Pressable
      className="flex-row items-center px-4 py-3 active:bg-zinc-900"
      onPress={onPress}
      disabled={!onPress && !trailing}
      accessibilityRole="button"
      accessibilityLabel={subtitle ? `${title}, ${subtitle}` : title}
    >
      <View
        className="w-8 h-8 rounded-lg items-center justify-center mr-3"
        style={{ backgroundColor: `${iconColor}20` }}
      >
        <Ionicons name={icon} size={18} color={iconColor} />
      </View>
      <View className="flex-1">
        <Text className="text-white font-medium">{title}</Text>
        {subtitle && <Text className="text-zinc-500 text-sm">{subtitle}</Text>}
      </View>
      {trailing ? <>{trailing}</> : onPress ? <Ionicons name="chevron-forward" size={20} color="#71717a" /> : null}
    </Pressable>
  );
}
