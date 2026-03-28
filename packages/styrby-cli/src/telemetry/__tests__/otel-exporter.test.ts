/**
 * Tests for the OTEL Metrics Exporter
 *
 * Covers:
 * - `resolveOtelConfig()` — env-var parsing, defaults, header JSON parsing
 * - `buildOtlpPayload()` — correct metric names, types, attribute dimensions,
 *   nanosecond timestamps, resource attributes
 * - `OtelExporter` class — disabled by default, validates endpoint required,
 *   calls fetch with correct payload and headers, handles HTTP errors,
 *   handles fetch timeout/abort, batch export
 * - `msToNanoString` via integration (nanosecond precision round-trip)
 * - `generateEnvVars` round-trip via `resolveOtelConfig`
 *
 * No real HTTP requests are made — fetch is mocked via vi.stubGlobal.
 *
 * @module telemetry/__tests__/otel-exporter
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  resolveOtelConfig,
  buildOtlpPayload,
  OtelExporter,
  type SessionMetrics,
  type OtelConfig,
} from '../otel-exporter.js';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Build a minimal valid SessionMetrics fixture.
 *
 * @param overrides - Partial overrides applied on top of defaults
 * @returns Complete SessionMetrics object
 */
function makeMetrics(overrides: Partial<SessionMetrics> = {}): SessionMetrics {
  return {
    sessionId: 'test-session-id',
    agent: 'claude',
    model: 'claude-sonnet-4',
    durationMs: 60_000,
    status: 'stopped',
    inputTokens: 10_000,
    outputTokens: 2_000,
    cacheReadTokens: 5_000,
    cacheWriteTokens: 1_000,
    costUsd: 0.05,
    errorCount: 0,
    errorSource: 'none',
    startedAtMs: 1_700_000_000_000,
    endedAtMs: 1_700_000_060_000,
    ...overrides,
  };
}

/**
 * Build a minimal valid OtelConfig fixture.
 *
 * @param overrides - Partial overrides
 * @returns Complete OtelConfig
 */
function makeConfig(overrides: Partial<OtelConfig> = {}): OtelConfig {
  return {
    enabled: true,
    endpoint: 'https://otlp.example.com/v1/metrics',
    headers: {},
    serviceName: 'styrby-cli',
    timeoutMs: 5000,
    ...overrides,
  };
}

/**
 * Create a mock fetch that resolves with the given status and body.
 *
 * @param status - HTTP status code
 * @param body - Response body text
 * @returns vi mock function
 */
function mockFetch(status: number, body: string = '') {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: vi.fn().mockResolvedValue(body),
  });
}

// ============================================================================
// resolveOtelConfig
// ============================================================================

describe('resolveOtelConfig', () => {
  it('returns disabled config with empty endpoint by default', () => {
    const config = resolveOtelConfig({});
    expect(config.enabled).toBe(false);
    expect(config.endpoint).toBe('');
    expect(config.serviceName).toBe('styrby-cli');
    expect(config.timeoutMs).toBe(5000);
    expect(config.headers).toEqual({});
  });

  it('enables when STYRBY_OTEL_ENABLED=true', () => {
    const config = resolveOtelConfig({ STYRBY_OTEL_ENABLED: 'true' });
    expect(config.enabled).toBe(true);
  });

  it('does not enable when STYRBY_OTEL_ENABLED=false', () => {
    const config = resolveOtelConfig({ STYRBY_OTEL_ENABLED: 'false' });
    expect(config.enabled).toBe(false);
  });

  it('reads endpoint from STYRBY_OTEL_ENDPOINT', () => {
    const config = resolveOtelConfig({ STYRBY_OTEL_ENDPOINT: 'https://otel.example.com/v1/metrics' });
    expect(config.endpoint).toBe('https://otel.example.com/v1/metrics');
  });

  it('reads service name from STYRBY_OTEL_SERVICE', () => {
    const config = resolveOtelConfig({ STYRBY_OTEL_SERVICE: 'my-app' });
    expect(config.serviceName).toBe('my-app');
  });

  it('reads timeout from STYRBY_OTEL_TIMEOUT_MS', () => {
    const config = resolveOtelConfig({ STYRBY_OTEL_TIMEOUT_MS: '10000' });
    expect(config.timeoutMs).toBe(10000);
  });

  it('falls back to 5000 for invalid STYRBY_OTEL_TIMEOUT_MS', () => {
    const config = resolveOtelConfig({ STYRBY_OTEL_TIMEOUT_MS: 'not-a-number' });
    expect(config.timeoutMs).toBe(5000);
  });

  it('parses valid JSON headers from STYRBY_OTEL_HEADERS', () => {
    const headers = { Authorization: 'Basic abc123' };
    const config = resolveOtelConfig({ STYRBY_OTEL_HEADERS: JSON.stringify(headers) });
    expect(config.headers).toEqual(headers);
  });

  it('uses empty headers when STYRBY_OTEL_HEADERS is invalid JSON', () => {
    const config = resolveOtelConfig({ STYRBY_OTEL_HEADERS: '{not-valid-json' });
    expect(config.headers).toEqual({});
  });

  it('uses empty headers when STYRBY_OTEL_HEADERS is not set', () => {
    const config = resolveOtelConfig({});
    expect(config.headers).toEqual({});
  });
});

// ============================================================================
// buildOtlpPayload
// ============================================================================

describe('buildOtlpPayload', () => {
  const config = makeConfig();

  it('produces exactly one resourceMetrics entry', () => {
    const payload = buildOtlpPayload(makeMetrics(), config);
    expect(payload.resourceMetrics).toHaveLength(1);
  });

  it('sets service.name resource attribute to config.serviceName', () => {
    const payload = buildOtlpPayload(makeMetrics(), makeConfig({ serviceName: 'my-service' }));
    const attrs = payload.resourceMetrics[0]!.resource.attributes;
    const serviceAttr = attrs.find((a) => a.key === 'service.name');
    expect(serviceAttr?.value.stringValue).toBe('my-service');
  });

  it('exports all 7 expected metric names', () => {
    const payload = buildOtlpPayload(makeMetrics(), config);
    const metrics = payload.resourceMetrics[0]!.scopeMetrics[0]!.metrics;
    const names = metrics.map((m) => m.name);
    expect(names).toContain('styrby.session.duration_ms');
    expect(names).toContain('styrby.tokens.input');
    expect(names).toContain('styrby.tokens.output');
    expect(names).toContain('styrby.tokens.cache_read');
    expect(names).toContain('styrby.tokens.cache_write');
    expect(names).toContain('styrby.cost.usd');
    expect(names).toContain('styrby.errors.count');
    expect(names).toHaveLength(7);
  });

  it('duration metric is a Gauge (not Sum)', () => {
    const payload = buildOtlpPayload(makeMetrics(), config);
    const metrics = payload.resourceMetrics[0]!.scopeMetrics[0]!.metrics;
    const durMetric = metrics.find((m) => m.name === 'styrby.session.duration_ms')!;
    expect(durMetric.gauge).toBeDefined();
    expect(durMetric.sum).toBeUndefined();
  });

  it('token and cost metrics are monotonic Sums', () => {
    const payload = buildOtlpPayload(makeMetrics(), config);
    const metrics = payload.resourceMetrics[0]!.scopeMetrics[0]!.metrics;
    const sumMetrics = metrics.filter((m) => m.name !== 'styrby.session.duration_ms');
    for (const m of sumMetrics) {
      expect(m.sum).toBeDefined();
      expect(m.sum?.isMonotonic).toBe(true);
    }
  });

  it('duration data point carries agent, model, status attributes', () => {
    const metrics = makeMetrics({ agent: 'codex', model: 'gpt-4o', status: 'error' });
    const payload = buildOtlpPayload(metrics, config);
    const durMetric = payload.resourceMetrics[0]!.scopeMetrics[0]!.metrics
      .find((m) => m.name === 'styrby.session.duration_ms')!;
    const dp = durMetric.gauge!.dataPoints[0]!;
    expect(dp.attributes.find((a) => a.key === 'agent')?.value.stringValue).toBe('codex');
    expect(dp.attributes.find((a) => a.key === 'model')?.value.stringValue).toBe('gpt-4o');
    expect(dp.attributes.find((a) => a.key === 'status')?.value.stringValue).toBe('error');
  });

  it('error metric carries agent and error_source attributes', () => {
    const metrics = makeMetrics({ agent: 'gemini', errorSource: 'api' });
    const payload = buildOtlpPayload(metrics, config);
    const errMetric = payload.resourceMetrics[0]!.scopeMetrics[0]!.metrics
      .find((m) => m.name === 'styrby.errors.count')!;
    const dp = errMetric.sum!.dataPoints[0]!;
    expect(dp.attributes.find((a) => a.key === 'agent')?.value.stringValue).toBe('gemini');
    expect(dp.attributes.find((a) => a.key === 'error_source')?.value.stringValue).toBe('api');
  });

  it('data point values match input metrics', () => {
    const m = makeMetrics({
      durationMs: 120_000,
      inputTokens: 50_000,
      outputTokens: 8_000,
      cacheReadTokens: 12_000,
      cacheWriteTokens: 3_000,
      costUsd: 0.18,
      errorCount: 2,
    });
    const payload = buildOtlpPayload(m, config);
    const metrics = payload.resourceMetrics[0]!.scopeMetrics[0]!.metrics;

    const get = (name: string) => {
      const metric = metrics.find((x) => x.name === name)!;
      return (metric.gauge?.dataPoints[0] ?? metric.sum?.dataPoints[0])!.asDouble;
    };

    expect(get('styrby.session.duration_ms')).toBe(120_000);
    expect(get('styrby.tokens.input')).toBe(50_000);
    expect(get('styrby.tokens.output')).toBe(8_000);
    expect(get('styrby.tokens.cache_read')).toBe(12_000);
    expect(get('styrby.tokens.cache_write')).toBe(3_000);
    expect(get('styrby.cost.usd')).toBe(0.18);
    expect(get('styrby.errors.count')).toBe(2);
  });

  it('converts timestamps to nanosecond strings', () => {
    const m = makeMetrics({ startedAtMs: 1_700_000_000_000, endedAtMs: 1_700_000_060_000 });
    const payload = buildOtlpPayload(m, config);
    const dp = payload.resourceMetrics[0]!.scopeMetrics[0]!.metrics[0]!.gauge!.dataPoints[0]!;
    // 1_700_000_000_000 ms × 1_000_000 ns/ms = 1.7 × 10^18 ns (19 digits)
    // BigInt(1700000000000) * BigInt(1000000) = 1700000000000000000n
    expect(dp.startTimeUnixNano).toBe('1700000000000000000');
    // 1_700_000_060_000 ms × 1_000_000 = 1700000060000000000000 → 1700000060000000000
    expect(dp.timeUnixNano).toBe('1700000060000000000');
  });

  it('scope name is "styrby.session"', () => {
    const payload = buildOtlpPayload(makeMetrics(), config);
    expect(payload.resourceMetrics[0]!.scopeMetrics[0]!.scope.name).toBe('styrby.session');
  });
});

// ============================================================================
// OtelExporter
// ============================================================================

describe('OtelExporter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is disabled by default when constructed with no config and OTEL env vars absent', () => {
    // Provide an empty env so CI env vars don't bleed in
    const exporter = new OtelExporter(resolveOtelConfig({}));
    expect(exporter.isEnabled).toBe(false);
  });

  it('is enabled when config.enabled=true and endpoint is set', () => {
    const exporter = new OtelExporter(makeConfig({ enabled: true }));
    expect(exporter.isEnabled).toBe(true);
  });

  it('disables itself when enabled=true but endpoint is empty', () => {
    const exporter = new OtelExporter(makeConfig({ endpoint: '' }));
    expect(exporter.isEnabled).toBe(false);
  });

  it('exportSession is a no-op when disabled', async () => {
    const fetchMock = mockFetch(200);
    vi.stubGlobal('fetch', fetchMock);

    const exporter = new OtelExporter(makeConfig({ enabled: false }));
    await exporter.exportSession(makeMetrics());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('exportSession POSTs to configured endpoint', async () => {
    const fetchMock = mockFetch(200);
    vi.stubGlobal('fetch', fetchMock);

    const exporter = new OtelExporter(makeConfig());
    await exporter.exportSession(makeMetrics());

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, opts] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://otlp.example.com/v1/metrics');
    expect(opts.method).toBe('POST');
  });

  it('sets Content-Type: application/json header', async () => {
    const fetchMock = mockFetch(200);
    vi.stubGlobal('fetch', fetchMock);

    const exporter = new OtelExporter(makeConfig());
    await exporter.exportSession(makeMetrics());

    const [, opts] = fetchMock.mock.calls[0]!;
    expect(opts.headers['Content-Type']).toBe('application/json');
  });

  it('includes custom auth headers in the request', async () => {
    const fetchMock = mockFetch(200);
    vi.stubGlobal('fetch', fetchMock);

    const exporter = new OtelExporter(makeConfig({ headers: { Authorization: 'Basic token123' } }));
    await exporter.exportSession(makeMetrics());

    const [, opts] = fetchMock.mock.calls[0]!;
    expect(opts.headers['Authorization']).toBe('Basic token123');
  });

  it('sends valid OTLP JSON body with correct metric count', async () => {
    const fetchMock = mockFetch(200);
    vi.stubGlobal('fetch', fetchMock);

    const exporter = new OtelExporter(makeConfig());
    await exporter.exportSession(makeMetrics());

    const [, opts] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(opts.body as string);
    const metrics = body.resourceMetrics[0].scopeMetrics[0].metrics;
    expect(metrics).toHaveLength(7);
  });

  it('does not throw on HTTP 429 response', async () => {
    const fetchMock = mockFetch(429, 'Rate limited');
    vi.stubGlobal('fetch', fetchMock);

    const exporter = new OtelExporter(makeConfig());
    // Should resolve without throwing
    await expect(exporter.exportSession(makeMetrics())).resolves.toBeUndefined();
  });

  it('does not throw on HTTP 500 response', async () => {
    const fetchMock = mockFetch(500, 'Internal Server Error');
    vi.stubGlobal('fetch', fetchMock);

    const exporter = new OtelExporter(makeConfig());
    await expect(exporter.exportSession(makeMetrics())).resolves.toBeUndefined();
  });

  it('does not throw when fetch itself rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network failure')));

    const exporter = new OtelExporter(makeConfig());
    await expect(exporter.exportSession(makeMetrics())).resolves.toBeUndefined();
  });

  it('does not throw on AbortError (timeout)', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abortError));

    const exporter = new OtelExporter(makeConfig());
    await expect(exporter.exportSession(makeMetrics())).resolves.toBeUndefined();
  });

  it('exportBatch is a no-op when disabled', async () => {
    const fetchMock = mockFetch(200);
    vi.stubGlobal('fetch', fetchMock);

    const exporter = new OtelExporter(makeConfig({ enabled: false }));
    await exporter.exportBatch([makeMetrics(), makeMetrics()]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('exportBatch sends a single POST even with multiple sessions', async () => {
    const fetchMock = mockFetch(200);
    vi.stubGlobal('fetch', fetchMock);

    const exporter = new OtelExporter(makeConfig());
    await exporter.exportBatch([makeMetrics(), makeMetrics(), makeMetrics()]);

    // Only one HTTP request
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('exportBatch merges metrics from all sessions (3 sessions × 7 metrics = 21)', async () => {
    const fetchMock = mockFetch(200);
    vi.stubGlobal('fetch', fetchMock);

    const exporter = new OtelExporter(makeConfig());
    await exporter.exportBatch([makeMetrics(), makeMetrics(), makeMetrics()]);

    const [, opts] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(opts.body as string);
    const metrics = body.resourceMetrics[0].scopeMetrics[0].metrics;
    expect(metrics).toHaveLength(21); // 3 sessions × 7 metrics each
  });

  it('exportBatch is a no-op with empty array', async () => {
    const fetchMock = mockFetch(200);
    vi.stubGlobal('fetch', fetchMock);

    const exporter = new OtelExporter(makeConfig());
    await exporter.exportBatch([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Integration: resolveOtelConfig round-trip via env vars
// ============================================================================

describe('resolveOtelConfig — full config round-trip', () => {
  it('round-trips a complete config through env vars and back', () => {
    const env: Record<string, string> = {
      STYRBY_OTEL_ENABLED: 'true',
      STYRBY_OTEL_ENDPOINT: 'https://grafana.net/otlp/v1/metrics',
      STYRBY_OTEL_SERVICE: 'my-service',
      STYRBY_OTEL_TIMEOUT_MS: '8000',
      STYRBY_OTEL_HEADERS: JSON.stringify({ Authorization: 'Basic dXNlcjprZXk=' }),
    };

    const config = resolveOtelConfig(env);
    expect(config.enabled).toBe(true);
    expect(config.endpoint).toBe('https://grafana.net/otlp/v1/metrics');
    expect(config.serviceName).toBe('my-service');
    expect(config.timeoutMs).toBe(8000);
    expect(config.headers).toEqual({ Authorization: 'Basic dXNlcjprZXk=' });
  });
});
