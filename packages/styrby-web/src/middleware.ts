/**
 * Next.js Middleware
 *
 * Runs on every matched request to:
 * 1. Resolve the real client IP from CF-Connecting-IP (Cloudflare proxy prep)
 * 2. Detect and gate bot/crawler traffic before spending compute on SSR
 * 3. Refresh Supabase auth session
 * 4. Protect dashboard routes (redirect to login if not authenticated)
 *
 * Bot handling runs first so bad bots never reach auth logic and AI crawlers
 * are rate-limited using Upstash Redis (distributed, works across all Vercel
 * serverless instances).
 */

import { NextRequest, NextResponse } from 'next/server';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { updateSession } from '@/lib/supabase/middleware';

// ============================================================================
// Real Client IP Resolution (Cloudflare Proxy Preparation)
// ============================================================================

/**
 * Resolves the real client IP address from the request.
 *
 * WHY CF-Connecting-IP: When Cloudflare's orange-cloud proxy is enabled on
 * styrbyapp.com, Vercel's serverless functions receive traffic from Cloudflare
 * edge nodes — not directly from end users. Without this header trust, every
 * request would appear to originate from one of Cloudflare's data-centre IPs.
 * The consequences cascade:
 *   - Per-user rate limits break (all users share the same IP bucket)
 *   - Sentry error reports show Cloudflare IPs, not attacker/user IPs
 *   - audit_log forensics lose per-user attribution for abuse investigation
 *   - Geolocation analytics (country/region) become meaningless
 *
 * Per Cloudflare documentation:
 * https://developers.cloudflare.com/fundamentals/reference/http-request-headers/#cf-connecting-ip
 * "CF-Connecting-IP provides the client IP address, i.e. your end user's IP
 * address, connecting to Cloudflare to a website operator's origin web server."
 * Cloudflare guarantees this header is set for every proxied request and that
 * it cannot be spoofed by end users — Cloudflare strips any CF-Connecting-IP
 * header sent by the client and injects its own validated value.
 *
 * WHY trust without an IP allowlist: Vercel's deployment model does not expose
 * a stable set of Cloudflare egress IPs, and the Cloudflare IP ranges
 * (published at https://www.cloudflare.com/ips/) change over time. Vercel
 * Firewall (configured separately) is the correct layer to restrict which
 * traffic reaches the application; middleware is not the right enforcement
 * point for IP-range validation. This matches Cloudflare's own guidance:
 * "If you wish to use CF-Connecting-IP, configure your origin to only accept
 * requests from Cloudflare IP addresses."  We do that at the Vercel Firewall
 * layer, not here.
 *
 * FALLBACK ORDER:
 *   1. CF-Connecting-IP  — set when Cloudflare orange-cloud proxy is active
 *   2. x-forwarded-for   — set by Vercel / other reverse proxies (first hop)
 *   3. x-real-ip         — set by some proxy configurations
 *   4. 'unknown'         — safe fallback; callers must handle this gracefully
 *
 * @param request - The incoming Next.js request
 * @returns The best-available real client IP address string
 */
export function resolveClientIp(request: NextRequest): string {
  // Priority 1: Cloudflare's CF-Connecting-IP header (most authoritative when
  // orange-cloud proxy is enabled — Cloudflare validates this value itself).
  const cfConnectingIp = request.headers.get('cf-connecting-ip');
  if (cfConnectingIp) {
    return cfConnectingIp.trim();
  }

  // Priority 2: x-forwarded-for — the standard proxy chain header.
  // WHY first value only: x-forwarded-for can contain a comma-separated list
  // of IPs accumulated through each hop (client → proxy1 → proxy2 → origin).
  // The first (leftmost) value is the original client IP. Later values are
  // trusted proxy IPs that are less useful for client attribution.
  const xForwardedFor = request.headers.get('x-forwarded-for');
  if (xForwardedFor) {
    const firstIp = xForwardedFor.split(',')[0]?.trim();
    if (firstIp) return firstIp;
  }

  // Priority 3: x-real-ip — set by nginx and some Vercel configurations.
  const xRealIp = request.headers.get('x-real-ip');
  if (xRealIp) {
    return xRealIp.trim();
  }

  // Fallback: no IP could be determined. Callers (rate limiters, audit log)
  // should treat 'unknown' as a valid bucket key rather than throwing.
  return 'unknown';
}

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
  // ── Resolve real client IP (CF-Connecting-IP → x-forwarded-for fallback) ──
  //
  // WHY here at the top of middleware: every downstream consumer (bot rate
  // limiter, Sentry error context, audit-log) needs the real client IP.
  // Resolving once at the middleware entry point is cheaper than each consumer
  // re-deriving it independently, and ensures all consumers agree on the same
  // value for a given request.
  //
  // The resolved IP is forwarded on the request headers as 'x-real-client-ip'
  // so Next.js API route handlers and Server Components can read it via
  // request.headers.get('x-real-client-ip') without needing to import this
  // middleware's resolution logic.
  const clientIp = resolveClientIp(request);

  // WHY we propagate via requestHeaders mutation (not new NextRequest()):
  // NextRequest headers are read-only at runtime, but Next.js provides the
  // headers() function that allows middleware to inject request headers that
  // downstream handlers receive. We use the NextResponse.next() headers
  // mechanism at the bottom to attach x-real-client-ip so API routes and
  // Server Components can read it via headers().get('x-real-client-ip').
  //
  // We intentionally DO NOT construct a new NextRequest here: the NextRequest
  // constructor in the test/Edge runtime rejects a RequestInit whose signal
  // field is an AbortSignal instance from a different realm (JSDOM vs. Edge),
  // causing "Expected signal to be an instance of AbortSignal" test failures.
  // Passing the resolved IP via the response's `x-middleware-request-*` header
  // is the correct Next.js-endorsed pattern for injecting request headers from
  // middleware without cloning the entire NextRequest object.
  //
  // All downstream consumers should read the real client IP from:
  //   request.headers.get('x-real-client-ip')    (Server Components / API routes)
  // The header is set by the NextResponse.next() call at the end of this function.

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
  //
  // SEC-AUTH-001 FIX: The previous check only tested cookie *presence*, which
  // is trivially bypassable - an attacker can send a request with an empty or
  // expired cookie and the gate would pass. We now validate that the Supabase
  // session is actually authenticated by checking whether updateSession()
  // redirected to login (which it does when the JWT is invalid/expired).
  // Cookie presence is still checked first as a fast path, but validity is
  // confirmed via the session update result.
  if (request.nextUrl.pathname.startsWith('/api/admin')) {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
    const projectRef = supabaseUrl.match(/https:\/\/([^.]+)\.supabase\.co/)?.[1] ?? '';
    const adminCookieName = `sb-${projectRef}-auth-token`;

    // Fast path: if no cookie at all, reject immediately
    if (!request.cookies.has(adminCookieName)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Deeper check: updateSession() will clear/redirect if the JWT is expired
    // or tampered. A redirect to /login means the session is invalid.
    const isInvalidSession = response.headers.get('location')?.includes('/login');
    if (isInvalidSession) {
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

  // Propagate the resolved client IP to downstream request handlers.
  //
  // WHY: Next.js middleware can inject request headers by setting them on the
  // response with the 'x-middleware-request-{header-name}' prefix. The Next.js
  // runtime strips the prefix and adds the header to the incoming request that
  // reaches Server Components and API routes. This is the official pattern
  // documented in the Next.js middleware headers guide.
  //
  // After this, any Server Component or API route can read the real client IP:
  //   import { headers } from 'next/headers';
  //   const ip = (await headers()).get('x-real-client-ip');
  //
  // This powers:
  //   - Sentry error context (real user IP in breadcrumbs)
  //   - Rate-limit buckets (per-user IP keys instead of Cloudflare edge IPs)
  //   - audit_log entries (correct IP attribution for forensics)
  response.headers.set('x-middleware-request-x-real-client-ip', clientIp);

  // ── Replay token path redaction ────────────────────────────────────────────
  // WHY: The raw replay token sits in /replay/<96-char-hex>. If Next.js logs
  // request paths (e.g. in Vercel's function logs), the token appears in logs
  // where it could be captured by log aggregation tools or monitoring services.
  // We set an X-Replay-Redacted header to signal to logging infrastructure that
  // this path contains a credential and should be masked before persisting.
  //
  // NOTE: Next.js does not expose a built-in path-redaction hook. The correct
  // defense is ensuring logs are treated as sensitive when the path matches
  // /replay/. This header is consumed by Sentry (beforeSend in instrumentation.ts)
  // and any future log middleware to redact the path segment.
  //
  // The raw token is NEVER logged server-side by our own code — this header
  // is a belt-and-suspenders guard for third-party log capture.
  if (request.nextUrl.pathname.startsWith('/replay/')) {
    response.headers.set('x-replay-token-path', 'redacted');
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
