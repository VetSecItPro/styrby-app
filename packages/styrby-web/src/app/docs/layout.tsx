import type { Metadata } from "next";
import { Navbar } from "@/components/landing/navbar";
import { Footer } from "@/components/landing/footer";
import { DocsSidebar } from "./docs-sidebar";

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
    <div className="flex min-h-screen flex-col bg-zinc-950 text-zinc-100">
      <Navbar />

      {/* Spacer for the fixed navbar */}
      <div className="h-16" />

      <div className="mx-auto flex w-full max-w-7xl flex-1">
        <DocsSidebar />

        <main
          id="main-content"
          className="min-w-0 flex-1 px-6 py-10 md:px-12 lg:px-16"
        >
          <div className="mx-auto max-w-3xl">{children}</div>
        </main>
      </div>

      <Footer />
    </div>
  );
}
