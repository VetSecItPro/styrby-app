import type { Metadata } from "next";
import { Navbar } from "@/components/landing/navbar";
import { Footer } from "@/components/landing/footer";
import { DocsSidebar } from "./docs-sidebar";
import { TableOfContents } from "@/components/docs/TableOfContents";

export const metadata: Metadata = {
  title: "Documentation",
  description:
    "Styrby developer documentation: CLI reference, API docs, agent setup guides, security architecture, and troubleshooting.",
  openGraph: {
    title: "Styrby Documentation",
    description:
      "Styrby developer documentation: CLI reference, API docs, agent setup guides, security architecture, and troubleshooting.",
    type: "website",
    url: "https://styrbyapp.com/docs",
  },
  twitter: {
    card: "summary_large_image",
    title: "Styrby Documentation",
    description:
      "Styrby developer documentation: CLI reference, API docs, agent setup guides, security architecture, and troubleshooting.",
  },
};

/**
 * Layout for all /docs/* pages.
 *
 * Renders the landing Navbar at the top, a persistent sidebar on the left
 * (collapsible on mobile), the doc content in the center, and the Footer
 * at the bottom.
 */
export default function DocsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <Navbar />

      {/* Spacer for the fixed navbar */}
      <div className="h-16" />

      <div className="mx-auto flex w-full max-w-7xl flex-1">
        <DocsSidebar />

        <main
          id="main-content"
          className="min-w-0 flex-1 px-6 py-10 md:px-12 lg:px-16"
        >
          {/* WHY: 3-column grid only at xl+ — TOC right-rail appears once
              there is enough horizontal real estate (>=1280px). Below that,
              the article fills the column and the TOC stays hidden. */}
          <div className="mx-auto flex w-full max-w-5xl gap-10">
            <div className="min-w-0 max-w-3xl flex-1">{children}</div>
            <TableOfContents />
          </div>
        </main>
      </div>

      <Footer />
    </div>
  );
}
