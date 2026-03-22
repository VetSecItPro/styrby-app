import Link from "next/link"
import Image from "next/image"
import { Shield } from "lucide-react"

const links = [
  { label: "Pricing", href: "/pricing" },
  { label: "Docs", href: "/docs" },
  { label: "Blog", href: "/blog" },
  { label: "Privacy", href: "/privacy" },
  { label: "Terms", href: "/terms" },
]

export function Footer() {
  return (
    <footer className="border-t border-border/40 py-4">
      <div className="mx-auto max-w-7xl px-6">
        {/* Logo left, nav links centered, on the same line */}
        <div className="relative flex items-center">
          {/* Logo — left-aligned, taken out of flow so nav can center freely */}
          <Link href="/" className="flex shrink-0 items-center gap-2 md:absolute md:left-0">
            <Image
              src="/logo.png"
              alt="Styrby"
              width={20}
              height={20}
              className="h-5 w-5"
            />
            <span className="text-sm font-bold text-foreground">Styrby</span>
          </Link>

          {/* Nav links — centered in the full width */}
          <nav aria-label="Footer" className="hidden flex-1 flex-wrap items-center justify-center gap-x-4 gap-y-1 md:flex">
            {links.map((link) => (
              <Link
                key={link.label}
                href={link.href}
                className="text-xs text-zinc-500 transition-colors hover:text-zinc-300"
              >
                {link.label}
              </Link>
            ))}
          </nav>
        </div>

        {/* Mobile nav links — stacked below logo */}
        <nav aria-label="Footer mobile" className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 md:hidden">
          {links.map((link) => (
            <Link
              key={link.label}
              href={link.href}
              className="text-xs text-zinc-500 transition-colors hover:text-zinc-300"
            >
              {link.label}
            </Link>
          ))}
        </nav>

        {/* Copyright row — centered */}
        <div className="mt-3 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs text-zinc-500">
          <p>&copy; 2026 Steel Motion LLC</p>
          <div className="flex items-center gap-1">
            <Shield className="h-3 w-3 text-amber-500" />
            <span>Veteran-Owned Business</span>
          </div>
        </div>
      </div>
    </footer>
  )
}
