import type { MetadataRoute } from 'next';
import { blogArticles } from '@/lib/blog-data';

const BASE = 'https://styrbyapp.com';

/**
 * Generates the sitemap.xml for search engine indexing.
 *
 * Priority guide:
 *   1.0  - Homepage, core marketing pages (highest value, change weekly)
 *   0.8  - Features, pricing, security (key conversion pages)
 *   0.7  - Docs index and subpages (ongoing reference value)
 *   0.6  - Blog listing page
 *   0.5  - Individual blog articles, login, signup
 *   0.3  - Legal and compliance pages (yearly changes)
 *
 * Authenticated routes (/dashboard, /api, /auth, /invite) are intentionally
 * excluded because they are blocked in robots.ts and contain no content
 * relevant to search engines.
 *
 * @returns An array of sitemap entries that Next.js serializes into a
 *          standard sitemap.xml file at build time.
 *
 * @see https://nextjs.org/docs/app/api-reference/file-conventions/metadata/sitemap
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();

  /** Core marketing pages */
  const marketingPages: MetadataRoute.Sitemap = [
    {
      url: `${BASE}`,
      lastModified: now,
      changeFrequency: 'weekly',
      priority: 1.0,
    },
    {
      url: `${BASE}/features`,
      lastModified: now,
      changeFrequency: 'weekly',
      priority: 0.8,
    },
    {
      url: `${BASE}/pricing`,
      lastModified: now,
      changeFrequency: 'weekly',
      priority: 0.8,
    },
    {
      url: `${BASE}/security`,
      lastModified: now,
      changeFrequency: 'monthly',
      priority: 0.8,
    },
    {
      url: `${BASE}/security/compare`,
      lastModified: now,
      changeFrequency: 'monthly',
      priority: 0.7,
    },
  ];

  /** Auth pages (publicly accessible, lower priority) */
  const authPages: MetadataRoute.Sitemap = [
    {
      url: `${BASE}/login`,
      lastModified: now,
      changeFrequency: 'monthly',
      priority: 0.5,
    },
    {
      url: `${BASE}/signup`,
      lastModified: now,
      changeFrequency: 'monthly',
      priority: 0.5,
    },
  ];

  /** Documentation pages */
  const docPages: MetadataRoute.Sitemap = [
    {
      url: `${BASE}/docs`,
      lastModified: now,
      changeFrequency: 'monthly',
      priority: 0.7,
    },
    {
      url: `${BASE}/docs/getting-started`,
      lastModified: now,
      changeFrequency: 'monthly',
      priority: 0.7,
    },
    {
      url: `${BASE}/docs/cli`,
      lastModified: now,
      changeFrequency: 'monthly',
      priority: 0.7,
    },
    {
      url: `${BASE}/docs/agents`,
      lastModified: now,
      changeFrequency: 'monthly',
      priority: 0.7,
    },
    {
      url: `${BASE}/docs/mobile`,
      lastModified: now,
      changeFrequency: 'monthly',
      priority: 0.7,
    },
    {
      url: `${BASE}/docs/dashboard`,
      lastModified: now,
      changeFrequency: 'monthly',
      priority: 0.6,
    },
    {
      url: `${BASE}/docs/api`,
      lastModified: now,
      changeFrequency: 'monthly',
      priority: 0.7,
    },
    {
      url: `${BASE}/docs/webhooks`,
      lastModified: now,
      changeFrequency: 'monthly',
      priority: 0.6,
    },
    {
      url: `${BASE}/docs/teams`,
      lastModified: now,
      changeFrequency: 'monthly',
      priority: 0.6,
    },
    {
      url: `${BASE}/docs/security`,
      lastModified: now,
      changeFrequency: 'monthly',
      priority: 0.7,
    },
    {
      url: `${BASE}/docs/troubleshooting`,
      lastModified: now,
      changeFrequency: 'monthly',
      priority: 0.6,
    },
  ];

  /** Blog listing page */
  const blogIndex: MetadataRoute.Sitemap = [
    {
      url: `${BASE}/blog`,
      lastModified: now,
      changeFrequency: 'weekly',
      priority: 0.6,
    },
  ];

  /**
   * Individual blog articles derived from blog-data.ts.
   * lastModified uses the article's publish date for accurate crawl hints.
   */
  const blogArticlePages: MetadataRoute.Sitemap = blogArticles.map((article) => ({
    url: `${BASE}/blog/${article.slug}`,
    lastModified: new Date(article.date),
    changeFrequency: 'monthly' as const,
    priority: 0.5,
  }));

  /** Legal and compliance pages */
  const legalPages: MetadataRoute.Sitemap = [
    {
      url: `${BASE}/privacy`,
      lastModified: now,
      changeFrequency: 'yearly',
      priority: 0.3,
    },
    {
      url: `${BASE}/terms`,
      lastModified: now,
      changeFrequency: 'yearly',
      priority: 0.3,
    },
    {
      url: `${BASE}/dpa`,
      lastModified: now,
      changeFrequency: 'yearly',
      priority: 0.3,
    },
  ];

  return [
    ...marketingPages,
    ...authPages,
    ...docPages,
    ...blogIndex,
    ...blogArticlePages,
    ...legalPages,
  ];
}
