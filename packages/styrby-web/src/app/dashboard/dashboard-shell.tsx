'use client';

import { useState, useEffect } from 'react';
import dynamic from 'next/dynamic';
import { DashboardTopNav } from '@/components/dashboard/topnav';
import { DashboardSidebar } from '@/components/dashboard/sidebar';
import { MobileNav } from '@/components/dashboard/mobile-nav';
import { cn } from '@/lib/utils';
import { startConnectivityListener } from '@/lib/offline-sync';
import type { OnboardingState } from '@/lib/onboarding';

/**
 * WHY CommandPalette is dynamic: cmdk is ~45 kB gzipped and only needed when
 * Cmd+K is pressed. Loading it eagerly adds it to the first-load shared chunk
 * even though most users never open the palette. Moving it async drops cmdk
 * from the critical path without any UX regression (dialog stays closed on
 * first paint regardless).
 * WHY ssr: false: The palette is always closed on first render. SSR would
 * produce an empty closed dialog that is immediately replaced — no value.
 */
const CommandPalette = dynamic(
  () =>
    import('@/components/dashboard/command-palette').then((mod) => ({
      default: mod.CommandPalette,
    })),
  { loading: () => null, ssr: false }
);

/**
 * WHY OnboardingModal is dynamic: The onboarding modal is shown only on a
 * user's first few sessions (while `onboardingState` is truthy). Deferring
 * the import keeps the modal's JS out of the first-load chunk for the >95%
 * of sessions where the user has already completed onboarding.
 * WHY ssr: false: The modal's open/closed state is determined by client-side
 * JS. SSR would render a "loading" flash for returning users — not worth it.
 */
const OnboardingModal = dynamic(
  () =>
    import('@/components/dashboard/onboarding-modal').then((mod) => ({
      default: mod.OnboardingModal,
    })),
  { loading: () => null, ssr: false }
);

/**
 * WHY OnboardingBanner is dynamic: Same reasoning as OnboardingModal — shown
 * only during a user's first few sessions. Conditional rendering already gates
 * it on `onboardingState`; dynamic import ensures the bundle is not fetched
 * at all for users who have completed onboarding.
 */
const OnboardingBanner = dynamic(
  () =>
    import('@/components/dashboard/onboarding-banner').then((mod) => ({
      default: mod.OnboardingBanner,
    })),
  { loading: () => null, ssr: false }
);

interface DashboardShellProps {
  children: React.ReactNode;
  /**
   * Onboarding state for the current user. Undefined when onboarding
   * is already complete, in which case no onboarding UI is rendered.
   */
  onboardingState?: OnboardingState;
}

/**
 * Client-side dashboard shell with collapsible sidebar, topnav, and mobile nav.
 *
 * WHY separate from layout: Next.js App Router layouts are server components by
 * default. The sidebar collapse state and mobile nav toggle require useState,
 * which only works in client components. This component handles all interactive
 * chrome while the parent layout.tsx handles auth.
 *
 * When onboardingState is provided (user has not completed onboarding), this
 * component renders the welcome modal on first render and a persistent sidebar
 * banner until all steps are done.
 */
export function DashboardShell({ children, onboardingState }: DashboardShellProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [showOnboardingModal, setShowOnboardingModal] = useState(!!onboardingState);

  // WHY: Start the offline sync connectivity listener when the dashboard
  // mounts. This listens for browser online/offline events and automatically
  // syncs locally stored commands to the Supabase offline_command_queue table
  // when the user comes back online. Placed here (not root layout) because
  // only authenticated users in the dashboard need cloud sync.
  useEffect(() => {
    const unsubscribe = startConnectivityListener();
    return unsubscribe;
  }, []);

  return (
    <div className="min-h-screen">
      <DashboardTopNav />
      <DashboardSidebar
        collapsed={collapsed}
        onToggle={() => setCollapsed(!collapsed)}
        onboardingBanner={
          onboardingState ? <OnboardingBanner onboardingState={onboardingState} /> : undefined
        }
      />
      <CommandPalette />

      {/* Onboarding welcome modal, shown once on first render */}
      {onboardingState && showOnboardingModal && (
        <OnboardingModal
          onboardingState={onboardingState}
          onDismiss={() => setShowOnboardingModal(false)}
        />
      )}

      {/* WHY tabIndex={-1}: The skip-to-content link targets #main-content.
          Without tabIndex={-1}, browsers (especially Firefox) won't move
          focus to a non-interactive element after following the skip link,
          meaning keyboard users who activate the skip link still have to
          tab through the entire header. tabIndex={-1} makes the element
          programmatically focusable without placing it in the tab order. */}
      <main
        id="main-content"
        tabIndex={-1}
        className={cn(
          'pt-16 pb-20 transition-all duration-200 md:pb-0',
          collapsed ? 'md:pl-16' : 'md:pl-60'
        )}
      >
        <div className="mx-auto max-w-7xl p-6">
          {children}
        </div>
      </main>

      <MobileNav />
    </div>
  );
}
