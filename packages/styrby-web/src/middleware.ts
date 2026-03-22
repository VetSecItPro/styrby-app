/**
 * Next.js Middleware
 *
 * Runs on every matched request to:
 * 1. Detect and gate bot/crawler traffic before spending compute on SSR
 * 2. Refresh Supabase auth session
 * 3. Protect dashboard routes (redirect to login if not authenticated)
 *
 * Bot handling runs first so bad bots never reach auth logic and AI crawlers
 * are rate-limited using Upstash Redis (distributed, works across all Vercel
 * serverless instances).
 */

import { type NextRequest, NextResponse } from 'next/server';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { updateSession } from '@/lib/supabase/middleware';

// ============================================================================
// Bot Classification
// ============================================================================

/**
 * Search engine bots we want fully indexed.
 * Matched generously (allow pass-through, no rate limit).
 */
const SEARCH_ENGINE_PATTERNS: RegExp[] = [
  /Googlebot/i,
  /Bingbot/i,
  /DuckDuckBot/i,
  /Slurp/i, // Yahoo
  /YandexBot/i,
];

/**
 * AI crawlers that provide indexing/answer-engine value.
 * We allow them but enforce a rate limit to control SSR compute costs.
 *
 * Max: 60 requests per minute per User-Agent prefix.
 */
const AI_CRAWLER_PATTERNS: RegExp[] = [
  /GPTBot/i,
  /ClaudeBot/i,
  /CCBot/i,
  /Google-Extended/i,
  /PerplexityBot/i,
  /Bytespider/i,
];

/**
 * SEO scraper bots: high volume, zero indexing value, pure cost.
 * Block immediately with 403.
 */
const BAD_BOT_PATTERNS: RegExp[] = [
  /AhrefsBot/i,
  /SemrushBot/i,
  /MJ12bot/i,
  /DotBot/i,
];

type BotCategory = 'search-engine' | 'ai-crawler' | 'bad-bot' | 'human';

/**
 * Classifies a User-Agent string into one of four categories.
 *
 * IMPORTANT (A-007): This is a COST OPTIMIZATION, not a security control.
 * User-Agent headers are fully attacker-controlled and trivially spoofable.
 * Any client can set UA to bypass bot classification. For actual abuse
 * prevention, rely on IP-based rate limiting (Upstash Redis) and
 * infrastructure-level controls (Vercel firewall / Cloudflare).
 *
 * WHY: We check bad bots first (cheapest rejection), then search engines
 * (cheapest allow), then AI crawlers (rate-limited allow), then humans.
 * This ordering minimizes work per request.
 *
 * @param userAgent - The value of the User-Agent request header
 * @returns The bot category for this User-Agent
 */
function classifyUserAgent(userAgent: string): BotCategory {
  for (const pattern of BAD_BOT_PATTERNS) {
    if (pattern.test(userAgent)) return 'bad-bot';
  }
  for (const pattern of SEARCH_ENGINE_PATTERNS) {
    if (pattern.test(userAgent)) return 'search-engine';
  }
  for (const pattern of AI_CRAWLER_PATTERNS) {
    if (pattern.test(userAgent)) return 'ai-crawler';
  }
  return 'human';
}

// ============================================================================
// AI Crawler Rate Limiter (Upstash Redis)
// ============================================================================

/**
 * WHY Upstash over in-memory Map:
 * The existing rateLimit.ts module documents this clearly. On Vercel's
 * serverless platform, each request can land on a different instance.
 * An in-memory Map is per-instance: a crawler can trivially bypass it by
 * varying which instance it hits. Upstash Redis provides shared state across
 * all instances for a single source of truth.
 *
 * WHY a dedicated limiter here vs. reusing rateLimit.ts:
 * Middleware runs in the Next.js Edge Runtime, not the Node.js runtime. The
 * rateLimit.ts module is designed for Node.js API routes. We create a minimal
 * Ratelimit instance directly here for Edge compatibility.
 *
 * FALLBACK: If UPSTASH_REDIS_REST_URL is absent (local dev, CI), we skip rate
 * limiting for AI crawlers. This is acceptable -- local dev does not face real
 * crawler traffic, and CI only runs test requests.
 */
const isRedisConfigured =
  !!process.env.UPSTASH_REDIS_REST_URL &&
  !!process.env.UPSTASH_REDIS_REST_TOKEN;

/**
 * Sliding-window rate limiter for AI crawlers.
 *
 * Limit: 60 requests per minute per bot identifier.
 * WHY 60/min: This is generous enough for legitimate indexing (one request/sec)
 * while stopping aggressive scraping that causes thousands of SSR renders/hour.
 * Crawl-delay: 10s in robots.txt means a compliant bot hits ~6 req/min.
 * We set the limit at 60 to accommodate a 10x burst without blocking.
 */
const aiCrawlerLimiter = isRedisConfigured
  ? new Ratelimit({
      redis: new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL!,
        token: process.env.UPSTASH_REDIS_REST_TOKEN!,
      }),
      limiter: Ratelimit.slidingWindow(60, '60 s'),
      prefix: 'styrby:bot-ratelimit',
      analytics: false,
    })
  : null;

/**
 * Extracts a stable identifier for a bot from its User-Agent.
 *
 * WHY: We key the rate limit on the bot name rather than IP because crawlers
 * often distribute requests across many IPs. Keying on a normalized bot name
 * (e.g. "GPTBot") limits the logical entity rather than one of its many IPs.
 *
 * @param userAgent - Raw User-Agent header value
 * @returns A short, normalized key for this bot
 */
function extractBotKey(userAgent: string): string {
  for (const pattern of AI_CRAWLER_PATTERNS) {
    const match = userAgent.match(pattern);
    if (match) {
      // Use the matched name (e.g. "GPTBot") lowercased as the rate limit key
      return match[0].toLowerCase();
    }
  }
  return 'unknown-bot';
}

// ============================================================================
// Middleware
// ============================================================================

export async function middleware(request: NextRequest) {
  const userAgent = request.headers.get('user-agent') ?? '';
  const category = classifyUserAgent(userAgent);

  // ── Bad bots: reject immediately ─────────────────────────────────────────
  if (category === 'bad-bot') {
    return new NextResponse('Forbidden', {
      status: 403,
      headers: {
        'Content-Type': 'text/plain',
        // Tell the bot not to revisit this URL
        'X-Robots-Tag': 'noindex',
      },
    });
  }

  // ── AI crawlers: allow but rate-limit ────────────────────────────────────
  if (category === 'ai-crawler' && aiCrawlerLimiter !== null) {
    const botKey = extractBotKey(userAgent);

    try {
      const result = await aiCrawlerLimiter.limit(botKey);

      if (!result.success) {
        // WHY: Return 429 with Retry-After so well-behaved crawlers back off
        // gracefully instead of retrying immediately and compounding the load.
        const retryAfterSeconds = Math.ceil((result.reset - Date.now()) / 1000);

        return new NextResponse('Too Many Requests', {
          status: 429,
          headers: {
            'Content-Type': 'text/plain',
            'Retry-After': String(retryAfterSeconds),
            'X-RateLimit-Limit': '60',
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': String(result.reset),
          },
        });
      }
    } catch {
      // WHY: If Redis is temporarily unreachable, allow the crawler through
      // rather than blocking all crawl traffic. Rate limiting is a cost
      // control measure, not a security gate for AI crawlers.
      // Errors are swallowed here intentionally (edge runtime has no console
      // persistence); monitoring is handled at the Redis/Upstash layer.
    }
  }

  // ── Search engines and humans: pass through to auth logic ────────────────

  // Update Supabase auth session
  const response = await updateSession(request);

  // A-011: Defence-in-depth for admin API routes.
  // WHY: Admin routes perform inline auth checks, but if someone accidentally
  // removes the inline check in a future commit, this middleware gate ensures
  // unauthenticated requests never reach admin logic.
  if (request.nextUrl.pathname.startsWith('/api/admin')) {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
    const projectRef = supabaseUrl.match(/https:\/\/([^.]+)\.supabase\.co/)?.[1] ?? '';
    const adminCookieName = `sb-${projectRef}-auth-token`;
    if (!request.cookies.has(adminCookieName)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  // Protected routes that require authentication
  const protectedPaths = ['/dashboard'];
  const isProtectedPath = protectedPaths.some((path) =>
    request.nextUrl.pathname.startsWith(path)
  );

  if (isProtectedPath) {
    /**
     * Derive the Supabase session cookie name from NEXT_PUBLIC_SUPABASE_URL.
     *
     * WHY: Hardcoding the project ref creates a maintenance hazard -- if the
     * Supabase project changes (e.g., migration to a new instance), the cookie
     * check silently breaks and all protected routes become inaccessible.
     * Deriving it from the environment variable keeps the middleware in sync
     * with whichever Supabase project is configured.
     *
     * Cookie format: `sb-{project_ref}-auth-token`
     * URL format:    `https://{project_ref}.supabase.co`
     */
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
    const projectRef = supabaseUrl.match(/https:\/\/([^.]+)\.supabase\.co/)?.[1] ?? '';
    const cookieName = `sb-${projectRef}-auth-token`;

    // FIX-052: Check both cookie presence AND updateSession result
    // WHY: Cookie presence alone doesn't guarantee the JWT is valid --
    // it could be expired or tampered. updateSession already refreshes
    // the token, but we also check if the response indicates auth failure
    // (e.g., redirect to login means the session refresh failed).
    const hasSession = request.cookies.has(cookieName);
    const isAuthRedirect = response.headers.get('location')?.includes('/login');

    if (!hasSession || isAuthRedirect) {
      // Redirect to login with return URL
      const loginUrl = new URL('/login', request.url);
      loginUrl.searchParams.set('redirect', request.nextUrl.pathname);
      return NextResponse.redirect(loginUrl);
    }
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - public folder
     * - api/webhooks (webhook endpoints don't need auth refresh)
     * - api/cron (cron endpoints use secret-based auth, not session)
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$|api/webhooks|api/cron).*)',
  ],
};
