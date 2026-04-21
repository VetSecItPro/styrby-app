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

/**
 * STYRBY_SENTRY_MUTED — emergency kill switch.
 *
 * Set `STYRBY_SENTRY_MUTED=true` (or `NEXT_PUBLIC_STYRBY_SENTRY_MUTED=true` for
 * the client bundle) to silence the SDK regardless of environment. Flip it in
 * Vercel env vars + redeploy to stop notification spam without a code change.
 *
 * WHY: real production errors can drown the founder inbox during an incident
 * or a preview-deploy error cascade. The env-var kill switch takes effect at
 * boot with no SDK calls going out. Unset it once the noise is handled.
 */
const isMuted =
  process.env.NEXT_PUBLIC_STYRBY_SENTRY_MUTED === 'true' ||
  process.env.STYRBY_SENTRY_MUTED === 'true';

/**
 * Noise filter — errors matching any of these patterns are dropped before
 * reaching Sentry. Add specific pattern here when a known-benign error class
 * is spamming notifications; keep the list short so real regressions still
 * reach the dashboard.
 */
const NOISE_PATTERNS: readonly RegExp[] = [
  /ResizeObserver loop limit exceeded/i,
  /Non-Error promise rejection captured/i,
  /NetworkError when attempting to fetch resource/i,
  /Load failed/i,
  /The operation was aborted/i,
  // Chrome extension injection noise
  /extension:\/\//i,
];

Sentry.init({
  /**
   * NEXT_PUBLIC_SENTRY_DSN — Public Data Source Name that routes browser errors to Sentry.
   *
   * Source: sentry.io > Project Settings > Client Keys (DSN)
   * Format: "https://<key>@<org>.ingest.sentry.io/<project-id>"
   * Required in: production (optional in local/preview — errors go to console when missing)
   * Behavior when missing: Sentry.init receives undefined; SDK silently disables
   *   itself (no errors sent, no crash). The `enabled` gate below also prevents
   *   any activity outside production.
   * Rotation: per-incident if key is suspected compromised; otherwise as needed.
   *   This key is ingest-only — it cannot read your Sentry data.
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
   * Only report errors in production builds AND when not muted by env var.
   * WHY: dev noise stays in the browser console; the mute switch lets the
   * founder stop live notification spam without a code push.
   */
  enabled: process.env.NODE_ENV === 'production' && !isMuted,

  /**
   * Hard-drop known noise before it ever becomes a Sentry event.
   * Anything matching a NOISE_PATTERN returns null here — Sentry discards it.
   */
  beforeSend(event, hint) {
    const msg =
      (hint?.originalException instanceof Error ? hint.originalException.message : '') ||
      event.message ||
      '';
    if (NOISE_PATTERNS.some((rx) => rx.test(msg))) return null;
    return event;
  },

  /**
   * SDK-level ignore list — stops common browser-quirk errors from even
   * reaching `beforeSend`. Cheaper than a beforeSend check for very common
   * noise. Keep synchronized in spirit with NOISE_PATTERNS.
   */
  ignoreErrors: [
    'ResizeObserver loop limit exceeded',
    'Non-Error promise rejection captured',
    /^NetworkError when attempting to fetch resource/,
    /^The operation was aborted/,
  ],
});
