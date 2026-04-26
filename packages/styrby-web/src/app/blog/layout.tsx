import type { Metadata } from "next";
import { Navbar } from "@/components/landing/navbar";
import { Footer } from "@/components/landing/footer";

export const metadata: Metadata = {
  title: "Blog",
  description:
    "Technical articles on AI agent management, cost tracking, encryption, and developer tools for AI coding workflows.",
  openGraph: {
    title: "Styrby Blog",
    description:
      "Technical articles on AI agent management, cost tracking, encryption, and developer tools for AI coding workflows.",
    type: "website",
    url: "https://styrbyapp.com/blog",
  },
  twitter: {
    card: "summary_large_image",
    title: "Styrby Blog",
    description:
      "Technical articles on AI agent management, cost tracking, encryption, and developer tools for AI coding workflows.",
  },
};

/**
 * Blog section layout.
 *
 * Uses the landing page Navbar and Footer to keep the blog visually
 * consistent with the marketing site. Content is centered at max-w-7xl
 * for the listing page; individual posts use max-w-3xl internally.
 */
export default function BlogLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <Navbar />
      <main id="main-content" className="min-h-[100dvh] pt-24 pb-16">
        {children}
      </main>
      <Footer />
    </>
  );
}
