/**
 * Agent Configuration — AutoApproveSection
 *
 * Renders the "Auto-Approve Rules" group: four `ToggleRow`s (file reads,
 * file writes, terminal commands, web searches) wired to the same form-state
 * field updater.
 *
 * WHY: The four toggles share an identical wiring pattern; collecting them
 * in one component means the orchestrator only deals with a single
 * "update one boolean" callback instead of four near-duplicate JSX blocks.
 */

import { View } from 'react-native';
import type { AgentConfigState } from '@/types/agent-config';
import { RISK_HIGH, RISK_LOW, RISK_MEDIUM } from './constants';
import { SectionHeader } from './SectionHeader';
import { ToggleRow } from './ToggleRow';

export interface AutoApproveSectionProps {
  /** Current form state — only the four `autoApprove*` fields are read. */
  config: AgentConfigState;
  /**
   * Updater for a single boolean field on the form state.
   *
   * @param field - One of the four auto-approve keys.
   * @param value - New boolean value.
   */
  onToggle: (
    field: 'autoApproveReads' | 'autoApproveWrites' | 'autoApproveCommands' | 'autoApproveWeb',
    value: boolean,
  ) => void;
}

/**
 * Renders the Auto-Approve Rules section with the four risk-tagged toggles.
 *
 * @param props - Section props.
 * @returns React element
 */
export function AutoApproveSection({ config, onToggle }: AutoApproveSectionProps) {
  return (
    <>
      <SectionHeader title="Auto-Approve Rules" />
      <View className="bg-background-secondary mx-4 rounded-xl overflow-hidden">
        <ToggleRow
          title="File Reads"
          subtitle="Allow reading files without confirmation"
          risk={RISK_LOW}
          value={config.autoApproveReads}
          onValueChange={(val) => onToggle('autoApproveReads', val)}
        />
        <View className="h-px bg-zinc-800 mx-4" />
        <ToggleRow
          title="File Writes"
          subtitle="Allow writing and editing files"
          risk={RISK_MEDIUM}
          value={config.autoApproveWrites}
          onValueChange={(val) => onToggle('autoApproveWrites', val)}
        />
        <View className="h-px bg-zinc-800 mx-4" />
        <ToggleRow
          title="Terminal Commands"
          subtitle="Allow executing shell commands"
          risk={RISK_HIGH}
          value={config.autoApproveCommands}
          onValueChange={(val) => onToggle('autoApproveCommands', val)}
        />
        <View className="h-px bg-zinc-800 mx-4" />
        <ToggleRow
          title="Web Searches"
          subtitle="Allow searching the web for context"
          risk={RISK_LOW}
          value={config.autoApproveWeb}
          onValueChange={(val) => onToggle('autoApproveWeb', val)}
        />
      </View>
    </>
  );
}
