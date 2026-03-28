import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import {
  blogArticles,
  getArticleBySlug,
  categoryLabels,
  categoryColors,
} from "@/lib/blog-data";
import { cn } from "@/lib/utils";
import { blogContent } from "@/lib/blog-articles";

/**
 * Generates static params for all blog articles at build time.
 *
 * @returns Array of slug params for generateStaticParams
 */
export function generateStaticParams() {
  return blogArticles.map((article) => ({
    slug: article.slug,
  }));
}

/**
 * Generates metadata for individual blog posts.
 *
 * @param params - Route params containing the article slug
 * @returns Metadata object with title and description for SEO
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const article = getArticleBySlug(slug);
  if (!article) return {};

  return {
    title: article.title,
    description: article.description,
    openGraph: {
      title: article.title,
      description: article.description,
      type: "article",
      publishedTime: article.date,
    },
  };
}

/**
 * Builds Article JSON-LD structured data for a blog post.
 *
 * WHY: Google uses Article schema to understand author, publication date, and
 * content type. This enables rich results (article cards, date badges) in
 * search and helps AI answer engines correctly attribute quotes and facts to
 * Styrby as the source rather than a scraped third party.
 *
 * WHY dateModified === datePublished:
 * The blog-data module stores only a single date per article. We use the same
 * value for both fields rather than leaving dateModified empty, which would
 * cause Google's structured data validator to warn about a missing recommended
 * field.
 *
 * @param title - Article headline
 * @param description - Article description / lead text
 * @param date - ISO 8601 publication date (YYYY-MM-DD)
 * @param slug - URL slug used to build the canonical URL
 * @returns Plain object safe to serialize with JSON.stringify
 */
function buildArticleJsonLd(
  title: string,
  description: string,
  date: string,
  slug: string
) {
  return {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: title,
    description: description,
    datePublished: date,
    dateModified: date,
    url: `https://styrbyapp.com/blog/${slug}`,
    author: {
      "@type": "Organization",
      name: "Steel Motion LLC",
      url: "https://styrbyapp.com",
    },
    publisher: {
      "@type": "Organization",
      name: "Styrby",
      url: "https://styrbyapp.com",
      logo: {
        "@type": "ImageObject",
        url: "https://styrbyapp.com/icon-192.png",
      },
    },
    image: "https://styrbyapp.com/logo-full.png",
    mainEntityOfPage: {
      "@type": "WebPage",
      "@id": `https://styrbyapp.com/blog/${slug}`,
    },
  };
}

/**
 * Individual blog post page.
 *
 * Renders article content from the blog-articles module with consistent
 * typography and layout. Falls back to notFound() for invalid slugs.
 */
export default async function BlogPostPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const article = getArticleBySlug(slug);
  if (!article) notFound();

  const Content = blogContent[slug];
  if (!Content) notFound();

  const articleJsonLd = buildArticleJsonLd(
    article.title,
    article.description,
    article.date,
    slug
  );

  return (
    <article className="mx-auto max-w-3xl px-6">
      {/* JSON-LD: Article schema for search rich results and AI attribution.
          Safe: JSON.stringify escapes all HTML. This is the standard Next.js
          pattern for injecting structured data. */}
      {/* nosemgrep: typescript.react.security.audit.react-dangerouslysetinnerhtml */}
      <script
        type="application/ld+json"
        // nosemgrep: typescript.react.security.audit.react-dangerouslysetinnerhtml
        dangerouslySetInnerHTML={{ __html: JSON.stringify(articleJsonLd) }}
      />

      {/* Back link */}
      <Link
        href="/blog"
        className="mb-8 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to Blog
      </Link>

      {/* Article header */}
      <header className="mb-10">
        <div className="mb-4 flex items-center gap-3">
          <span
            className={cn(
              "rounded-full border px-2.5 py-0.5 text-xs font-medium",
              categoryColors[article.category]
            )}
          >
            {categoryLabels[article.category]}
          </span>
          <span className="text-sm text-muted-foreground">
            {article.readTime} min read
          </span>
        </div>
        <h1 className="text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
          {article.title}
        </h1>
        <time
          dateTime={article.date}
          className="mt-4 block text-sm text-muted-foreground"
        >
          {new Date(article.date).toLocaleDateString("en-US", {
            year: "numeric",
            month: "long",
            day: "numeric",
          })}
        </time>
      </header>

      {/* Article body */}
      <div className="prose prose-invert prose-zinc max-w-none prose-headings:font-semibold prose-headings:tracking-tight prose-h2:text-2xl prose-h2:mt-10 prose-h2:mb-4 prose-h3:text-xl prose-h3:mt-8 prose-h3:mb-3 prose-p:text-muted-foreground prose-p:leading-relaxed prose-a:text-amber-400 prose-a:no-underline hover:prose-a:underline prose-strong:text-foreground prose-code:text-amber-400 prose-code:before:content-none prose-code:after:content-none prose-pre:bg-zinc-900 prose-pre:border prose-pre:border-border/50 prose-li:text-muted-foreground prose-table:text-sm prose-th:text-foreground prose-td:text-muted-foreground prose-th:border-border prose-td:border-border prose-thead:border-border">
        <Content />
      </div>

      {/* Footer CTA */}
      <div className="mt-16 rounded-xl border border-border/50 bg-card/50 p-8 text-center">
        <h2 className="text-xl font-semibold text-foreground">
          Ready to manage your AI agents from one place?
        </h2>
        <p className="mt-2 text-muted-foreground">
          Styrby gives you cost tracking, remote permissions, and session replay
          across 11 CLI coding agents.
        </p>
        <div className="mt-6 flex justify-center gap-4">
          <Link
            href="/signup"
            className="rounded-lg bg-amber-500 px-6 py-2.5 text-sm font-medium text-background transition-colors hover:bg-amber-600"
          >
            Start Free
          </Link>
          <Link
            href="/pricing"
            className="rounded-lg border border-border px-6 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            View Pricing
          </Link>
        </div>
      </div>
    </article>
  );
}
