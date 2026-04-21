/**
 * Agent Configuration — Barrel Exports
 *
 * Public surface of the `agent-config` component group consumed by the
 * orchestrator at `app/agent-config.tsx`. Constants/types are re-exported
 * for convenience so the orchestrator only needs one import path.
 */

export { ActionButtons } from './ActionButtons';
export { AgentHeader } from './AgentHeader';
export { AutoApproveSection } from './AutoApproveSection';
export { BlockedToolsSection } from './BlockedToolsSection';
export { CostLimitSection } from './CostLimitSection';
export { CustomPromptSection } from './CustomPromptSection';
export { ModelSection } from './ModelSection';
export { RiskLevelBadge } from './RiskLevelBadge';
export { SaveSuccessToast } from './SaveSuccessToast';
export { SectionHeader } from './SectionHeader';
export { ToggleRow } from './ToggleRow';

export {
  AGENT_META,
  ALL_AGENT_IDS,
  APPROVE_PATTERN_FILE_READ,
  APPROVE_PATTERN_FILE_WRITE,
  APPROVE_PATTERN_TERMINAL,
  APPROVE_PATTERN_WEB,
  DEFAULT_CONFIG,
  RISK_HIGH,
  RISK_LOW,
  RISK_MEDIUM,
} from './constants';

export { hasChanges, patternsToToggles, togglesToPatterns } from './utils';

// WHY exported: orchestrator imports the hook to get state + handlers.
// Matches the barrel pattern of the chat/sessions/webhooks groups.
export { useAgentConfig } from './use-agent-config';
