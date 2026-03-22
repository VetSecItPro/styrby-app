import type { MetadataRoute } from 'next';

/**
 * Generates the robots.txt configuration for search engine and AI crawlers.
 *
 * Rule sets (in order of specificity):
 * 1. AI crawlers: allowed, 10-second crawl delay to limit SSR compute cost
 * 2. SEO scraper bots: fully blocked (no indexing value, high bandwidth cost)
 * 3. All other agents: public marketing pages allowed, private routes blocked
 *
 * WHY crawl-delay for AI crawlers:
 * Aggressive AI crawlers (GPTBot, ClaudeBot, etc.) can issue hundreds of
 * requests per minute. Each request against an uncached Next.js route triggers
 * a full server-side render on Vercel, which has a measurable compute cost.
 * A 10-second crawl delay limits a compliant bot to ~6 requests/minute,
 * allowing indexing while preventing bill spikes. The middleware adds a hard
 * rate limit (60 req/min via Upstash) as a second layer for non-compliant bots.
 *
 * WHY block SEO scrapers (Ahrefs, Semrush, MJ12, DotBot):
 * These bots serve competitive intelligence tools. They do not contribute to
 * search rankings or AI answer engines. They generate substantial traffic with
 * zero benefit to Styrby. The middleware blocks them with 403 in addition to
 * this robots.txt entry (well-behaved scrapers respect robots.txt; the 403 is
 * the fallback for non-compliant ones).
 *
 * @returns The robots.txt configuration object that Next.js serializes
 *          into a standard robots.txt file at build time.
 *
 * @see https://nextjs.org/docs/app/api-reference/file-conventions/metadata/robots
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      // ── AI Crawlers: allowed with crawl delay ──────────────────────────
      // WHY: We want AI answer engines (ChatGPT, Claude, Perplexity) to index
      // Styrby so the product appears in AI-generated recommendations. The
      // crawl-delay asks them to be good citizens. Hard enforcement is in
      // middleware.
      {
        userAgent: 'GPTBot',
        allow: ['/'],
        disallow: ['/dashboard/', '/api/', '/auth/', '/invite/', '/dev/'],
        crawlDelay: 10,
      },
      {
        userAgent: 'ClaudeBot',
        allow: ['/'],
        disallow: ['/dashboard/', '/api/', '/auth/', '/invite/', '/dev/'],
        crawlDelay: 10,
      },
      {
        userAgent: 'CCBot',
        allow: ['/'],
        disallow: ['/dashboard/', '/api/', '/auth/', '/invite/', '/dev/'],
        crawlDelay: 10,
      },
      {
        userAgent: 'PerplexityBot',
        allow: ['/'],
        disallow: ['/dashboard/', '/api/', '/auth/', '/invite/', '/dev/'],
        crawlDelay: 10,
      },
      {
        userAgent: 'Google-Extended',
        allow: ['/'],
        disallow: ['/dashboard/', '/api/', '/auth/', '/invite/', '/dev/'],
        crawlDelay: 10,
      },
      {
        userAgent: 'Bytespider',
        allow: ['/'],
        disallow: ['/dashboard/', '/api/', '/auth/', '/invite/', '/dev/'],
        crawlDelay: 10,
      },

      // ── SEO Scrapers: blocked entirely ────────────────────────────────
      {
        userAgent: 'AhrefsBot',
        disallow: ['/'],
      },
      {
        userAgent: 'SemrushBot',
        disallow: ['/'],
      },
      {
        userAgent: 'MJ12bot',
        disallow: ['/'],
      },
      {
        userAgent: 'DotBot',
        disallow: ['/'],
      },

      // ── All other agents (search engines, humans) ─────────────────────
      // Standard search engines (Googlebot, Bingbot, DuckDuckBot, Yandex)
      // are captured here. They get full access with no crawl delay since
      // they are well-behaved by nature and critical for organic SEO.
      {
        userAgent: '*',
        allow: [
          '/',
          '/features',
          '/pricing',
          '/login',
          '/signup',
          '/blog/',
          '/docs/',
          '/security',
          '/security/compare',
          '/privacy',
          '/terms',
          '/dpa',
        ],
        disallow: [
          '/dashboard/',
          '/api/',
          '/auth/',
          '/invite/',
          '/dev/',
        ],
      },
    ],
    sitemap: 'https://styrbyapp.com/sitemap.xml',
  };
}
