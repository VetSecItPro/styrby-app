/**
 * Sentry client-side initialization.
 *
 * This file is automatically loaded by Next.js before the client bundle via the
 * `instrumentationHook` experimental flag (App Router). It runs in the browser
 * on every page load.
 *
 * WHY replaysSessionSampleRate and replaysOnErrorSampleRate are 0:
 * Styrby handles end-to-end encrypted session content. Recording session replays
 * could inadvertently capture plaintext content before it is encrypted on the
 * client. We intentionally disable all replay features to protect user privacy.
 *
 * WHY tracesSampleRate is 0.1:
 * 10% sampling in production gives us enough performance data to catch regressions
 * without generating excessive Sentry quota usage. Adjust upward if we need
 * more granular tracing during incident investigations.
 *
 * WHY enabled is gated on NODE_ENV === 'production':
 * Local development errors should surface in the browser console, not be sent
 * to Sentry. This prevents noise in the Sentry dashboard from dev/test runs.
 */
import * as Sentry from '@sentry/nextjs';

Sentry.init({
  /**
   * Sentry DSN (Data Source Name) — public client key that identifies the project.
   * Get this from: sentry.io > Project Settings > Client Keys (DSN)
   * Safe to expose in browser bundles (scoped to ingest only).
   */
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

  /**
   * Percentage of transactions to capture for performance monitoring.
   * 0.1 = 10% of page loads and API calls are traced.
   */
  tracesSampleRate: 0.1,

  /**
   * Session Replay — DISABLED intentionally for user privacy.
   * WHY: Styrby handles encrypted session content. Replays could capture
   * plaintext before it reaches the encryption layer.
   */
  replaysSessionSampleRate: 0,

  /**
   * Session Replay on errors — DISABLED intentionally for user privacy.
   * Same reason as replaysSessionSampleRate above.
   */
  replaysOnErrorSampleRate: 0,

  /** Tag errors with the current environment for filtering in Sentry dashboard. */
  environment: process.env.NODE_ENV,

  /**
   * Only report errors in production builds.
   * WHY: Dev errors appear in the browser console — no need to pollute the
   * Sentry dashboard with local development noise.
   */
  enabled: process.env.NODE_ENV === 'production',
});
