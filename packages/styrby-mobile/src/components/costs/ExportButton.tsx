/**
 * Export button shown in the costs screen header.
 *
 * Power-tier-gated: free/pro users see a disabled, locked variant.
 *
 * @module components/costs/ExportButton
 */

import { Pressable, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { ExportButtonProps } from '../../types/costs';
import { isPremiumTier } from 'styrby-shared';

/**
 * Renders the export button. The orchestrator owns the format-picker logic
 * and the in-flight state — this component is purely presentational.
 *
 * @param props - {@link ExportButtonProps}
 * @returns Rendered pressable button
 */
export function ExportButton({ tier, isExporting, onPress }: ExportButtonProps) {
  // Cost export is a premium (growth/power) feature — not just legacy 'power'.
  const isPremium = isPremiumTier(tier);
  return (
    <Pressable
      onPress={isPremium ? onPress : undefined}
      disabled={isExporting || !isPremium}
      className={`flex-row items-center px-3 py-1.5 rounded-lg border gap-1.5 active:opacity-80 ${
        isPremium
          ? 'border-zinc-700 bg-zinc-800'
          : 'border-zinc-800/50 opacity-40'
      }`}
      accessibilityRole="button"
      accessibilityLabel={
        !isPremium
          ? 'Export costs, requires Power plan'
          : isExporting
            ? 'Exporting...'
            : 'Export cost data'
      }
    >
      <Ionicons
        name={isExporting ? 'hourglass-outline' : 'download-outline'}
        size={14}
        color="#a1a1aa"
      />
      <Text className="text-zinc-400 text-xs font-medium">
        {isExporting ? 'Exporting…' : 'Export'}
      </Text>
      {!isPremium && <Ionicons name="lock-closed" size={10} color="#52525b" />}
    </Pressable>
  );
}
