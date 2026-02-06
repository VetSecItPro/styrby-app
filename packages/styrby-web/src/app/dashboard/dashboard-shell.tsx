'use client';

import { useState } from 'react';
import { DashboardTopNav } from '@/components/dashboard/topnav';
import { DashboardSidebar } from '@/components/dashboard/sidebar';
import { MobileNav } from '@/components/dashboard/mobile-nav';
import { CommandPalette } from '@/components/dashboard/command-palette';
import { cn } from '@/lib/utils';

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

  return (
    <div className="min-h-screen">
      <DashboardTopNav />
      <DashboardSidebar collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)} />
      <CommandPalette />

      <main
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
