/**
 * Barrel for SettingsClient orchestrator imports.
 *
 * WHY only section components are re-exported: internal primitives
 * (SettingsLinkRow, dialogs, hooks, utils) are implementation details of the
 * section components. The orchestrator only needs to compose sections.
 * Keeping the barrel narrow prevents accidental coupling to internals.
 */
export { SettingsAccount } from './settings-account';
export { SettingsSubscription } from './settings-subscription';
export { SettingsAppearance } from './settings-appearance';
export { SettingsNotifications } from './settings-notifications';
export { SettingsAgents } from './settings-agents';
export { SettingsIntegrations } from './settings-integrations';
export { SettingsDataPrivacy } from './settings-data-privacy';
export { SettingsSupport } from './settings-support';
export { SettingsDangerZone } from './settings-danger-zone';
export type { SettingsClientProps } from './types';
