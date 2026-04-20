/**
 * SectionHeader — A section heading for grouping related settings rows.
 *
 * WHY: Previously inlined in `app/(tabs)/settings.tsx`. Extracted to `components/ui/`
 * as part of the Phase 0.6.1 settings refactor so every sub-screen uses the same
 * uppercase header style without duplicating the classes.
 *
 * @see docs/planning/settings-refactor-plan-2026-04-19.md §5 (Component Inventory)
 */

import { Text } from 'react-native';

export interface SectionHeaderProps {
  /** The section title text (rendered uppercase via CSS) */
  title: string;
}

/**
 * Section header label for grouping related settings.
 *
 * @param props - Contains the section title string
 * @returns React element
 */
export function SectionHeader({ title }: SectionHeaderProps) {
  return (
    <Text className="text-zinc-500 text-xs font-semibold uppercase px-4 py-2 bg-background">
      {title}
    </Text>
  );
}
