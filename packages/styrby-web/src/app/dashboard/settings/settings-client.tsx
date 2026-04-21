'use client';

/**
 * SettingsClient — orchestrator for the dashboard settings surface.
 *
 * WHY an orchestrator (and not a monolith): prior to this refactor this file
 * was a 1,717-LOC god-component that owned every settings concern. Every
 * Phase-2 addition (Team/SSO/billing history/MCP/etc.) grew the file further.
 * The refactor split each UI section into its own `_components/` module so:
 *   - each section's state stays local to the section,
 *   - the orchestrator remains declarative (compose sections in order),
 *   - future sections slot in without reopening existing files.
 *
 * This file now owns ONLY:
 *   - top-level prop typing (imported from `_components/types.ts`),
 *   - the order in which sections render,
 *   - cross-cutting concerns that genuinely belong at the orchestrator
 *     level (currently: OTEL section which depends on raw profile JSON).
 */

import { OtelSettings } from '@/components/dashboard/otel-settings';
import type { OtelUserConfig } from '@/lib/otel-config';
import {
  SettingsAccount,
  SettingsSubscription,
  SettingsAppearance,
  SettingsNotifications,
  SettingsAgents,
  SettingsIntegrations,
  SettingsDataPrivacy,
  SettingsSupport,
  SettingsDangerZone,
} from './_components';
import type { SettingsClientProps } from './_components/types';

/**
 * Client-side interactive settings panel.
 *
 * Renders each settings section in a fixed order. Each section is
 * self-contained and owns its own Supabase calls, router.refresh() triggers,
 * and dialog state.
 *
 * @param props - Pre-fetched data from the server component.
 */
export function SettingsClient({
  user,
  profile,
  subscription,
  notificationPrefs,
  agentConfigs,
}: SettingsClientProps) {
  const isPowerTier = subscription?.tier === 'power';

  return (
    <>
      <SettingsAccount user={user} profile={profile} />
      <SettingsSubscription subscription={subscription} />
      <SettingsAppearance />
      <SettingsNotifications
        profile={profile}
        notificationPrefs={notificationPrefs}
        subscription={subscription}
      />
      <SettingsAgents agentConfigs={agentConfigs} />
      <SettingsIntegrations />
      <SettingsDataPrivacy />
      <SettingsSupport />

      {/* OTEL Metrics Export
          WHY inline (not a sub-component): OtelSettings is already a
          well-scoped shared component from @/components/dashboard; wrapping
          it in a pass-through `SettingsOtel` would add a file without
          reducing complexity. */}
      <section className="mb-8">
        <OtelSettings
          isPowerTier={isPowerTier}
          initialConfig={
            ((profile as Record<string, unknown> | null)?.['otel_config'] as
              | OtelUserConfig
              | null) ?? null
          }
        />
      </section>

      <SettingsDangerZone />
    </>
  );
}
