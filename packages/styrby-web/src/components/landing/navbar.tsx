"use client"

import { useState, useEffect, useRef } from "react"
import Link from "next/link"
import Image from "next/image"
import { Menu, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * Floating pill-style navbar with glass-morphism treatment.
 *
 * WHY this design approach:
 * - Floating pill separates the nav visually from page content, giving the
 *   hero room to breathe underneath instead of being pinned to the edge.
 * - Glass effect with `backdrop-blur-2xl` creates depth without a heavy
 *   opaque bar dominating the viewport.
 * - The inset top shadow adds a subtle highlight that makes the pill feel
 *   illuminated from above - a luxury detail borrowed from hardware product UX.
 * - On scroll, the border brightens slightly so the nav stays legible against
 *   any section color the user scrolls into.
 */
export function Navbar() {
  const [scrolled, setScrolled] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const mobileMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleScroll = () => setScrolled(window.scrollY > 20)
    window.addEventListener("scroll", handleScroll)
    return () => window.removeEventListener("scroll", handleScroll)
  }, [])

  // WHY: WCAG 2.1.1 - Escape key must close the mobile menu so keyboard users
  // can exit the expanded navigation without using a pointer.
  useEffect(() => {
    if (!mobileOpen) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileOpen(false)
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [mobileOpen])

  // WHY: WCAG 2.4.3 - when the mobile menu opens, focus moves to the first
  // interactive element inside so keyboard users immediately enter the menu.
  useEffect(() => {
    if (mobileOpen && mobileMenuRef.current) {
      const firstLink = mobileMenuRef.current.querySelector<HTMLElement>('a, button')
      firstLink?.focus()
    }
  }, [mobileOpen])

  return (
    <div className="fixed top-0 left-0 right-0 z-50 flex justify-center px-4 pt-4">
      <nav
        aria-label="Main navigation"
        className={cn(
          "w-full max-w-5xl rounded-full transition-all duration-300",
          "bg-zinc-950/80 backdrop-blur-2xl",
          "border shadow-[inset_0_1px_1px_rgba(255,255,255,0.06)]",
          scrolled
            ? "border-white/[0.10] shadow-[inset_0_1px_1px_rgba(255,255,255,0.07),0_8px_32px_rgba(0,0,0,0.4)]"
            : "border-white/[0.06]"
        )}
      >
        <div className="flex h-14 items-center justify-between px-5">
          {/* Logo lockup */}
          <Link href="/" className="flex items-center gap-2.5 group">
            {/* WHY priority: The navbar logo is above the fold and in the
                critical rendering path. `priority` injects a <link rel="preload">
                for the image, eliminating the render-blocking waterfall delay
                that Lighthouse penalises as "image elements do not have explicit
                width and height" / "preload largest contentful paint image". */}
            <Image
              src="/icon-512.png"
              alt="Styrby S mark"
              width={30}
              height={30}
              priority
              className="h-[30px] w-[30px] rounded-md transition-opacity duration-200 group-hover:opacity-80"
            />
            <span className="text-[15px] font-semibold tracking-tight text-foreground">
              Styrby
            </span>
          </Link>

          {/* Desktop nav links */}
          <div className="hidden items-center gap-7 md:flex">
            {[
              { href: "/features", label: "Features" },
              { href: "/pricing", label: "Pricing" },
              { href: "/docs", label: "Docs" },
              { href: "/blog", label: "Blog" },
            ].map(({ href, label }) => (
              <Link
                key={href}
                href={href}
                className={cn(
                  "relative text-sm text-zinc-400 transition-colors duration-200 hover:text-zinc-100",
                  "after:absolute after:-bottom-0.5 after:left-0 after:h-px after:w-0 after:bg-amber-500",
                  "after:transition-[width] after:duration-200 hover:after:w-full"
                )}
              >
                {label}
              </Link>
            ))}
          </div>

          {/* Desktop CTAs */}
          <div className="hidden items-center gap-2.5 md:flex">
            <Button
              variant="ghost"
              asChild
              className="h-8 px-4 text-sm text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.06] rounded-full"
            >
              <Link href="/login">Sign In</Link>
            </Button>
            <Button
              asChild
              className={cn(
                "h-8 px-4 text-sm font-medium rounded-full",
                "bg-amber-500 text-zinc-950 hover:bg-amber-400",
                "shadow-[inset_0_1px_1px_rgba(255,255,255,0.25),0_2px_8px_rgba(245,158,11,0.35)]",
                "transition-all duration-200 hover:shadow-[inset_0_1px_1px_rgba(255,255,255,0.25),0_4px_16px_rgba(245,158,11,0.45)]"
              )}
            >
              <Link href="/signup">Start Free</Link>
            </Button>
          </div>

          {/* Mobile hamburger */}
          <button
            type="button"
            className="text-zinc-400 hover:text-zinc-100 transition-colors md:hidden"
            onClick={() => setMobileOpen(!mobileOpen)}
            aria-label={mobileOpen ? "Close menu" : "Open menu"}
            aria-expanded={mobileOpen}
            aria-controls="mobile-nav-menu"
          >
            {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </nav>

      {/* Mobile menu - drops below the pill */}
      {mobileOpen && (
        <div
          id="mobile-nav-menu"
          ref={mobileMenuRef}
          className={cn(
            "absolute left-4 right-4 top-[72px] rounded-2xl md:hidden",
            "bg-zinc-950/95 backdrop-blur-2xl",
            "border border-white/[0.08]",
            "shadow-[0_16px_48px_rgba(0,0,0,0.5)]",
            "px-5 py-5"
          )}
        >
          <div className="flex flex-col gap-1">
            {[
              { href: "/features", label: "Features" },
              { href: "/pricing", label: "Pricing" },
              { href: "/docs", label: "Docs" },
              { href: "/blog", label: "Blog" },
            ].map(({ href, label }) => (
              <Link
                key={href}
                href={href}
                className="rounded-lg px-3 py-2.5 text-sm text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-100 transition-colors"
                onClick={() => setMobileOpen(false)}
              >
                {label}
              </Link>
            ))}
            <div className="mt-3 flex flex-col gap-2 border-t border-white/[0.06] pt-3">
              <Button
                variant="outline"
                asChild
                className="border-white/[0.10] bg-transparent text-zinc-300 hover:bg-white/[0.06] hover:text-zinc-100 rounded-xl"
              >
                <Link href="/login">Sign In</Link>
              </Button>
              <Button
                asChild
                className={cn(
                  "rounded-xl font-medium",
                  "bg-amber-500 text-zinc-950 hover:bg-amber-400",
                  "shadow-[inset_0_1px_1px_rgba(255,255,255,0.25)]"
                )}
              >
                <Link href="/signup">Start Free</Link>
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
