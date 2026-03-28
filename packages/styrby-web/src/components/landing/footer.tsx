import Link from "next/link"
import Image from "next/image"
import { Shield } from "lucide-react"

/**
 * Footer navigation links — kept minimal to avoid a link farm.
 *
 * WHY only 6 links: More links dilute attention. These six cover the
 * full user journey (explore → convert → legal) without visual noise.
 */
const productLinks = [
  { label: "Pricing", href: "/pricing" },
  { label: "Docs", href: "/docs" },
  { label: "Blog", href: "/blog" },
]

const legalLinks = [
  { label: "Privacy", href: "/privacy" },
  { label: "Terms", href: "/terms" },
]

/**
 * Site footer — minimal, premium, brand-forward.
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
      <div className="mx-auto max-w-7xl px-6 py-16">

        {/* Main row: brand left, links right */}
        <div className="flex flex-col gap-10 md:flex-row md:items-start md:justify-between">

          {/* Brand mark */}
          <div className="flex flex-col gap-4">
            <Link href="/" className="flex items-center gap-2.5 group w-fit">
              <Image
                src="/icon-512.png"
                alt="Styrby logo"
                width={28}
                height={28}
                className="h-7 w-7 rounded-md"
              />
              <span className="text-base font-bold tracking-tight text-foreground group-hover:text-amber-400 transition-colors">
                Styrby
              </span>
            </Link>
            <p className="max-w-xs text-sm leading-relaxed text-muted-foreground">
              Monitor, control, and understand your AI coding agents — from
              your phone.
            </p>
          </div>

          {/* Link columns */}
          <div className="flex gap-16">
            <div>
              <p className="mb-4 text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground/50">
                Product
              </p>
              <ul className="space-y-3">
                {productLinks.map((link) => (
                  <li key={link.label}>
                    <Link
                      href={link.href}
                      className="text-sm text-zinc-400 transition-colors hover:text-zinc-100"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <p className="mb-4 text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground/50">
                Legal
              </p>
              <ul className="space-y-3">
                {legalLinks.map((link) => (
                  <li key={link.label}>
                    <Link
                      href={link.href}
                      className="text-sm text-zinc-400 transition-colors hover:text-zinc-100"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>

        {/* Divider */}
        <div className="mt-12 h-px bg-zinc-800/60" />

        {/* Bottom row: credit and veteran badge */}
        <div className="mt-6 flex flex-wrap items-center justify-between gap-4">
          <p className="text-xs text-zinc-500">
            &copy; 2026 Steel Motion LLC. All rights reserved.
          </p>
          <div className="flex items-center gap-1.5 text-xs text-zinc-500">
            <Shield className="h-3.5 w-3.5 text-amber-500/70" />
            <span>Veteran-Owned Business</span>
          </div>
        </div>
      </div>
    </footer>
  )
}
