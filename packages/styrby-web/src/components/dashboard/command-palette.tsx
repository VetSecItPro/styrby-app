"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { Home, MessageSquare, BarChart3, Cpu, Settings } from "lucide-react"
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
} from "@/components/ui/command"

const pages = [
  { label: "Dashboard", href: "/dashboard", icon: Home, shortcut: "D" },
  { label: "Sessions", href: "/dashboard/sessions", icon: MessageSquare, shortcut: "S" },
  { label: "Costs", href: "/dashboard/costs", icon: BarChart3, shortcut: "C" },
  { label: "Agents", href: "/dashboard/agents", icon: Cpu, shortcut: "A" },
  { label: "Settings", href: "/dashboard/settings", icon: Settings, shortcut: "," },
]

export function CommandPalette() {
  const [open, setOpen] = useState(false)
  const router = useRouter()

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      // Cmd+K to open command palette
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setOpen((open) => !open)
      }
      // Keyboard shortcuts for quick navigation
      if (!open && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const target = e.target as HTMLElement
        if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return

        for (const page of pages) {
          if (e.key.toLowerCase() === page.shortcut.toLowerCase()) {
            router.push(page.href)
            return
          }
        }
      }
    }

    document.addEventListener("keydown", down)
    return () => document.removeEventListener("keydown", down)
  }, [open, router])

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Type a command or search..." />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        <CommandGroup heading="Navigation">
          {pages.map((page) => (
            <CommandItem
              key={page.href}
              onSelect={() => {
                router.push(page.href)
                setOpen(false)
              }}
            >
              <page.icon className="mr-2 h-4 w-4" />
              {page.label}
              <CommandShortcut>{page.shortcut}</CommandShortcut>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}
