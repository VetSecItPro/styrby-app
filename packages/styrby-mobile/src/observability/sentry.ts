/**
 * Mobile Sentry Initialization
 *
 * Initialises `@sentry/react-native` for the Styrby mobile app. This module
 * is imported in `app/_layout.tsx` before the navigation stack renders so
 * that the SDK wraps React Native's error boundary and captures JS crashes
 * that occur during the initial render cycle.
 *
 * WHY Sentry in the mobile app:
 * Mobile crashes are silent from the founder's perspective. Sentry gives
 * structured error reports with breadcrumbs from structured logger events
 * that led up to the crash, with correlation to specific user/session/agent.
 *
 * WHY EXPO_PUBLIC_STYRBY_SENTRY_MUTED:
 * Expo requires env vars consumed in the JS bundle to be prefixed EXPO_PUBLIC_.
 * Toggle it in EAS secrets + trigger a new build to silence the SDK without a
 * code change.
 *
 * WHY React Native-specific noise filters:
 * The React Native / Hermes runtime emits a set of benign errors around layout
 * measurement and async storage. We drop them at the beforeSend gate.
 *
 * @module observability/sentry
 */

import * as Sentry from '@sentry/react-native';
import type { SentryAdapter } from '@styrby/shared/logging';

// ============================================================================
// Noise patterns — React Native / Hermes runtime specifics
// ============================================================================

/**
 * Known-benign React Native error patterns to drop before reaching Sentry.
 * - Non-Error promise rejection: Hermes surfaces bare-string Promise rejections.
 * - ResizeObserver: RN web-compat polyfill — not actionable on native.
 * - Invariant Violation: fires during fast-refresh hot reloads in development.
 * - Cannot read property: Hermes layout-phase accesses handled internally.
 */
const NOISE_PATTERNS: readonly RegExp[] = [
  /Non-Error promise rejection captured/i,
  /ResizeObserver loop limit exceeded/i,
  /Invariant Violation/i,
  /SyntaxError.*require\(\)/i,
  /Cannot read prop.*of null/i,
  /The operation was aborted/i,
];

// ============================================================================
// Initialization
// ============================================================================

/**
 * Optional override config for testing.
 *
 * WHY: Expo's `babel-preset-expo` applies `babel-plugin-transform-inline-
 * environment-variables` which inlines `process.env.EXPO_PUBLIC_*` references
 * at Babel transform time. In Jest (and EAS Build), the compiled output has
 * the values baked in from the time of compilation — changing `process.env`
 * between test cases has no effect on already-transformed code.
 *
 * To keep the function testable we accept an optional overrides object so test
 * suites can inject DSN and mute-switch values directly without relying on the
 * inlined env vars.
 */
export interface MobileSentryInitOptions {
  /** Override the DSN (test use only — normally baked in from EXPO_PUBLIC_SENTRY_DSN). */
  dsn?: string;
  /** Override the muted flag (test use only — normally from EXPO_PUBLIC_STYRBY_SENTRY_MUTED). */
  muted?: boolean;
  /** Override the dev flag (test use only — normally from __DEV__ global). */
  isDev?: boolean;
}

/**
 * Initialise the Sentry React Native SDK.
 *
 * Call ONCE at the TOP of `app/_layout.tsx` before any JSX renders. The RN SDK
 * patches the global error handler and the React error boundary machinery —
 * both must be in place before the first render cycle.
 *
 * @param overrides - Optional test overrides for env-var-derived values.
 *
 * @example
 * ```ts
 * import { initMobileSentry } from '../src/observability/sentry';
 * initMobileSentry();
 * ```
 */
export function initMobileSentry(overrides?: MobileSentryInitOptions): void {
  /**
   * EXPO_PUBLIC_SENTRY_DSN — the mobile app's Sentry Data Source Name.
   * Source: sentry.io > Project Settings > Client Keys (DSN)
   * Set via: EAS secrets as EXPO_PUBLIC_SENTRY_DSN (bundled at build time).
   * Behavior when missing: SDK silently disables itself.
   */
  const dsn = overrides?.dsn ?? process.env.EXPO_PUBLIC_SENTRY_DSN;

  /**
   * Mute switch: EXPO_PUBLIC_STYRBY_SENTRY_MUTED=true in EAS secrets silences the SDK.
   */
  const muted = overrides?.muted ?? process.env.EXPO_PUBLIC_STYRBY_SENTRY_MUTED === 'true';

  /**
   * WHY __DEV__: React Native exposes `__DEV__` as a global boolean that is
   * true when running via `expo start` / Metro development server.
   */
  const isDev = overrides?.isDev ?? (typeof __DEV__ !== 'undefined' ? __DEV__ : false);

  Sentry.init({
    dsn,
    tracesSampleRate: 0.1,
    /** Enable only on production builds AND when not muted. */
    enabled: !isDev && !muted,
    environment: isDev ? 'development' : 'production',
    beforeSend(event, hint) {
      const msg =
        (hint?.originalException instanceof Error
          ? hint.originalException.message
          : '') ||
        (event.message as string | undefined) ||
        '';
      if (NOISE_PATTERNS.some((rx) => rx.test(msg))) return null;
      return event;
    },
    ignoreErrors: [
      'Non-Error promise rejection captured',
      /ResizeObserver loop limit exceeded/,
      /Invariant Violation/,
    ],
  });
}

/**
 * Returns a SentryAdapter wrapping @sentry/react-native for use with the Logger.
 *
 * WHY needed: The Logger lives in @styrby/shared and cannot import
 * @sentry/react-native directly. This factory creates a narrow adapter at
 * the mobile boundary so the Logger can forward error/warn entries to Sentry.
 *
 * @returns SentryAdapter compatible with Logger.setSentry()
 */
export function getMobileSentryAdapter(): SentryAdapter {
  return {
    addBreadcrumb: (breadcrumb) => Sentry.addBreadcrumb(breadcrumb),
    captureException: (error, context) =>
      Sentry.captureException(error, context) ?? '',
  };
}
