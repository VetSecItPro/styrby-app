"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { Home, MessageSquare, BarChart3, Cpu, Settings } from "lucide-react"
import { cn } from "@/lib/utils"

const navItems = [
  { label: "Home", href: "/dashboard", icon: Home },
  { label: "Sessions", href: "/dashboard/sessions", icon: MessageSquare },
  { label: "Costs", href: "/dashboard/costs", icon: BarChart3 },
  { label: "Agents", href: "/dashboard/agents", icon: Cpu },
  { label: "Settings", href: "/dashboard/settings", icon: Settings },
]

export function MobileNav() {
  const pathname = usePathname()

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-40 border-t border-border/40 bg-card/90 backdrop-blur-md md:hidden">
      <div className="flex items-center justify-around py-2">
        {navItems.map((item) => {
          const isActive = pathname === item.href
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex flex-col items-center gap-1 px-3 py-1 text-[10px] transition-colors",
                isActive ? "text-amber-500" : "text-muted-foreground"
              )}
            >
              <item.icon className="h-5 w-5" />
              {item.label}
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
