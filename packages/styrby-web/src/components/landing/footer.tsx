import Link from "next/link"
import Image from "next/image"
import { Shield } from "lucide-react"

/**
 * Footer navigation links - kept minimal to avoid a link farm.
 *
 * WHY only 6 links: More links dilute attention. These six cover the
 * full user journey (explore → convert → legal) without visual noise.
 */
const allLinks = [
  { label: "Pricing", href: "/pricing" },
  { label: "Docs", href: "/docs" },
  { label: "Blog", href: "/blog" },
  { label: "Privacy", href: "/privacy" },
  { label: "Terms", href: "/terms" },
]

/**
 * Site footer - minimal, premium, brand-forward.
 *
 * Layout: logo + wordmark on the left, two small link columns on the
 * right, legal and credit row at the bottom. Generous padding to give
 * the page a proper landing rather than being crowded by the footer.
 *
 * @returns The site footer element
 */
export function Footer() {
  return (
    <footer className="border-t border-zinc-800/60">
      <div className="mx-auto max-w-7xl px-6 py-6">

        {/* Single row: logo left, links center, credit right */}
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">

          {/* Brand mark */}
          <Link href="/" className="flex items-center gap-2 group shrink-0">
            <Image
              src="/icon-512.png"
              alt="Styrby logo"
              width={22}
              height={22}
              className="h-[22px] w-[22px] rounded-md"
            />
            <span className="text-sm font-bold tracking-tight text-foreground group-hover:text-amber-400 transition-colors">
              Styrby
            </span>
          </Link>

          {/* Nav links - single line with dot dividers */}
          {/* WHY aria-label: Multiple <nav> landmarks exist on pages with a
              navbar. Without a unique label, screen reader users cannot
              distinguish "Main navigation" from "Footer navigation" in the
              landmark list. */}
          <nav aria-label="Footer navigation" className="flex flex-wrap items-center gap-x-1.5 gap-y-2">
            {allLinks.map((link, i) => (
              <span key={link.label} className="flex items-center gap-1.5">
                {i > 0 && (
                  <span className="text-zinc-700" aria-hidden="true">·</span>
                )}
                <Link
                  href={link.href}
                  className="text-xs text-zinc-400 transition-colors hover:text-zinc-100"
                >
                  {link.label}
                </Link>
              </span>
            ))}
          </nav>

          {/* Credit + veteran badge */}
          <div className="flex items-center gap-3 shrink-0 text-xs text-zinc-500">
            <p>&copy; 2026 Steel Motion LLC</p>
            <span className="text-zinc-700" aria-hidden="true">·</span>
            <div className="flex items-center gap-1">
              <Shield className="h-3 w-3 text-amber-500/70" />
              <span>Veteran-Owned</span>
            </div>
          </div>
        </div>
      </div>
    </footer>
  )
}
