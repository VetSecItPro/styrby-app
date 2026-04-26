"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { docsNav } from "./nav";

/**
 * Sidebar navigation for the documentation section.
 *
 * Persistent on desktop (>=768px). On mobile, toggled via a hamburger button
 * fixed to the bottom-right corner of the viewport.
 */
export function DocsSidebar() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  return (
    <>
      {/* Mobile toggle button */}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="fixed bottom-6 right-6 z-50 flex h-12 w-12 items-center justify-center rounded-full bg-secondary text-foreground/75 shadow-lg ring-1 ring-border md:hidden"
        aria-label={open ? "Close docs menu" : "Open docs menu"}
        aria-expanded={open}
      >
        {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
      </button>

      {/* Backdrop for mobile */}
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/60 md:hidden"
          onClick={() => setOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Sidebar */}
      <aside
        className={cn(
          "fixed top-16 z-40 h-[calc(100vh-4rem)] w-60 shrink-0 overflow-y-auto border-r border-border bg-background px-4 py-6 transition-transform duration-200 md:sticky md:translate-x-0",
          open ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <nav aria-label="Documentation">
          <ul className="space-y-1">
            {docsNav.map((item) => {
              const active = pathname === item.href;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={() => setOpen(false)}
                    className={cn(
                      "block rounded-md px-3 py-2 text-sm transition-colors",
                      active
                        ? "bg-amber-500/10 font-medium text-amber-500"
                        : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground/90"
                    )}
                    aria-current={active ? "page" : undefined}
                  >
                    {item.title}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </aside>
    </>
  );
}
