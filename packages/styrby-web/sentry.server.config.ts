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

Sentry.init({
  /**
   * Sentry DSN — server-side key used to identify the project.
   * Get this from: sentry.io > Project Settings > Client Keys (DSN)
   *
   * NOTE: On the server we use SENTRY_DSN (not NEXT_PUBLIC_SENTRY_DSN) so
   * this value is never embedded in the client bundle.
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
   * Only report errors in production builds.
   * WHY: Development stack traces are visible in the terminal — no need to
   * route them to Sentry and generate false-positive alerts.
   */
  enabled: process.env.NODE_ENV === 'production',
});
