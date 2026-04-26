"use client";

import { useState } from "react";
import Link from "next/link";
import {
  blogArticles,
  getCategories,
  categoryLabels,
  categoryColors,
  type BlogCategory,
} from "@/lib/blog-data";
import { cn } from "@/lib/utils";

/**
 * Blog listing page.
 *
 * Displays all articles as cards in a responsive grid with category
 * filtering. Articles are pre-sorted by date descending in blog-data.ts.
 */
export default function BlogPage() {
  const [activeCategory, setActiveCategory] = useState<BlogCategory | null>(
    null
  );
  const categories = getCategories();

  const filtered = activeCategory
    ? blogArticles.filter((a) => a.category === activeCategory)
    : blogArticles;

  return (
    <div className="mx-auto max-w-7xl px-6">
      {/* Header */}
      <div className="mb-12">
        <h1 className="text-4xl font-bold tracking-tight text-foreground sm:text-5xl">
          Blog
        </h1>
        <p className="mt-4 text-lg text-muted-foreground">
          Technical articles on AI agent management, cost tracking, encryption,
          and building developer tools.
        </p>
      </div>

      {/* Category filters */}
      <div className="mb-8 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setActiveCategory(null)}
          className={cn(
            "rounded-full border px-4 py-1.5 text-sm font-medium transition-colors",
            activeCategory === null
              ? "border-amber-500/40 bg-amber-500/10 text-amber-400"
              : "border-border bg-transparent text-muted-foreground hover:text-foreground"
          )}
        >
          All
        </button>
        {categories.map((cat) => (
          <button
            key={cat}
            type="button"
            onClick={() =>
              setActiveCategory(activeCategory === cat ? null : cat)
            }
            className={cn(
              "rounded-full border px-4 py-1.5 text-sm font-medium transition-colors",
              activeCategory === cat
                ? categoryColors[cat]
                : "border-border bg-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {categoryLabels[cat]}
          </button>
        ))}
      </div>

      {/* Article grid */}
      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {filtered.map((article) => (
          <Link
            key={article.slug}
            href={`/blog/${article.slug}`}
            className="group rounded-xl border border-border/50 bg-card/50 p-6 transition-all hover:border-border hover:bg-card"
          >
            <div className="mb-3 flex items-center gap-3">
              <span
                className={cn(
                  "rounded-full border px-2.5 py-0.5 text-xs font-medium",
                  categoryColors[article.category]
                )}
              >
                {categoryLabels[article.category]}
              </span>
              <span className="text-xs text-muted-foreground">
                {article.readTime} min read
              </span>
            </div>
            <h2 className="text-balance mb-2 text-lg font-semibold text-foreground group-hover:text-amber-400 transition-colors">
              {article.title}
            </h2>
            <p className="mb-4 text-sm text-muted-foreground leading-relaxed">
              {article.description}
            </p>
            <time
              dateTime={article.date}
              className="text-xs text-muted-foreground tabular-nums"
            >
              {new Date(article.date).toLocaleDateString("en-US", {
                year: "numeric",
                month: "long",
                day: "numeric",
              })}
            </time>
          </Link>
        ))}
      </div>
    </div>
  );
}
