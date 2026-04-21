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

/**
 * STYRBY_SENTRY_MUTED — emergency kill switch for the edge runtime.
 * Set to 'true' in Vercel env vars + redeploy to silence the SDK without
 * a code change when notifications are spamming the founder inbox.
 */
const isMuted = process.env.STYRBY_SENTRY_MUTED === 'true';

Sentry.init({
  /**
   * SENTRY_DSN — Server-only DSN for the edge runtime (same key as server config).
   *
   * Source: sentry.io > Project Settings > Client Keys (DSN)
   * Format: "https://<key>@<org>.ingest.sentry.io/<project-id>"
   * Required in: production (optional in local/preview — errors go to terminal when missing)
   * Behavior when missing: Sentry.init receives undefined; SDK silently disables
   *   itself. The `enabled` gate below also prevents any activity outside production.
   * Rotation: per-incident if key is suspected compromised; otherwise as needed.
   * NOTE: Uses SENTRY_DSN (not NEXT_PUBLIC_SENTRY_DSN) — edge middleware runs on
   *   the server side and this value must never appear in the client bundle.
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
   * Only report errors in production builds AND when the mute kill switch
   * is not engaged. See `STYRBY_SENTRY_MUTED` doc at the top of this file.
   */
  enabled: process.env.NODE_ENV === 'production' && !isMuted,
});
