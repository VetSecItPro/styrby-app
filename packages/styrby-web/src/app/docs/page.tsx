import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { docsNav } from "./nav";

export const metadata: Metadata = {
  title: "Documentation",
  description:
    "Styrby documentation hub. Get started with the CLI, connect your AI agents, and explore the full API reference.",
};

/**
 * Documentation index page. Lists all doc sections with descriptions.
 */
export default function DocsIndexPage() {
  return (
    <article>
      <h1 className="text-3xl font-bold tracking-tight text-foreground">
        Documentation
      </h1>
      <p className="mt-3 text-lg text-muted-foreground">
        Everything you need to set up Styrby, connect your AI coding agents, and
        control them from anywhere.
      </p>

      <div className="mt-10 grid gap-4 sm:grid-cols-2">
        {docsNav.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="group rounded-lg border border-border bg-card/50 p-5 transition-colors hover:border-amber-500/40 hover:bg-card"
          >
            <h2 className="flex items-center gap-2 text-base font-semibold text-foreground group-hover:text-amber-500 scroll-mt-20" id="section">
              {item.title}
              <ArrowRight className="h-4 w-4 opacity-0 transition-all group-hover:translate-x-1 group-hover:opacity-100" />
            </h2>
            <p className="mt-1.5 text-sm text-muted-foreground/70">{item.description}</p>
          </Link>
        ))}
      </div>
    </article>
  );
}
