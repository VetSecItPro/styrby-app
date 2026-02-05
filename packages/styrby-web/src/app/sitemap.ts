import type { MetadataRoute } from 'next';

/**
 * Generates the sitemap.xml for search engine indexing.
 *
 * Lists all publicly accessible pages with their relative priorities
 * and update frequencies. Authenticated routes (dashboard, settings, etc.)
 * are intentionally excluded since they are blocked in robots.ts and
 * contain no content relevant to search engines.
 *
 * @returns An array of sitemap entries that Next.js serializes into a
 *          standard sitemap.xml file at build time.
 *
 * @see https://nextjs.org/docs/app/api-reference/file-conventions/metadata/sitemap
 */
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: 'https://styrbyapp.com',
      lastModified: new Date(),
      changeFrequency: 'weekly',
      priority: 1,
    },
    {
      url: 'https://styrbyapp.com/login',
      lastModified: new Date(),
      changeFrequency: 'monthly',
      priority: 0.5,
    },
    {
      url: 'https://styrbyapp.com/privacy',
      lastModified: new Date(),
      changeFrequency: 'monthly',
      priority: 0.3,
    },
    {
      url: 'https://styrbyapp.com/terms',
      lastModified: new Date(),
      changeFrequency: 'monthly',
      priority: 0.3,
    },
  ];
}
