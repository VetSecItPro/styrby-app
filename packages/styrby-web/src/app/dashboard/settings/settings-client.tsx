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

import dynamic from 'next/dynamic';
import { Skeleton } from '@/components/ui/skeleton';
import type { OtelUserConfig } from '@/lib/otel-config';
import type { OtelSettingsProps } from '@/components/dashboard/otel-settings';

/**
 * WHY OtelSettings is dynamic: OtelSettings is a 506-line form component
 * (~30 kB parsed JS) that is gated behind the Power tier. Only ~10-15% of
 * users are on Power; the other 85-90% pay this parse cost needlessly if it
 * is in the eager bundle. Dynamic import moves it to an async chunk that is
 * only fetched when the settings page renders AND the user is on Power.
 *
 * WHY a skeleton loading state: The settings page scrolls. OtelSettings lives
 * below the fold. A brief skeleton during async chunk fetch prevents layout
 * shift and signals to the user that content is loading.
 */
const OtelSettings = dynamic<OtelSettingsProps>(
  () =>
    import('@/components/dashboard/otel-settings').then((mod) => ({
      default: mod.OtelSettings,
    })),
  {
    loading: () => (
      <div className="space-y-4 mb-8" aria-busy="true" aria-label="Loading OTEL settings">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-32 w-full rounded-xl" />
        <Skeleton className="h-10 w-24 rounded-lg" />
      </div>
    ),
    ssr: false,
  }
);
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
  const isPowerTier = subscription?.tier === 'growth';

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
