"use client";

import { useEffect, useState } from "react";

/**
 * One entry in the right-rail Table of Contents.
 */
export interface TocItem {
  /** The DOM `id` attribute on the heading the entry links to */
  id: string;
  /** Human-readable heading text */
  text: string;
  /** Heading depth (2 = h2, 3 = h3). h3s render indented. */
  depth: 2 | 3;
}

/**
 * TableOfContents — sticky right-rail navigation for long docs pages.
 *
 * Reads h2/h3 elements from the article container after mount, then uses an
 * IntersectionObserver to highlight the currently in-view heading. Renders
 * only at `xl:` viewports (>=1280px); collapses to nothing below.
 *
 * WHY client component: IntersectionObserver and DOM queries against rendered
 * content are browser-only. The headings themselves remain server-rendered
 * for SEO and deep-link integrity; this component is purely decorative.
 *
 * @param containerSelector - CSS selector that scopes the heading scan.
 *   Defaults to `article`, which matches the docs page wrapper.
 */
export function TableOfContents({
  containerSelector = "article",
}: {
  containerSelector?: string;
}) {
  const [items, setItems] = useState<TocItem[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  // Collect headings from the article on mount. We do this after render so
  // the server-rendered DOM is the source of truth - no duplication of
  // heading text in the page TSX.
  //
  // WHY rAF: react-hooks/set-state-in-effect flags synchronous setState in
  // an effect because it can cascade renders. Deferring to the next frame
  // makes the update asynchronous from React's perspective and matches
  // browser paint timing (the headings exist as soon as the page renders).
  useEffect(() => {
    let cancelled = false;
    const id = requestAnimationFrame(() => {
      if (cancelled) return;
      const root = document.querySelector(containerSelector);
      if (!root) return;
      const headings = Array.from(
        root.querySelectorAll<HTMLHeadingElement>("h2[id], h3[id]")
      );
      const next: TocItem[] = headings.map((h) => ({
        id: h.id,
        text: h.textContent?.trim() ?? h.id,
        depth: (h.tagName === "H2" ? 2 : 3) as 2 | 3,
      }));
      setItems(next);
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(id);
    };
  }, [containerSelector]);

  // Highlight the heading nearest the top of the viewport. Threshold tuned
  // so the active marker advances as the heading crosses the upper third
  // of the screen, which feels natural while scrolling.
  useEffect(() => {
    if (items.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible.length > 0) {
          setActiveId(visible[0].target.id);
        }
      },
      { rootMargin: "-80px 0px -66% 0px", threshold: 0 }
    );
    for (const item of items) {
      const el = document.getElementById(item.id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [items]);

  if (items.length === 0) return null;

  return (
    <nav
      aria-label="Table of contents"
      className="hidden xl:sticky xl:top-24 xl:block xl:h-[calc(100vh-6rem)] xl:w-56 xl:shrink-0 xl:overflow-y-auto xl:pl-6"
    >
      <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        On this page
      </p>
      <ul className="space-y-1.5 text-sm">
        {items.map((item) => (
          <li
            key={item.id}
            className={item.depth === 3 ? "pl-3" : undefined}
          >
            <a
              href={`#${item.id}`}
              className={
                "block border-l-2 py-1 pl-3 transition-colors " +
                (activeId === item.id
                  ? "border-amber-500 text-foreground"
                  : "border-transparent text-muted-foreground hover:border-border hover:text-foreground/90")
              }
            >
              {item.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
