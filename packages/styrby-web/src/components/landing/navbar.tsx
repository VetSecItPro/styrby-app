"use client"

import { useState, useEffect } from "react"
import Link from "next/link"
import { Menu, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export function Navbar() {
  const [scrolled, setScrolled] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)

  useEffect(() => {
    const handleScroll = () => setScrolled(window.scrollY > 20)
    window.addEventListener("scroll", handleScroll)
    return () => window.removeEventListener("scroll", handleScroll)
  }, [])

  return (
    <nav
      className={cn(
        "fixed top-0 left-0 right-0 z-50 transition-all duration-200",
        scrolled
          ? "glass border-b border-border/50"
          : "bg-transparent"
      )}
    >
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6">
        <Link href="/" className="flex items-center gap-2">
          <div className="h-6 w-6 rounded-sm bg-amber-500" />
          <span className="text-lg font-bold text-foreground">Styrby</span>
        </Link>

        <div className="hidden items-center gap-8 md:flex">
          <Link href="/#features" className="text-sm text-muted-foreground transition-colors hover:text-foreground">
            Features
          </Link>
          <Link href="/pricing" className="text-sm text-muted-foreground transition-colors hover:text-foreground">
            Pricing
          </Link>
          <Link href="#" className="text-sm text-muted-foreground transition-colors hover:text-foreground">
            Docs
          </Link>
          <Link href="#" className="text-sm text-muted-foreground transition-colors hover:text-foreground">
            Blog
          </Link>
        </div>

        <div className="hidden items-center gap-3 md:flex">
          <Button variant="outline" asChild className="border-border text-foreground hover:bg-accent bg-transparent">
            <Link href="/login">Sign In</Link>
          </Button>
          <Button asChild className="bg-amber-500 text-background hover:bg-amber-600 font-medium">
            <Link href="/signup">Start Free</Link>
          </Button>
        </div>

        <button
          type="button"
          className="text-muted-foreground md:hidden"
          onClick={() => setMobileOpen(!mobileOpen)}
          aria-label={mobileOpen ? "Close menu" : "Open menu"}
        >
          {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </div>

      {mobileOpen && (
        <div className="glass border-b border-border/50 px-6 pb-6 md:hidden">
          <div className="flex flex-col gap-4">
            <Link href="/#features" className="text-sm text-muted-foreground" onClick={() => setMobileOpen(false)}>
              Features
            </Link>
            <Link href="/pricing" className="text-sm text-muted-foreground" onClick={() => setMobileOpen(false)}>
              Pricing
            </Link>
            <Link href="#" className="text-sm text-muted-foreground" onClick={() => setMobileOpen(false)}>
              Docs
            </Link>
            <Link href="#" className="text-sm text-muted-foreground" onClick={() => setMobileOpen(false)}>
              Blog
            </Link>
            <div className="flex flex-col gap-2 pt-2">
              <Button variant="outline" asChild className="border-border text-foreground bg-transparent">
                <Link href="/login">Sign In</Link>
              </Button>
              <Button asChild className="bg-amber-500 text-background hover:bg-amber-600">
                <Link href="/signup">Start Free</Link>
              </Button>
            </div>
          </div>
        </div>
      )}
    </nav>
  )
}
