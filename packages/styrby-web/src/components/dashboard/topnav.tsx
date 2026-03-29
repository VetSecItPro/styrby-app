"use client"

import Link from "next/link"
import Image from "next/image"
import { Bell, ChevronDown, LogOut, Settings, CreditCard } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

/**
 * Placeholder notification count.
 * WHY: Hardcoded until the notifications feature is wired to a real data source.
 * Replace with a prop or hook when the notification system is implemented.
 */
const NOTIFICATION_COUNT = 3;

/** Tier badge colors */
const TIER_STYLES = {
  free: 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20',
  pro: 'bg-amber-500/10 text-amber-500 border-amber-500/20',
  power: 'bg-amber-500/20 text-amber-400 border-amber-400/30',
} as const;

interface DashboardTopNavProps {
  /** Current subscription tier. Defaults to 'free'. */
  tier?: 'free' | 'pro' | 'power';
}

export function DashboardTopNav({ tier = 'free' }: DashboardTopNavProps) {
  return (
    <header className="fixed left-0 right-0 top-0 z-40 flex h-16 items-center justify-between border-b border-border/40 bg-card/80 px-6 backdrop-blur-md">
      <div className="flex items-center gap-3">
        <Link href="/dashboard" className="flex items-center gap-2">
          <Image src="/logo.png" alt="Styrby" width={24} height={24} className="h-6 w-6" />
          <span className="text-lg font-bold text-foreground">Styrby</span>
        </Link>
        <span className={`rounded-full border px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${TIER_STYLES[tier]}`}>
          {tier}
        </span>
      </div>

      <div className="flex items-center gap-3">
        {/* Notification bell */}
        {/* WHY: WCAG 1.3.1 - include the count in aria-label so screen readers
            announce "Notifications, 3 unread" rather than just "Notifications". */}
        <Button
          variant="ghost"
          size="icon"
          className="relative text-muted-foreground hover:text-foreground"
          aria-label={NOTIFICATION_COUNT > 0 ? `Notifications, ${NOTIFICATION_COUNT} unread` : 'Notifications'}
        >
          <Bell className="h-5 w-5" />
          {NOTIFICATION_COUNT > 0 && (
            <span
              className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-amber-500 text-[9px] font-bold text-background"
              aria-hidden="true"
            >
              {NOTIFICATION_COUNT}
            </span>
          )}
        </Button>

        {/* User dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="gap-2 text-muted-foreground hover:text-foreground">
              <div className="flex h-7 w-7 items-center justify-center rounded-full bg-amber-500/20 text-xs font-bold text-amber-500">
                KR
              </div>
              <span className="hidden text-sm md:inline">Kai Rivera</span>
              <ChevronDown className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48 bg-card border-border/60">
            <DropdownMenuItem asChild className="text-muted-foreground focus:text-foreground">
              <Link href="/dashboard/settings" className="gap-2">
                <Settings className="h-4 w-4" />
                Settings
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild className="text-muted-foreground focus:text-foreground">
              <Link href="/dashboard/settings?tab=billing" className="gap-2">
                <CreditCard className="h-4 w-4" />
                Billing
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator className="bg-border/40" />
            <DropdownMenuItem asChild className="text-muted-foreground focus:text-foreground">
              <Link href="/login" className="gap-2">
                <LogOut className="h-4 w-4" />
                Sign Out
              </Link>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}
