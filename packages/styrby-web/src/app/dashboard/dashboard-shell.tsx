'use client';

import { useState, useEffect } from 'react';
import { DashboardTopNav } from '@/components/dashboard/topnav';
import { DashboardSidebar } from '@/components/dashboard/sidebar';
import { MobileNav } from '@/components/dashboard/mobile-nav';
import { CommandPalette } from '@/components/dashboard/command-palette';
import { cn } from '@/lib/utils';
import { startConnectivityListener } from '@/lib/offline-sync';

/**
 * Client-side dashboard shell with collapsible sidebar, topnav, and mobile nav.
 *
 * WHY separate from layout: Next.js App Router layouts are server components by
 * default. The sidebar collapse state and mobile nav toggle require useState,
 * which only works in client components. This component handles all interactive
 * chrome while the parent layout.tsx handles auth.
 */
export function DashboardShell({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);

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
      <DashboardSidebar collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)} />
      <CommandPalette />

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
