import type { MetadataRoute } from 'next';

/**
 * Generates the robots.txt configuration for search engine crawlers.
 *
 * Allows crawling of all public marketing pages while blocking access to
 * authenticated routes (dashboard, settings, sessions, costs) and API
 * endpoints to prevent indexing of user-specific or internal content.
 *
 * @returns The robots.txt configuration object that Next.js serializes
 *          into a standard robots.txt file at build time.
 *
 * @see https://nextjs.org/docs/app/api-reference/file-conventions/metadata/robots
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/api/', '/dashboard/', '/settings/', '/sessions/', '/costs/'],
      },
    ],
    sitemap: 'https://styrbyapp.com/sitemap.xml',
  };
}
