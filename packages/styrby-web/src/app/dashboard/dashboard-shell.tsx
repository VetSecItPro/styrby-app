'use client';

import { useState, useEffect } from 'react';
import { DashboardTopNav } from '@/components/dashboard/topnav';
import { DashboardSidebar } from '@/components/dashboard/sidebar';
import { MobileNav } from '@/components/dashboard/mobile-nav';
import { CommandPalette } from '@/components/dashboard/command-palette';
import { OnboardingModal } from '@/components/dashboard/onboarding-modal';
import { OnboardingBanner } from '@/components/dashboard/onboarding-banner';
import { cn } from '@/lib/utils';
import { startConnectivityListener } from '@/lib/offline-sync';
import type { OnboardingState } from '@/lib/onboarding';

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

      <main
        id="main-content"
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
