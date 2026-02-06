"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { Home, MessageSquare, BarChart3, Cpu, Settings, PanelLeftClose, PanelLeft } from "lucide-react"
import { cn } from "@/lib/utils"
import { Progress } from "@/components/ui/progress"

const navItems = [
  { label: "Dashboard", href: "/dashboard", icon: Home },
  { label: "Sessions", href: "/dashboard/sessions", icon: MessageSquare },
  { label: "Costs", href: "/dashboard/costs", icon: BarChart3 },
  { label: "Agents", href: "/dashboard/agents", icon: Cpu },
  { label: "Settings", href: "/dashboard/settings", icon: Settings },
]

export function DashboardSidebar({
  collapsed,
  onToggle,
}: {
  collapsed: boolean
  onToggle: () => void
}) {
  const pathname = usePathname()

  return (
    <aside
      className={cn(
        "fixed left-0 top-16 z-30 hidden h-[calc(100vh-4rem)] flex-col border-r border-border/40 bg-card/30 transition-all duration-200 md:flex",
        collapsed ? "w-16" : "w-60"
      )}
    >
      <div className="flex flex-1 flex-col px-3 py-4">
        <button
          type="button"
          onClick={onToggle}
          className="mb-4 flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? <PanelLeft className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
        </button>

        <nav className="flex flex-1 flex-col gap-1">
          {navItems.map((item) => {
            const isActive = pathname === item.href
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-all duration-200",
                  isActive
                    ? "border-l-2 border-amber-500 bg-amber-500/10 text-amber-500"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground",
                  collapsed && "justify-center px-0"
                )}
              >
                <item.icon className={cn("h-5 w-5 shrink-0", isActive && "text-amber-500")} />
                {!collapsed && <span>{item.label}</span>}
              </Link>
            )
          })}
        </nav>

        {/* Plan badge and usage */}
        {!collapsed && (
          <div className="mt-auto border-t border-border/40 pt-4">
            <div className="rounded-lg bg-secondary/60 p-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-foreground">Pro Plan</span>
                <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-medium text-amber-500">
                  Active
                </span>
              </div>
              <div className="mt-3">
                <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                  <span>847 / 25,000 messages</span>
                  <span>3.4%</span>
                </div>
                <Progress value={3.4} className="mt-1 h-1 bg-secondary [&>div]:bg-amber-500" />
              </div>
            </div>
          </div>
        )}
      </div>
    </aside>
  )
}
