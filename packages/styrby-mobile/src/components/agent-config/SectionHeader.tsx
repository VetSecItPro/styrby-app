/**
 * Agent Configuration — SectionHeader
 *
 * Local section header variant used by the Agent Config screen.
 *
 * WHY: A separate primitive from `@/components/ui/SectionHeader` because the
 * Agent Config screen uses different vertical spacing (`pt-6 pb-2` vs the
 * settings-screen variant's `py-2 bg-background`). Splitting them preserves
 * the exact pre-refactor visual rhythm without forking the shared primitive.
 */

import { Text } from 'react-native';

export interface AgentConfigSectionHeaderProps {
  /** The section title text (rendered uppercase via CSS) */
  title: string;
}

/**
 * Section header label matching the agent-config screen style.
 *
 * @param props - Contains the section title string
 * @returns React element
 */
export function SectionHeader({ title }: AgentConfigSectionHeaderProps) {
  return (
    <Text className="text-zinc-500 text-xs font-semibold uppercase px-4 pt-6 pb-2">
      {title}
    </Text>
  );
}
