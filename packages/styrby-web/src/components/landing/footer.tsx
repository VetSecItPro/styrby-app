import Link from "next/link"

const links = [
  { label: "Features", href: "/#features" },
  { label: "Pricing", href: "/pricing" },
  { label: "Docs", href: "#" },
  { label: "Blog", href: "#" },
  { label: "Privacy", href: "#" },
  { label: "Terms", href: "#" },
  { label: "GitHub", href: "#" },
  { label: "Twitter/X", href: "#" },
  { label: "Discord", href: "#" },
]

export function Footer() {
  return (
    <footer className="border-t border-border/40 py-6">
      <div className="mx-auto max-w-7xl px-6 text-center">
        <nav className="flex flex-wrap items-center justify-center gap-x-1 gap-y-2">
          {links.map((link, i) => (
            <span key={link.label} className="flex items-center gap-1">
              {i > 0 && (
                <span className="text-zinc-600" aria-hidden="true">
                  &middot;
                </span>
              )}
              <Link
                href={link.href}
                className="text-sm text-zinc-500 transition-colors hover:text-zinc-300"
              >
                {link.label}
              </Link>
            </span>
          ))}
        </nav>
        <p className="mt-3 text-sm text-zinc-500">
          &copy; 2026 Steel Motion LLC
        </p>
      </div>
    </footer>
  )
}
