/**
 * Tests for lib/blog-data.ts
 *
 * WHY: blog-data.ts is the authoritative registry for article metadata. Bugs
 * here (duplicate slugs, missing required fields, wrong category assignments)
 * cause broken links and empty blog pages that aren't caught until users see 404s.
 * These tests act as a schema regression check for the article list.
 */

import { describe, it, expect } from 'vitest';
import {
  blogArticles,
  getArticleBySlug,
  getCategories,
  categoryLabels,
  categoryColors,
  type BlogCategory,
} from '../blog-data';

// ============================================================================
// blogArticles registry
// ============================================================================

describe('blogArticles', () => {
  it('contains at least one article', () => {
    expect(blogArticles.length).toBeGreaterThan(0);
  });

  it('every article has the required fields', () => {
    for (const article of blogArticles) {
      expect(article.slug, `slug missing on: ${JSON.stringify(article)}`).toBeTruthy();
      expect(article.title).toBeTruthy();
      expect(article.date).toBeTruthy();
      expect(article.category).toBeTruthy();
      expect(article.description).toBeTruthy();
      expect(article.readTime).toBeGreaterThan(0);
    }
  });

  it('slug values contain only URL-safe characters', () => {
    for (const article of blogArticles) {
      expect(article.slug).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it('has no duplicate slugs', () => {
    const slugs = blogArticles.map((a) => a.slug);
    const unique = new Set(slugs);
    expect(unique.size).toBe(slugs.length);
  });

  it('date values are in YYYY-MM-DD format', () => {
    const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
    for (const article of blogArticles) {
      expect(article.date, `Invalid date on "${article.slug}"`).toMatch(ISO_DATE);
    }
  });

  it('every category is a valid BlogCategory', () => {
    const valid: BlogCategory[] = ['comparison', 'deep-dive', 'use-case', 'technical', 'company'];
    for (const article of blogArticles) {
      expect(valid).toContain(article.category);
    }
  });

  it('readTime is a positive integer', () => {
    for (const article of blogArticles) {
      expect(Number.isInteger(article.readTime)).toBe(true);
      expect(article.readTime).toBeGreaterThan(0);
    }
  });
});

// ============================================================================
// getArticleBySlug
// ============================================================================

describe('getArticleBySlug', () => {
  it('returns the correct article for a known slug', () => {
    const firstSlug = blogArticles[0].slug;
    const found = getArticleBySlug(firstSlug);
    expect(found).toBeDefined();
    expect(found!.slug).toBe(firstSlug);
  });

  it('returns undefined for an unknown slug', () => {
    expect(getArticleBySlug('does-not-exist-xyz')).toBeUndefined();
  });

  it('returns undefined for an empty string', () => {
    expect(getArticleBySlug('')).toBeUndefined();
  });

  it('is case-sensitive (slug must be exact match)', () => {
    const slug = blogArticles[0].slug;
    expect(getArticleBySlug(slug.toUpperCase())).toBeUndefined();
  });
});

// ============================================================================
// getCategories
// ============================================================================

describe('getCategories', () => {
  it('returns only categories that have at least one article', () => {
    const usedCategories = new Set(blogArticles.map((a) => a.category));
    const returned = getCategories();
    for (const cat of returned) {
      expect(usedCategories.has(cat)).toBe(true);
    }
  });

  it('returns each used category exactly once', () => {
    const categories = getCategories();
    const unique = new Set(categories);
    expect(unique.size).toBe(categories.length);
  });

  it('returns categories in the defined display order', () => {
    const order: BlogCategory[] = ['comparison', 'deep-dive', 'use-case', 'technical', 'company'];
    const returned = getCategories();

    // The returned list must be a subsequence of the display order
    let orderIdx = 0;
    for (const cat of returned) {
      const found = order.indexOf(cat, orderIdx);
      expect(found).toBeGreaterThanOrEqual(orderIdx);
      orderIdx = found + 1;
    }
  });
});

// ============================================================================
// categoryLabels and categoryColors
// ============================================================================

describe('categoryLabels', () => {
  it('has a label for every valid category', () => {
    const categories: BlogCategory[] = ['comparison', 'deep-dive', 'use-case', 'technical', 'company'];
    for (const cat of categories) {
      expect(categoryLabels[cat]).toBeTruthy();
    }
  });
});

describe('categoryColors', () => {
  it('has a color class for every valid category', () => {
    const categories: BlogCategory[] = ['comparison', 'deep-dive', 'use-case', 'technical', 'company'];
    for (const cat of categories) {
      expect(categoryColors[cat]).toBeTruthy();
    }
  });
});
