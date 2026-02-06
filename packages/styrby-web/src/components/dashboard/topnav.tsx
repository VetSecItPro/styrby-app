"use client"

import Link from "next/link"
import { Bell, ChevronDown, LogOut, Settings, CreditCard } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

export function DashboardTopNav() {
  return (
    <header className="fixed left-0 right-0 top-0 z-40 flex h-16 items-center justify-between border-b border-border/40 bg-card/80 px-6 backdrop-blur-md">
      <Link href="/dashboard" className="flex items-center gap-2">
        <div className="h-6 w-6 rounded-sm bg-amber-500" />
        <span className="text-lg font-bold text-foreground">Styrby</span>
      </Link>

      <div className="flex items-center gap-3">
        {/* Notification bell */}
        <Button variant="ghost" size="icon" className="relative text-muted-foreground hover:text-foreground" aria-label="Notifications">
          <Bell className="h-5 w-5" />
          <span className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-amber-500 text-[9px] font-bold text-background">
            3
          </span>
        </Button>

        {/* User dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="gap-2 text-muted-foreground hover:text-foreground">
              <div className="flex h-7 w-7 items-center justify-center rounded-full bg-amber-500/20 text-xs font-bold text-amber-500">
                JS
              </div>
              <span className="hidden text-sm md:inline">Jane Smith</span>
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
