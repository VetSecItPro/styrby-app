/**
 * Sentry edge runtime initialization.
 *
 * This file is loaded by the `src/instrumentation.ts` hook when the runtime
 * is `'edge'`. It captures errors from middleware running in the V8 isolate
 * (Vercel Edge Network), which cannot use the full Node.js Sentry SDK.
 *
 * WHY a separate edge config:
 * The edge runtime is a restricted V8 environment — no Node.js APIs, no file
 * system, no native modules. Sentry ships a lightweight edge-compatible build
 * that works within these constraints. The same DSN can be used, but the SDK
 * import path resolves to the edge bundle automatically via @sentry/nextjs.
 *
 * WHY tracesSampleRate is 0.1:
 * Middleware runs on every request (auth checks, redirects). Even 10% sampling
 * gives adequate insight into edge latency without Sentry quota exhaustion.
 *
 * WHY enabled is gated on NODE_ENV === 'production':
 * Edge middleware in development runs locally via `next dev`. Dev errors should
 * appear in the terminal, not in Sentry's production issue stream.
 */
import * as Sentry from '@sentry/nextjs';

Sentry.init({
  /**
   * Sentry DSN — identifies this project to the Sentry ingest service.
   * Get this from: sentry.io > Project Settings > Client Keys (DSN)
   *
   * NOTE: Uses SENTRY_DSN (server-only env var) since edge middleware
   * runs on the server and this value must not appear in the client bundle.
   */
  dsn: process.env.SENTRY_DSN,

  /**
   * Percentage of edge middleware transactions to capture for tracing.
   * 0.1 = 10% of middleware executions are traced.
   */
  tracesSampleRate: 0.1,

  /** Tag errors with the current environment for filtering in Sentry dashboard. */
  environment: process.env.NODE_ENV,

  /**
   * Only report errors in production builds.
   * WHY: Local middleware errors appear in the Next.js dev server terminal.
   * Routing them to Sentry would create noise in the production dashboard.
   */
  enabled: process.env.NODE_ENV === 'production',
});
