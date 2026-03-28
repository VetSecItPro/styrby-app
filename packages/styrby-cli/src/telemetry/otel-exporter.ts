/**
 * OpenTelemetry Metrics Exporter
 *
 * Exports Styrby session metrics to any OTLP-compatible backend (Grafana,
 * Datadog, Prometheus via OTLP collector, etc.) using the OTLP/HTTP JSON
 * wire protocol.
 *
 * ## Design Decisions
 *
 * - **No @opentelemetry/* SDK dependency**: OTLP over HTTP is just a POST
 *   request with a specific JSON schema. We implement the protocol directly
 *   to avoid pulling in a heavy SDK tree that would increase CLI install size
 *   and introduce transitive dependency churn.
 *
 * - **Opt-in only**: The exporter is disabled by default. Users must set
 *   `STYRBY_OTEL_ENABLED=true` to activate it. This prevents accidental
 *   telemetry leaks for users who have not configured an OTLP endpoint.
 *
 * - **Best-effort delivery**: Metric export failures are logged but do not
 *   propagate as errors. A failing OTEL backend should never interrupt a
 *   coding session.
 *
 * ## Configuration
 *
 * Set these environment variables to enable OTEL export:
 *
 * | Variable                | Default               | Description                        |
 * |-------------------------|-----------------------|------------------------------------|
 * | `STYRBY_OTEL_ENABLED`   | `false`               | Set to `true` to enable export     |
 * | `STYRBY_OTEL_ENDPOINT`  | (required when enabled) | OTLP/HTTP endpoint URL           |
 * | `STYRBY_OTEL_HEADERS`   | `{}`                  | JSON object of extra HTTP headers  |
 * | `STYRBY_OTEL_SERVICE`   | `styrby-cli`          | OTLP service.name resource attr    |
 * | `STYRBY_OTEL_TIMEOUT_MS`| `5000`                | HTTP request timeout in ms         |
 *
 * ## Exported Metrics
 *
 * | Metric                      | Type    | Attributes                                  |
 * |-----------------------------|---------|---------------------------------------------|
 * | `styrby.session.duration_ms`| Gauge   | agent, model, status                        |
 * | `styrby.tokens.input`       | Sum     | agent, model                                |
 * | `styrby.tokens.output`      | Sum     | agent, model                                |
 * | `styrby.tokens.cache_read`  | Sum     | agent, model                                |
 * | `styrby.tokens.cache_write` | Sum     | agent, model                                |
 * | `styrby.cost.usd`           | Sum     | agent, model                                |
 * | `styrby.errors.count`       | Sum     | agent, error_source                         |
 *
 * @module telemetry/otel-exporter
 */

import { logger } from '@/ui/logger';

// ============================================================================
// OTLP JSON Wire Types
// (Minimal subset of the OTLP protobuf schema expressed as JSON)
// ============================================================================

/** OTLP key-value attribute pair */
interface OtlpKeyValue {
  key: string;
  value: { stringValue?: string; intValue?: string; doubleValue?: number; boolValue?: boolean };
}

/** OTLP number data point */
interface OtlpNumberDataPoint {
  /** Start of the measurement interval (Unix nanos as string) */
  startTimeUnixNano: string;
  /** End of the measurement interval (Unix nanos as string) */
  timeUnixNano: string;
  /** Double-precision value */
  asDouble: number;
  /** Metric-level attributes (dimensions) */
  attributes: OtlpKeyValue[];
}

/** OTLP Sum metric (monotonically increasing counter) */
interface OtlpSum {
  dataPoints: OtlpNumberDataPoint[];
  /** Whether the sum only ever increases */
  isMonotonic: boolean;
  /** How the sum aggregates across reporting windows */
  aggregationTemporality: 2; // AGGREGATION_TEMPORALITY_CUMULATIVE
}

/** OTLP Gauge metric (instantaneous value) */
interface OtlpGauge {
  dataPoints: OtlpNumberDataPoint[];
}

/** A single named OTLP metric */
interface OtlpMetric {
  name: string;
  description?: string;
  unit?: string;
  sum?: OtlpSum;
  gauge?: OtlpGauge;
}

/** OTLP scope metrics wrapper */
interface OtlpScopeMetrics {
  scope: { name: string; version: string };
  metrics: OtlpMetric[];
}

/** OTLP resource metrics (one per service) */
interface OtlpResourceMetrics {
  resource: { attributes: OtlpKeyValue[] };
  scopeMetrics: OtlpScopeMetrics[];
}

/** Top-level OTLP metrics export request body */
interface OtlpExportMetricsRequest {
  resourceMetrics: OtlpResourceMetrics[];
}

// ============================================================================
// Public API Types
// ============================================================================

/**
 * Metrics payload for a completed coding session.
 *
 * WHY: Each session generates one payload. The exporter converts this into
 * OTLP data points and ships them to the configured backend.
 */
export interface SessionMetrics {
  /**
   * Styrby session ID (maps to sessions.id in Supabase).
   * Used as a unique identifier for deduplication on the backend.
   */
  sessionId: string;

  /**
   * Agent type that ran this session.
   * Maps to the `agent` OTLP attribute on all data points.
   */
  agent: string;

  /**
   * Model identifier (e.g., 'claude-sonnet-4', 'gpt-4o').
   * Maps to the `model` OTLP attribute on token and cost metrics.
   */
  model: string;

  /**
   * Session duration in milliseconds.
   * Exported as `styrby.session.duration_ms` gauge.
   */
  durationMs: number;

  /**
   * Final session status.
   * Maps to the `status` OTLP attribute on the duration gauge.
   */
  status: string;

  /** Input tokens consumed. Exported as `styrby.tokens.input`. */
  inputTokens: number;

  /** Output tokens generated. Exported as `styrby.tokens.output`. */
  outputTokens: number;

  /** Cache read tokens. Exported as `styrby.tokens.cache_read`. */
  cacheReadTokens: number;

  /** Cache write tokens. Exported as `styrby.tokens.cache_write`. */
  cacheWriteTokens: number;

  /** Total cost in USD. Exported as `styrby.cost.usd`. */
  costUsd: number;

  /**
   * Number of errors that occurred during this session.
   * Exported as `styrby.errors.count`.
   */
  errorCount: number;

  /**
   * Source of errors (maps to the `error_source` OTLP attribute).
   * Use 'none' when errorCount is 0.
   */
  errorSource: string;

  /**
   * Unix timestamp (milliseconds) when the session started.
   * Used as startTimeUnixNano for OTLP data points.
   */
  startedAtMs: number;

  /**
   * Unix timestamp (milliseconds) when the session ended.
   * Used as timeUnixNano for OTLP data points.
   */
  endedAtMs: number;
}

/**
 * OTEL exporter configuration, resolved from environment variables.
 */
export interface OtelConfig {
  /**
   * Whether the exporter is enabled.
   * Maps to `STYRBY_OTEL_ENABLED=true`.
   */
  enabled: boolean;

  /**
   * OTLP/HTTP endpoint URL for the metrics export path.
   * Typically ends in `/v1/metrics`.
   * Maps to `STYRBY_OTEL_ENDPOINT`.
   */
  endpoint: string;

  /**
   * Additional HTTP headers to send with each export request.
   * Used for API key authentication (e.g., Grafana Cloud).
   * Maps to `STYRBY_OTEL_HEADERS` (JSON object).
   */
  headers: Record<string, string>;

  /**
   * The `service.name` resource attribute for OTLP.
   * Maps to `STYRBY_OTEL_SERVICE` (default: 'styrby-cli').
   */
  serviceName: string;

  /**
   * HTTP request timeout in milliseconds.
   * Maps to `STYRBY_OTEL_TIMEOUT_MS` (default: 5000).
   */
  timeoutMs: number;
}

// ============================================================================
// Config Resolution
// ============================================================================

/**
 * Resolve OTEL configuration from environment variables.
 *
 * WHY: Centralising env-var reading into one function makes the configuration
 * easy to test (inject a mock env) and easy to document.
 *
 * @param env - Environment variable map (defaults to process.env)
 * @returns Resolved OTEL configuration
 *
 * @example
 * const config = resolveOtelConfig();
 * if (!config.enabled) return; // fast path when OTEL is disabled
 */
export function resolveOtelConfig(env: Record<string, string | undefined> = process.env): OtelConfig {
  const enabled = env['STYRBY_OTEL_ENABLED'] === 'true';
  const endpoint = env['STYRBY_OTEL_ENDPOINT'] ?? '';
  const serviceName = env['STYRBY_OTEL_SERVICE'] ?? 'styrby-cli';
  const timeoutMs = Number(env['STYRBY_OTEL_TIMEOUT_MS'] ?? '5000');

  let headers: Record<string, string> = {};
  const headersRaw = env['STYRBY_OTEL_HEADERS'];
  if (headersRaw) {
    try {
      const parsed = JSON.parse(headersRaw);
      if (typeof parsed === 'object' && parsed !== null) {
        headers = parsed as Record<string, string>;
      }
    } catch {
      // WHY: Log a warning but continue — a malformed STYRBY_OTEL_HEADERS
      // should not crash the CLI. The export will fail gracefully with no headers.
      logger.warn('[OTEL] STYRBY_OTEL_HEADERS is not valid JSON; using empty headers');
    }
  }

  return { enabled, endpoint, headers, serviceName, timeoutMs: isNaN(timeoutMs) ? 5000 : timeoutMs };
}

// ============================================================================
// OTLP Builder Helpers
// ============================================================================

/**
 * Convert a number to a nanosecond Unix timestamp string (OTLP format).
 *
 * WHY: OTLP uses nanosecond-resolution timestamps as strings to avoid
 * JavaScript's lossy 64-bit float representation of large integers.
 *
 * @param ms - Unix timestamp in milliseconds
 * @returns Nanosecond timestamp as a decimal string
 */
function msToNanoString(ms: number): string {
  // Multiply by 1_000_000 to convert ms → ns, as BigInt to avoid precision loss
  return (BigInt(Math.round(ms)) * BigInt(1_000_000)).toString();
}

/**
 * Build an OTLP string key-value attribute.
 *
 * @param key - Attribute key
 * @param value - Attribute string value
 * @returns OTLP key-value pair
 */
function strAttr(key: string, value: string): OtlpKeyValue {
  return { key, value: { stringValue: value } };
}

/**
 * Build an OTLP number data point.
 *
 * @param value - The metric value
 * @param startMs - Start of measurement window (Unix ms)
 * @param endMs - End of measurement window (Unix ms)
 * @param attrs - Metric attributes (dimensions)
 * @returns OTLP number data point
 */
function makeDataPoint(
  value: number,
  startMs: number,
  endMs: number,
  attrs: OtlpKeyValue[],
): OtlpNumberDataPoint {
  return {
    startTimeUnixNano: msToNanoString(startMs),
    timeUnixNano: msToNanoString(endMs),
    asDouble: value,
    attributes: attrs,
  };
}

/**
 * Build a monotonically increasing Sum metric.
 *
 * @param name - Metric name
 * @param description - Human-readable description
 * @param unit - Metric unit (e.g., '{tokens}', 'USD')
 * @param dataPoints - Array of data points
 * @returns OTLP metric with Sum type
 */
function sumMetric(name: string, description: string, unit: string, dataPoints: OtlpNumberDataPoint[]): OtlpMetric {
  return {
    name,
    description,
    unit,
    sum: {
      dataPoints,
      isMonotonic: true,
      aggregationTemporality: 2,
    },
  };
}

/**
 * Build a Gauge metric (instantaneous value).
 *
 * @param name - Metric name
 * @param description - Human-readable description
 * @param unit - Metric unit
 * @param dataPoints - Array of data points
 * @returns OTLP metric with Gauge type
 */
function gaugeMetric(name: string, description: string, unit: string, dataPoints: OtlpNumberDataPoint[]): OtlpMetric {
  return {
    name,
    description,
    unit,
    gauge: { dataPoints },
  };
}

// ============================================================================
// Export Builder
// ============================================================================

/**
 * Convert a SessionMetrics payload to an OTLP export request body.
 *
 * WHY: Building the OTLP payload here (separate from the HTTP send) makes
 * the payload logic independently testable without mocking HTTP.
 *
 * @param metrics - Session metrics to export
 * @param config - OTEL configuration (used for resource attributes)
 * @returns OTLP export request body ready to POST
 */
export function buildOtlpPayload(metrics: SessionMetrics, config: OtelConfig): OtlpExportMetricsRequest {
  const { agent, model, startedAtMs, endedAtMs } = metrics;

  const agentModelAttrs: OtlpKeyValue[] = [
    strAttr('agent', agent),
    strAttr('model', model),
  ];

  const dataPoints: OtlpMetric[] = [
    // ── Duration gauge ─────────────────────────────────────────────────────
    gaugeMetric(
      'styrby.session.duration_ms',
      'Duration of a Styrby coding session in milliseconds',
      'ms',
      [makeDataPoint(
        metrics.durationMs,
        startedAtMs,
        endedAtMs,
        [...agentModelAttrs, strAttr('status', metrics.status)],
      )],
    ),

    // ── Token sums ──────────────────────────────────────────────────────────
    sumMetric(
      'styrby.tokens.input',
      'Input tokens consumed by the AI model',
      '{tokens}',
      [makeDataPoint(metrics.inputTokens, startedAtMs, endedAtMs, agentModelAttrs)],
    ),
    sumMetric(
      'styrby.tokens.output',
      'Output tokens generated by the AI model',
      '{tokens}',
      [makeDataPoint(metrics.outputTokens, startedAtMs, endedAtMs, agentModelAttrs)],
    ),
    sumMetric(
      'styrby.tokens.cache_read',
      'Tokens read from model prompt cache (reduced billing rate)',
      '{tokens}',
      [makeDataPoint(metrics.cacheReadTokens, startedAtMs, endedAtMs, agentModelAttrs)],
    ),
    sumMetric(
      'styrby.tokens.cache_write',
      'Tokens written to model prompt cache',
      '{tokens}',
      [makeDataPoint(metrics.cacheWriteTokens, startedAtMs, endedAtMs, agentModelAttrs)],
    ),

    // ── Cost sum ────────────────────────────────────────────────────────────
    sumMetric(
      'styrby.cost.usd',
      'Total cost in USD for the session',
      'USD',
      [makeDataPoint(metrics.costUsd, startedAtMs, endedAtMs, agentModelAttrs)],
    ),

    // ── Error count sum ─────────────────────────────────────────────────────
    sumMetric(
      'styrby.errors.count',
      'Number of errors encountered during the session',
      '{errors}',
      [makeDataPoint(
        metrics.errorCount,
        startedAtMs,
        endedAtMs,
        [strAttr('agent', agent), strAttr('error_source', metrics.errorSource)],
      )],
    ),
  ];

  return {
    resourceMetrics: [
      {
        resource: {
          attributes: [
            strAttr('service.name', config.serviceName),
            strAttr('telemetry.sdk.name', 'styrby-cli-otel'),
            strAttr('telemetry.sdk.language', 'nodejs'),
          ],
        },
        scopeMetrics: [
          {
            scope: { name: 'styrby.session', version: '1.0.0' },
            metrics: dataPoints,
          },
        ],
      },
    ],
  };
}

// ============================================================================
// HTTP Transport
// ============================================================================

/**
 * POST an OTLP payload to the configured endpoint.
 *
 * WHY: Using the global `fetch` API (available in Node.js 18+) avoids
 * pulling in an HTTP client dependency. The AbortController enforces the
 * configurable timeout so a slow OTEL backend can't stall the CLI.
 *
 * @param payload - OTLP export request body
 * @param config - OTEL configuration with endpoint and headers
 * @returns Promise that resolves when the request completes (or is aborted)
 *
 * @throws Never — all errors are caught and logged
 */
async function postOtlpPayload(
  payload: OtlpExportMetricsRequest,
  config: OtelConfig,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(config.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...config.headers,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      // WHY: Log the error but don't throw — OTEL export is best-effort.
      // A 429 or 503 from the OTEL backend should never interrupt a session.
      const text = await response.text().catch(() => '');
      logger.warn(`[OTEL] Export failed: HTTP ${response.status} ${text.slice(0, 120)}`);
    } else {
      logger.debug(`[OTEL] Exported session metrics to ${config.endpoint}`);
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      logger.warn(`[OTEL] Export timed out after ${config.timeoutMs}ms`);
    } else {
      logger.warn(`[OTEL] Export error: ${err instanceof Error ? err.message : String(err)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================================
// Public Exporter Class
// ============================================================================

/**
 * OtelExporter exports Styrby session metrics to an OTLP-compatible backend.
 *
 * Instantiate once at CLI startup; call `exportSession()` after each session
 * ends. The class is a no-op when OTEL is disabled, so it is safe to call
 * unconditionally.
 *
 * @example
 * const otel = new OtelExporter();
 *
 * // After a session ends:
 * await otel.exportSession({
 *   sessionId: 'abc-123',
 *   agent: 'claude',
 *   model: 'claude-sonnet-4',
 *   durationMs: 120_000,
 *   status: 'stopped',
 *   inputTokens: 50_000,
 *   outputTokens: 8_000,
 *   cacheReadTokens: 12_000,
 *   cacheWriteTokens: 3_000,
 *   costUsd: 0.18,
 *   errorCount: 0,
 *   errorSource: 'none',
 *   startedAtMs: Date.now() - 120_000,
 *   endedAtMs: Date.now(),
 * });
 */
export class OtelExporter {
  /**
   * Resolved configuration for this exporter instance.
   */
  readonly config: OtelConfig;

  /**
   * Construct an OtelExporter.
   *
   * @param config - Optional config override. When omitted, config is read
   *   from environment variables via `resolveOtelConfig()`.
   */
  constructor(config?: OtelConfig) {
    this.config = config ?? resolveOtelConfig();

    if (this.config.enabled) {
      if (!this.config.endpoint) {
        logger.warn('[OTEL] STYRBY_OTEL_ENABLED=true but STYRBY_OTEL_ENDPOINT is not set — disabling export');
        (this.config as { enabled: boolean }).enabled = false;
      } else {
        // SECURITY: Validate that the endpoint is a valid HTTP(S) URL.
        // Reject file://, javascript:, data:, and other non-HTTP schemes to
        // prevent SSRF against internal services or local file exfiltration.
        try {
          const parsed = new URL(this.config.endpoint);
          if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
            logger.warn(`[OTEL] STYRBY_OTEL_ENDPOINT has non-HTTP scheme "${parsed.protocol}" — disabling export`);
            (this.config as { enabled: boolean }).enabled = false;
          } else {
            logger.debug(`[OTEL] Exporter initialized → ${this.config.endpoint} (service: ${this.config.serviceName})`);
          }
        } catch {
          logger.warn('[OTEL] STYRBY_OTEL_ENDPOINT is not a valid URL — disabling export');
          (this.config as { enabled: boolean }).enabled = false;
        }
      }
    }
  }

  /**
   * Whether the exporter is active.
   *
   * @returns true if OTEL export is enabled and properly configured
   */
  get isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Export metrics for a completed session.
   *
   * This is a no-op when the exporter is disabled. On error, logs a warning
   * and resolves silently so the caller is never interrupted.
   *
   * @param metrics - Session metrics to export
   * @returns Promise that resolves when export is complete (or skipped)
   *
   * @example
   * await exporter.exportSession(sessionMetrics);
   */
  async exportSession(metrics: SessionMetrics): Promise<void> {
    if (!this.config.enabled) return;

    const payload = buildOtlpPayload(metrics, this.config);
    await postOtlpPayload(payload, this.config);
  }

  /**
   * Export multiple sessions in a single OTLP request.
   *
   * WHY: Batching reduces HTTP round-trips when flushing a queue of
   * offline-accumulated sessions. Each session becomes its own scope metrics
   * entry within a single resource metrics block.
   *
   * @param metricsArray - Array of session metrics to export
   * @returns Promise that resolves when export is complete (or skipped)
   */
  async exportBatch(metricsArray: SessionMetrics[]): Promise<void> {
    if (!this.config.enabled || metricsArray.length === 0) return;

    // Build all data points from all sessions and merge into one request
    const allMetrics: OtlpMetric[] = [];
    for (const metrics of metricsArray) {
      const singlePayload = buildOtlpPayload(metrics, this.config);
      const scopeMetrics = singlePayload.resourceMetrics[0]?.scopeMetrics[0]?.metrics ?? [];
      allMetrics.push(...scopeMetrics);
    }

    const batchPayload: OtlpExportMetricsRequest = {
      resourceMetrics: [
        {
          resource: {
            attributes: [
              strAttr('service.name', this.config.serviceName),
              strAttr('telemetry.sdk.name', 'styrby-cli-otel'),
              strAttr('telemetry.sdk.language', 'nodejs'),
            ],
          },
          scopeMetrics: [
            {
              scope: { name: 'styrby.session', version: '1.0.0' },
              metrics: allMetrics,
            },
          ],
        },
      ],
    };

    await postOtlpPayload(batchPayload, this.config);
  }
}

// ============================================================================
// Singleton
// ============================================================================

/**
 * Module-level singleton exporter, initialized from environment variables.
 *
 * WHY: Most callers should use this singleton rather than instantiating their
 * own exporter to avoid creating multiple WebSocket connections to the backend.
 * Test code should instantiate OtelExporter directly with a mock config.
 *
 * @example
 * import { otelExporter } from '@/telemetry/otel-exporter';
 * await otelExporter.exportSession(metrics);
 */
export const otelExporter = new OtelExporter();
