/**
 * Sentry server-side initialization (Node.js runtime).
 *
 * This file is loaded by the `src/instrumentation.ts` hook on the Node.js
 * server runtime. It captures errors from:
 * - Server Components (RSC rendering errors)
 * - Route Handlers (API routes)
 * - Server Actions
 * - Middleware (Node.js runtime only — edge middleware uses sentry.edge.config.ts)
 *
 * WHY tracesSampleRate is 0.1:
 * 10% sampling captures enough server-side timing data to identify slow
 * database queries, Supabase latency, and Edge Function cold starts without
 * exhausting Sentry's transaction quota.
 *
 * WHY enabled is gated on NODE_ENV === 'production':
 * Local development errors surface in the terminal. Sending them to Sentry
 * would create noise and consume quota for non-production issues.
 */
import * as Sentry from '@sentry/nextjs';

/**
 * STYRBY_SENTRY_MUTED — emergency kill switch for the server runtime.
 * Set to 'true' in Vercel env vars + redeploy to silence the SDK without
 * a code change when notifications are spamming the founder inbox.
 */
const isMuted = process.env.STYRBY_SENTRY_MUTED === 'true';

/**
 * Server-side noise filter — matches high-volume benign errors (bot scans,
 * aborted requests, upstream timeouts Sentry would alert on even though the
 * user-facing retry handles them).
 */
const NOISE_PATTERNS: readonly RegExp[] = [
  /ECONNRESET/i,
  /The operation was aborted/i,
  /Request aborted/i,
  /socket hang up/i,
  /ETIMEDOUT/i,
];

Sentry.init({
  /**
   * SENTRY_DSN — Server-only Data Source Name that routes server-side errors to Sentry.
   *
   * Source: sentry.io > Project Settings > Client Keys (DSN)
   * Format: "https://<key>@<org>.ingest.sentry.io/<project-id>"
   * Required in: production (optional in local/preview — errors go to terminal when missing)
   * Behavior when missing: Sentry.init receives undefined; SDK silently disables
   *   itself. The `enabled` gate below also prevents any activity outside production.
   * Rotation: per-incident if key is suspected compromised; otherwise as needed.
   * NOTE: Use SENTRY_DSN (not NEXT_PUBLIC_SENTRY_DSN) on the server so this
   *   value is never embedded in the client-side JavaScript bundle.
   */
  dsn: process.env.SENTRY_DSN,

  /**
   * Percentage of server-side transactions to capture for performance tracing.
   * 0.1 = 10% of API calls, RSC renders, and Server Actions are traced.
   */
  tracesSampleRate: 0.1,

  /** Tag errors with the current environment for filtering in Sentry dashboard. */
  environment: process.env.NODE_ENV,

  /**
   * Only report errors in production builds AND when the mute kill switch
   * is not engaged. See `STYRBY_SENTRY_MUTED` doc at the top of this file.
   */
  enabled: process.env.NODE_ENV === 'production' && !isMuted,

  /** Drop known-benign server-side errors before they reach Sentry. */
  beforeSend(event, hint) {
    const msg =
      (hint?.originalException instanceof Error ? hint.originalException.message : '') ||
      event.message ||
      '';
    if (NOISE_PATTERNS.some((rx) => rx.test(msg))) return null;
    return event;
  },

  ignoreErrors: [/ECONNRESET/i, /socket hang up/i, /ETIMEDOUT/i],
});
