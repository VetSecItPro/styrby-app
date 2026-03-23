import type { Metadata } from 'next';
import { Suspense } from 'react';
import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { DashboardShell } from './dashboard-shell';
import { PlanCheckout } from './plan-checkout';
import { getOnboardingState } from '@/lib/onboarding';
import { PWAInstallPrompt } from '@/components/pwa-install-prompt';

/**
 * Prevents all dashboard routes from being indexed by search engines.
 *
 * WHY: Dashboard pages contain user-specific, authenticated content that has
 * no value to search engines and should never appear in search results.
 * Setting noindex here covers every page under /dashboard/* in one place.
 */
export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
  },
};

/**
 * Dashboard layout - server component that checks auth, then renders the
 * client-side shell with sidebar, topnav, mobile nav, and command palette.
 *
 * WHY server component wrapper: We need server-side auth verification before
 * rendering any dashboard content. The middleware cookie check is a fast-path
 * guard, but this layout does the authoritative getUser() call. The actual
 * UI chrome (sidebar collapse state, mobile nav toggle) requires client-side
 * interactivity, so we delegate to DashboardShell.
 */
export default async function DashboardLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const supabase = await createClient();

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    redirect('/login');
  }

  const onboardingState = await getOnboardingState(supabase, user.id);

  return (
    <DashboardShell onboardingState={onboardingState.isComplete ? undefined : onboardingState}>
      <Suspense>
        <PlanCheckout />
      </Suspense>
      {children}
      <PWAInstallPrompt />
    </DashboardShell>
  );
}
