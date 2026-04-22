/**
 * CLI Sentry Initialization
 *
 * Initialises `@sentry/node` for the Styrby CLI process. Must be imported
 * BEFORE any other module at the top of `src/index.ts` so that process-level
 * uncaughtException/unhandledRejection handlers are registered first.
 *
 * WHY Sentry in the CLI:
 * The CLI is the highest-risk surface — it runs on developer machines, spawns
 * subprocesses, holds Supabase tokens, and relays encrypted messages. Uncaught
 * exceptions here silently kill active sessions. Sentry gives the founder
 * visibility into crash patterns before users report them via support tickets.
 *
 * WHY STYRBY_SENTRY_MUTED:
 * Same emergency kill-switch pattern as the web SDK. Set STYRBY_SENTRY_MUTED=true
 * in the shell (or ~/.styrby/config.json) to silence the SDK without requiring
 * a new npm publish and reinstall.
 *
 * WHY ignoreErrors matches the web server config:
 * ECONNRESET / socket hang up / ETIMEDOUT happen whenever a developer's internet
 * blips while the CLI is relaying. These are handled by the relay reconnect logic
 * and should not generate Sentry alerts or exhaust quota.
 *
 * @module observability/sentry
 */

import * as Sentry from '@sentry/node';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SentryAdapter } from '@styrby/shared/logging';

// ============================================================================
// Config helpers
// ============================================================================

/**
 * Reads the optional ~/.styrby/config.json file.
 *
 * WHY: CLI users typically don't set env vars persistently. Storing the DSN in
 * ~/.styrby/config.json allows opt-in Sentry reporting without requiring
 * terminal profile edits. The env var always wins — config.json is a fallback.
 */
function readCliConfig(): Record<string, unknown> {
  try {
    const configPath = join(homedir(), '.styrby', 'config.json');
    const raw = readFileSync(configPath, 'utf-8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Resolve the Sentry DSN for the CLI process.
 * Priority: STYRBY_SENTRY_DSN env var > sentry.dsn in ~/.styrby/config.json
 */
function resolveDsn(): string | undefined {
  if (process.env.STYRBY_SENTRY_DSN) return process.env.STYRBY_SENTRY_DSN;
  const config = readCliConfig();
  if (typeof config.sentry === 'object' && config.sentry !== null) {
    const sentryConfig = config.sentry as Record<string, unknown>;
    if (typeof sentryConfig.dsn === 'string') return sentryConfig.dsn;
  }
  return undefined;
}

// ============================================================================
// Noise patterns — keep in sync with web server config
// ============================================================================

/**
 * Known-benign error patterns for CLI network operations.
 * ECONNRESET/socket hang up/ETIMEDOUT: relay reconnect handles recovery.
 * EPIPE: write to closed agent process pipe (normal on agent shutdown).
 */
const NOISE_PATTERNS: readonly RegExp[] = [
  /ECONNRESET/i,
  /socket hang up/i,
  /ETIMEDOUT/i,
  /Request aborted/i,
  /The operation was aborted/i,
  /EPIPE/i,
];

// ============================================================================
// Mute switch
// ============================================================================

/**
 * STYRBY_SENTRY_MUTED — emergency kill switch for the CLI Sentry SDK.
 *
 * Set STYRBY_SENTRY_MUTED=true in the shell environment, or set
 * `{ "sentry": { "muted": true } }` in ~/.styrby/config.json to silence the
 * SDK. The env var takes precedence.
 *
 * WHY two ways to mute: a developer on a staging machine may not have easy
 * access to edit shell profile files. config.json allows per-machine muting.
 */
function isMuted(): boolean {
  if (process.env.STYRBY_SENTRY_MUTED === 'true') return true;
  const config = readCliConfig();
  if (typeof config.sentry === 'object' && config.sentry !== null) {
    const sentryConfig = config.sentry as Record<string, unknown>;
    if (sentryConfig.muted === true) return true;
  }
  return false;
}

// ============================================================================
// Initialization
// ============================================================================

/**
 * Initialise Sentry for the CLI process.
 *
 * Call ONCE at the top of `src/index.ts`, before any other imports or logic.
 * Subsequent calls are no-ops (Sentry.init is idempotent).
 *
 * @example
 * ```ts
 * import { initSentry } from '@/observability/sentry';
 * initSentry();
 * ```
 */
export function initSentry(): void {
  const dsn = resolveDsn();
  const muted = isMuted();

  Sentry.init({
    /**
     * STYRBY_SENTRY_DSN — the CLI's Sentry Data Source Name.
     * Source: sentry.io > Project Settings > Client Keys (DSN)
     * Set via: STYRBY_SENTRY_DSN env var or ~/.styrby/config.json sentry.dsn
     * Behavior when missing: SDK silently disables itself.
     */
    dsn,
    tracesSampleRate: 0.1,
    environment: process.env.NODE_ENV ?? 'production',
    /**
     * Only report in non-development AND when not muted by the kill switch.
     * WHY: developer machines run in non-production mode; sending their errors
     * to the production Sentry project creates noise for the founder.
     */
    enabled: process.env.NODE_ENV !== 'development' && !muted,
    ignoreErrors: [/ECONNRESET/i, /socket hang up/i, /ETIMEDOUT/i, /EPIPE/i],
    beforeSend(event, hint) {
      const msg =
        (hint?.originalException instanceof Error
          ? hint.originalException.message
          : '') ||
        event.message ||
        '';
      if (NOISE_PATTERNS.some((rx) => rx.test(msg))) return null;
      return event;
    },
  });

  // ── Process-level uncaught error handlers ────────────────────────────────
  //
  // WHY register here (not in index.ts):
  // These handlers MUST be in scope before any async code runs. index.ts calls
  // initSentry() synchronously at the top, ensuring the handlers are registered
  // before runCommand() is even imported.

  process.on('uncaughtException', (error: Error) => {
    Sentry.captureException(error, { tags: { handler: 'uncaughtException' } });
    // Re-throw so Node.js default crash behaviour (non-zero exit, stderr dump) fires.
    throw error;
  });

  process.on('unhandledRejection', (reason: unknown) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    Sentry.captureException(error, { tags: { handler: 'unhandledRejection' } });
    // WHY no re-throw: Node 15+ already terminates on unhandled rejections.
    // Re-throwing would cause double-termination on older versions.
  });
}

/**
 * Returns a SentryAdapter wrapping @sentry/node for use with the structured Logger.
 *
 * WHY a factory: The Logger lives in @styrby/shared and cannot import @sentry/node
 * directly (would pull Node-only modules into mobile/web bundles). This factory
 * creates a narrow adapter at the CLI boundary only.
 *
 * @returns SentryAdapter compatible with Logger constructor and Logger.setSentry()
 */
export function getSentryAdapter(): SentryAdapter {
  return {
    addBreadcrumb: (breadcrumb) => Sentry.addBreadcrumb(breadcrumb),
    captureException: (error, context) =>
      Sentry.captureException(error, context) ?? '',
  };
}
