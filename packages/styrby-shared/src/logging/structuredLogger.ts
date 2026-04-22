/**
 * Structured Logger
 *
 * Platform-agnostic JSON-line logger consumed by styrby-cli, styrby-web, and
 * styrby-mobile. Each log entry is a single JSON object written to stdout so
 * that log aggregators (Papertrail, Datadog, CloudWatch) can parse structured
 * fields without regex fragility.
 *
 * WHY JSON lines instead of pretty-print:
 * Structured logs let the founder dashboard correlate errors to specific
 * sessions, users, machines, and agents. Human-readable logs look great in
 * a terminal but are nearly impossible to query at scale. JSON lines give
 * us both — parseable by log aggregators AND readable in a terminal with `jq`.
 *
 * WHY a shared Logger vs. per-package loggers:
 * All three surfaces (CLI, web, mobile) need the same correlation ID fields
 * (sessionId, userId, machineId, agent, traceId). A single class keeps the
 * schema consistent so the founder dashboard can JOIN on those fields without
 * knowing which surface emitted the log.
 *
 * WHY error/warn go to Sentry while info/debug stay log-only:
 * info and debug are high-volume diagnostic signals. Sending them to Sentry
 * would exhaust quota with noise and obscure actionable error/warn events.
 * Only error and warn represent conditions the founder must be aware of.
 *
 * @module logging/structuredLogger
 */

// ============================================================================
// Types
// ============================================================================

/** Log severity levels, ordered from least to most severe. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Correlation context attached to every log entry.
 * All fields are optional — callers provide as many as are relevant.
 */
export interface LogContext {
  /** Active Styrby session UUID (from sessions table). */
  sessionId?: string;
  /** Supabase auth user UUID. */
  userId?: string;
  /** Registered machine UUID (from machines table). */
  machineId?: string;
  /** AI agent identifier ('claude' | 'codex' | 'gemini' | etc.). */
  agent?: string;
  /**
   * Distributed trace identifier.
   *
   * WHY: A single user action (e.g. start session) can touch CLI → Supabase →
   * Edge Function → mobile push. A traceId threaded through all log entries
   * for that action lets the founder correlate what happened across surfaces
   * in a single query. If the caller doesn't provide one, the logger generates
   * a UUID per Logger instance.
   */
  traceId?: string;
  /** Any additional key-value pairs for ad-hoc context. */
  [key: string]: unknown;
}

/** A single structured log entry as written to stdout. */
export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context: LogContext & { traceId: string };
}

// ============================================================================
// Sentry Breadcrumb Interface
// ============================================================================

/**
 * Minimal interface for Sentry breadcrumb/capture methods.
 *
 * WHY a local interface instead of importing @sentry/*:
 * structuredLogger lives in @styrby/shared and must be importable in ALL three
 * environments without pulling in a platform-specific Sentry SDK. Callers wire
 * their platform SDK in at construction time via the `sentry` option. The
 * interface is narrow enough that all three SDKs satisfy it without casting.
 */
export interface SentryAdapter {
  addBreadcrumb(breadcrumb: {
    level: 'info' | 'warning' | 'error';
    message: string;
    data?: Record<string, unknown>;
    timestamp?: number;
  }): void;

  captureException(
    error: unknown,
    captureContext?: {
      extra?: Record<string, unknown>;
      tags?: Record<string, string>;
    },
  ): string;
}

// ============================================================================
// Logger Options
// ============================================================================

/** Configuration passed to the Logger constructor. */
export interface LoggerOptions {
  /**
   * Minimum severity to emit. Entries below this level are silently dropped.
   * Defaults to 'debug'.
   */
  minLevel?: LogLevel;

  /**
   * Optional Sentry adapter.
   * When provided, `error` entries are captured as Sentry exceptions and
   * `warn` entries are added as Sentry breadcrumbs.
   */
  sentry?: SentryAdapter;

  /**
   * Default trace ID for all entries emitted by this instance.
   * If omitted, the logger auto-generates a UUID.
   */
  traceId?: string;

  /**
   * Custom write function. Defaults to process.stdout.write (Node) or
   * console.log (React Native / browser).
   * WHY injectable: makes unit testing zero-dependency.
   */
  writeFn?: (line: string) => void;
}

// ============================================================================
// Level Constants
// ============================================================================

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// ============================================================================
// Logger Class
// ============================================================================

/**
 * Structured JSON-line logger for Styrby.
 *
 * All three packages import this class from `@styrby/shared/logging` and wire
 * in their platform's Sentry SDK at app startup. Log entries are emitted as
 * newline-delimited JSON to stdout and, for error/warn, forwarded to Sentry.
 *
 * @example CLI usage
 * ```ts
 * import { Logger } from '@styrby/shared/logging';
 * import * as Sentry from '@sentry/node';
 * export const log = new Logger({ sentry: Sentry, minLevel: 'info' });
 * log.info('session started', { sessionId, userId, agent });
 * log.error('relay disconnected', { sessionId }, new Error('ECONNRESET'));
 * ```
 */
export class Logger {
  private readonly instanceTraceId: string;
  private readonly minLevel: LogLevel;
  private sentry: SentryAdapter | undefined;
  private readonly writeFn: (line: string) => void;

  constructor(options: LoggerOptions = {}) {
    this.instanceTraceId = options.traceId ?? generateTraceId();
    this.minLevel = options.minLevel ?? 'debug';
    this.sentry = options.sentry;
    this.writeFn = options.writeFn ?? defaultWrite;
  }

  /**
   * Log a debug-level entry (development/troubleshooting signals).
   *
   * @param message - Human-readable summary
   * @param context - Correlation fields (sessionId, userId, etc.)
   */
  debug(message: string, context: LogContext = {}): void {
    this.emit('debug', message, context);
  }

  /**
   * Log an informational entry (normal operational events).
   *
   * @param message - Human-readable summary
   * @param context - Correlation fields
   */
  info(message: string, context: LogContext = {}): void {
    this.emit('info', message, context);
  }

  /**
   * Log a warning and forward to Sentry as a breadcrumb.
   *
   * WHY breadcrumb not exception: a warn is degraded-but-recoverable.
   * It should appear in Sentry's breadcrumb trail for context when a
   * subsequent error event arrives, but not generate its own alert.
   *
   * @param message - Human-readable summary
   * @param context - Correlation fields
   */
  warn(message: string, context: LogContext = {}): void {
    this.emit('warn', message, context);
    this.sentryBreadcrumb('warning', message, context);
  }

  /**
   * Log an error and capture it in Sentry as a full exception event.
   *
   * @param message - Human-readable summary
   * @param context - Correlation fields
   * @param error - Optional Error object (stack trace forwarded to Sentry)
   */
  error(message: string, context: LogContext = {}, error?: Error | unknown): void {
    this.emit('error', message, context);
    this.sentryCapture(message, context, error);
  }

  /**
   * Wire in a Sentry adapter after construction.
   *
   * WHY needed: on React Native, Sentry must be initialised before the JS
   * bundle evaluates most modules, but a logger instance may be created before
   * Sentry.init() returns. This lets callers late-bind the adapter.
   *
   * @param adapter - Platform Sentry SDK satisfying SentryAdapter
   */
  setSentry(adapter: SentryAdapter): void {
    this.sentry = adapter;
  }

  /**
   * Returns the auto-generated trace ID for this Logger instance.
   */
  getTraceId(): string {
    return this.instanceTraceId;
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  private emit(level: LogLevel, message: string, context: LogContext): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      context: {
        ...context,
        traceId: context.traceId ?? this.instanceTraceId,
      },
    };

    try {
      this.writeFn(JSON.stringify(entry) + '\n');
    } catch {
      // Never let logging failures crash the process.
    }
  }

  private sentryBreadcrumb(
    level: 'info' | 'warning' | 'error',
    message: string,
    context: LogContext,
  ): void {
    if (!this.sentry) return;
    try {
      this.sentry.addBreadcrumb({
        level,
        message,
        data: context as Record<string, unknown>,
        timestamp: Date.now() / 1000,
      });
    } catch {
      // Sentry failure must never crash the caller.
    }
  }

  private sentryCapture(
    message: string,
    context: LogContext,
    error?: Error | unknown,
  ): void {
    if (!this.sentry) return;
    try {
      const captureTarget =
        error instanceof Error ? error : new Error(message);
      this.sentry.captureException(captureTarget, {
        extra: context as Record<string, unknown>,
        tags: buildSentryTags(context),
      });
    } catch {
      // Sentry failure must never crash the caller.
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Generate a UUID v4 trace identifier.
 * Uses crypto.randomUUID when available, falls back to Math.random for
 * very old React Native builds.
 */
function generateTraceId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Extract well-known Sentry tag fields from a LogContext.
 * Tags must be strings in Sentry, so we coerce and omit non-string values.
 */
function buildSentryTags(context: LogContext): Record<string, string> {
  const tags: Record<string, string> = {};
  if (typeof context.sessionId === 'string') tags['session_id'] = context.sessionId;
  if (typeof context.userId === 'string') tags['user_id'] = context.userId;
  if (typeof context.machineId === 'string') tags['machine_id'] = context.machineId;
  if (typeof context.agent === 'string') tags['agent'] = context.agent;
  if (typeof context.traceId === 'string') tags['trace_id'] = context.traceId;
  return tags;
}

/**
 * Default write function — uses process.stdout when available (Node/CLI),
 * falls back to console.log (browser/React Native).
 */
function defaultWrite(line: string): void {
  if (
    typeof process !== 'undefined' &&
    process.stdout &&
    typeof process.stdout.write === 'function'
  ) {
    process.stdout.write(line);
  } else {
    console.log(line.trimEnd());
  }
}
