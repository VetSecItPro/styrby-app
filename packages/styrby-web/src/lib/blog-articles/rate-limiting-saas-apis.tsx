/**
 * Article: Rate Limiting Strategies for SaaS APIs
 * Category: technical
 */
export default function RateLimitingSaasApis() {
  return (
    <>
      <p>
        Rate limiting protects your API from abuse, prevents a single user from
        consuming all resources, and keeps your infrastructure costs predictable.
        This article covers the three main algorithms, when to use each, and
        how Styrby implements rate limiting with Upstash Redis.
      </p>

      <h2>Three Algorithms</h2>

      <h3>Fixed Window</h3>
      <p>
        Divide time into fixed intervals (e.g., 1 minute) and count requests
        per interval. When the count exceeds the limit, reject requests until
        the next interval starts.
      </p>
      <pre>
        <code>{`// Fixed window: 100 requests per minute
const key = \`rate:\${userId}:\${Math.floor(Date.now() / 60000)}\`;
const count = await redis.incr(key);
if (count === 1) await redis.expire(key, 60);
if (count > 100) return { status: 429, retryAfter: 60 - (Date.now() % 60000) / 1000 };`}</code>
      </pre>
      <p>
        <strong>Pro:</strong> Simple to implement and understand. Low memory:
        one counter per user per window.
      </p>
      <p>
        <strong>Con:</strong> Burst problem at window boundaries. A user can
        send 100 requests at second 59 of window 1, then 100 more at second 0
        of window 2. That is 200 requests in 2 seconds despite a 100/minute
        limit.
      </p>

      <h3>Sliding Window</h3>
      <p>
        Combines the current window count with a weighted portion of the
        previous window to smooth out boundary bursts:
      </p>
      <pre>
        <code>{`// Sliding window: 100 requests per minute
const currentWindow = Math.floor(Date.now() / 60000);
const previousWindow = currentWindow - 1;
const elapsed = (Date.now() % 60000) / 60000; // 0.0 to 1.0

const currentCount = await redis.get(\`rate:\${userId}:\${currentWindow}\`) || 0;
const previousCount = await redis.get(\`rate:\${userId}:\${previousWindow}\`) || 0;

const weightedCount = previousCount * (1 - elapsed) + currentCount;
if (weightedCount >= 100) return { status: 429 };`}</code>
      </pre>
      <p>
        <strong>Pro:</strong> Eliminates the boundary burst problem. Still uses
        fixed memory per user.
      </p>
      <p>
        <strong>Con:</strong> The weighted count is an approximation, not exact.
        For most applications, the approximation is close enough.
      </p>

      <h3>Token Bucket</h3>
      <p>
        Each user has a bucket that fills with tokens at a steady rate. Each
        request consumes one token. If the bucket is empty, the request is
        rejected. The bucket has a maximum capacity that limits bursts.
      </p>
      <pre>
        <code>{`// Token bucket: 100 tokens/minute, max burst of 20
interface Bucket {
  tokens: number;
  lastRefill: number;
}

function checkRateLimit(bucket: Bucket): { allowed: boolean; bucket: Bucket } {
  const now = Date.now();
  const elapsed = (now - bucket.lastRefill) / 1000;
  const refillRate = 100 / 60; // tokens per second

  // Refill tokens based on elapsed time
  const newTokens = Math.min(
    20, // max burst capacity
    bucket.tokens + elapsed * refillRate
  );

  if (newTokens < 1) {
    return { allowed: false, bucket: { ...bucket, tokens: newTokens } };
  }

  return {
    allowed: true,
    bucket: { tokens: newTokens - 1, lastRefill: now },
  };
}`}</code>
      </pre>
      <p>
        <strong>Pro:</strong> Natural burst handling. Allows short bursts up to
        the bucket capacity while enforcing the average rate.
      </p>
      <p>
        <strong>Con:</strong> Slightly more complex. Requires storing the token
        count and last refill timestamp per user.
      </p>

      <h2>When to Use Each</h2>
      <table>
        <thead>
          <tr>
            <th>Algorithm</th>
            <th>Best For</th>
            <th>Avoid When</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Fixed Window</td>
            <td>Simple APIs, internal services, prototyping</td>
            <td>Boundary bursts would cause problems</td>
          </tr>
          <tr>
            <td>Sliding Window</td>
            <td>Public APIs, SaaS products, general use</td>
            <td>You need exact (not approximate) counting</td>
          </tr>
          <tr>
            <td>Token Bucket</td>
            <td>APIs that should allow controlled bursts</td>
            <td>Simple rate limits suffice</td>
          </tr>
        </tbody>
      </table>

      <h2>Per-Endpoint vs. Per-User Limits</h2>
      <p>
        Styrby uses both:
      </p>
      <ul>
        <li>
          <strong>Per-user global limit:</strong> 1,000 requests per minute
          across all endpoints. Prevents any single user from overwhelming the
          system.
        </li>
        <li>
          <strong>Per-endpoint limits:</strong> Sensitive endpoints have tighter
          limits. The session creation endpoint allows 10 requests per minute.
          The cost data endpoint allows 60 requests per minute.
        </li>
      </ul>
      <p>
        Both limits apply simultaneously. A user might be within their global
        limit but hit the per-endpoint limit on a specific route.
      </p>

      <h2>Implementation with Upstash Redis</h2>
      <p>
        Styrby uses Upstash Redis for rate limiting because it provides a
        serverless Redis instance that works well with Vercel and Supabase Edge
        Functions. The <code>@upstash/ratelimit</code> library handles the
        algorithm implementation:
      </p>
      <pre>
        <code>{`import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_URL!,
  token: process.env.UPSTASH_REDIS_TOKEN!,
});

// Sliding window: 10 session creations per minute
const sessionCreateLimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(10, "1 m"),
  prefix: "ratelimit:session-create",
});

// In the API route handler
export async function POST(request: Request) {
  const userId = getUserId(request);
  const { success, limit, remaining, reset } =
    await sessionCreateLimit.limit(userId);

  if (!success) {
    return Response.json(
      { error: "RATE_LIMITED", message: "Too many requests", retryAfter: reset },
      {
        status: 429,
        headers: {
          "X-RateLimit-Limit": String(limit),
          "X-RateLimit-Remaining": String(remaining),
          "X-RateLimit-Reset": String(reset),
          "Retry-After": String(Math.ceil((reset - Date.now()) / 1000)),
        },
      }
    );
  }

  // Process the request...
}`}</code>
      </pre>

      <h2>Rate Limit Headers</h2>
      <p>
        Always include rate limit information in response headers so clients
        can self-regulate:
      </p>
      <ul>
        <li><code>X-RateLimit-Limit</code>: Maximum requests allowed</li>
        <li><code>X-RateLimit-Remaining</code>: Requests remaining in window</li>
        <li><code>X-RateLimit-Reset</code>: Unix timestamp when the window resets</li>
        <li><code>Retry-After</code>: Seconds until the client should retry (on 429 only)</li>
      </ul>

      <h2>Monitoring and Tuning</h2>
      <p>
        Track how often rate limits fire. If legitimate users regularly hit
        limits, the thresholds are too low. If limits never fire, they might be
        too high to provide protection. Review rate limit metrics monthly and
        adjust based on actual usage patterns.
      </p>
    </>
  );
}
