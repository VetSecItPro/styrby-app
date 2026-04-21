/**
 * Tests for lib/otel-config.ts
 *
 * WHY: OTEL config is user-managed and involves URL/header validation.
 * Regressions in validateOtelConfig() could accept malformed endpoints,
 * allow empty service names, or accept unreasonably large timeouts — all
 * of which would produce useless env vars copied to the user's shell profile.
 */

import { describe, it, expect } from 'vitest';
import {
  defaultOtelConfig,
  validateOtelConfig,
  generateEnvVars,
  OTEL_PRESETS,
  type OtelUserConfig,
} from '../otel-config';

// ============================================================================
// defaultOtelConfig
// ============================================================================

describe('defaultOtelConfig', () => {
  it('returns a disabled config with safe defaults', () => {
    const cfg = defaultOtelConfig();
    expect(cfg.enabled).toBe(false);
    expect(cfg.endpoint).toBe('');
    expect(cfg.headers).toEqual({});
    expect(cfg.serviceName).toBe('styrby-cli');
    expect(cfg.timeoutMs).toBe(5000);
  });

  it('returns a new object on each call (no shared reference)', () => {
    const a = defaultOtelConfig();
    const b = defaultOtelConfig();
    expect(a).not.toBe(b);
  });
});

// ============================================================================
// validateOtelConfig
// ============================================================================

describe('validateOtelConfig', () => {
  const validConfig: OtelUserConfig = {
    enabled: true,
    endpoint: 'https://otlp-gateway-prod-us-east-0.grafana.net/otlp/v1/metrics',
    headers: { Authorization: 'Basic abc123' },
    serviceName: 'styrby-cli',
    timeoutMs: 5000,
  };

  it('returns isValid: true for a well-formed config', () => {
    const result = validateOtelConfig(validConfig);
    expect(result.isValid).toBe(true);
    expect(result.errors).toEqual({});
  });

  it('returns isValid: true when disabled (endpoint not required)', () => {
    const result = validateOtelConfig({ ...validConfig, enabled: false, endpoint: '' });
    expect(result.isValid).toBe(true);
  });

  it('requires endpoint when enabled', () => {
    const result = validateOtelConfig({ ...validConfig, endpoint: '' });
    expect(result.isValid).toBe(false);
    expect(result.errors.endpoint).toBeTruthy();
  });

  it('rejects endpoint not starting with http:// or https://', () => {
    const result = validateOtelConfig({ ...validConfig, endpoint: 'ftp://bad.endpoint/v1/metrics' });
    expect(result.isValid).toBe(false);
    expect(result.errors.endpoint).toContain('http');
  });

  it('rejects malformed URL as endpoint', () => {
    const result = validateOtelConfig({ ...validConfig, endpoint: 'https://' });
    expect(result.isValid).toBe(false);
    expect(result.errors.endpoint).toBeTruthy();
  });

  it('rejects empty serviceName', () => {
    const result = validateOtelConfig({ ...validConfig, serviceName: '   ' });
    expect(result.isValid).toBe(false);
    expect(result.errors.serviceName).toBeTruthy();
  });

  it('rejects serviceName exceeding 128 chars', () => {
    const result = validateOtelConfig({ ...validConfig, serviceName: 'x'.repeat(129) });
    expect(result.isValid).toBe(false);
    expect(result.errors.serviceName).toContain('128');
  });

  it('rejects timeoutMs below 1000', () => {
    const result = validateOtelConfig({ ...validConfig, timeoutMs: 500 });
    expect(result.isValid).toBe(false);
    expect(result.errors.timeoutMs).toContain('1000');
  });

  it('rejects timeoutMs above 30000', () => {
    const result = validateOtelConfig({ ...validConfig, timeoutMs: 30_001 });
    expect(result.isValid).toBe(false);
    expect(result.errors.timeoutMs).toContain('30,000');
  });

  it('accepts timeoutMs at the boundaries (1000 and 30000)', () => {
    expect(validateOtelConfig({ ...validConfig, timeoutMs: 1000 }).isValid).toBe(true);
    expect(validateOtelConfig({ ...validConfig, timeoutMs: 30000 }).isValid).toBe(true);
  });

  it('rejects non-integer timeoutMs', () => {
    const result = validateOtelConfig({ ...validConfig, timeoutMs: 2500.5 });
    expect(result.isValid).toBe(false);
  });

  it('does not validate optional fields when they are undefined', () => {
    // If serviceName / timeoutMs are not provided, no errors should fire for those fields
    const result = validateOtelConfig({ enabled: false });
    expect(result.errors.serviceName).toBeUndefined();
    expect(result.errors.timeoutMs).toBeUndefined();
  });
});

// ============================================================================
// generateEnvVars
// ============================================================================

describe('generateEnvVars', () => {
  it('generates the correct shell exports', () => {
    const cfg: OtelUserConfig = {
      enabled: true,
      endpoint: 'https://api.honeycomb.io/v1/metrics',
      headers: {},
      serviceName: 'my-service',
      timeoutMs: 8000,
    };

    const output = generateEnvVars(cfg);
    expect(output).toContain('export STYRBY_OTEL_ENABLED=true');
    expect(output).toContain('export STYRBY_OTEL_ENDPOINT="https://api.honeycomb.io/v1/metrics"');
    expect(output).toContain('export STYRBY_OTEL_SERVICE="my-service"');
    expect(output).toContain('export STYRBY_OTEL_TIMEOUT_MS="8000"');
  });

  it('includes STYRBY_OTEL_HEADERS when headers are present', () => {
    const cfg: OtelUserConfig = {
      enabled: true,
      endpoint: 'https://api.honeycomb.io/v1/metrics',
      headers: { 'X-Honeycomb-Team': 'my-key' },
      serviceName: 'styrby-cli',
      timeoutMs: 5000,
    };

    const output = generateEnvVars(cfg);
    expect(output).toContain('STYRBY_OTEL_HEADERS');
    expect(output).toContain('X-Honeycomb-Team');
  });

  it('omits STYRBY_OTEL_HEADERS line when headers are empty', () => {
    const cfg: OtelUserConfig = {
      enabled: false,
      endpoint: '',
      headers: {},
      serviceName: 'styrby-cli',
      timeoutMs: 5000,
    };

    const output = generateEnvVars(cfg);
    expect(output).not.toContain('STYRBY_OTEL_HEADERS');
  });

  it('outputs false for disabled config', () => {
    const cfg: OtelUserConfig = { ...defaultOtelConfig(), enabled: false };
    const output = generateEnvVars(cfg);
    expect(output).toContain('STYRBY_OTEL_ENABLED=false');
  });
});

// ============================================================================
// OTEL_PRESETS
// ============================================================================

describe('OTEL_PRESETS', () => {
  it('contains at least 4 presets', () => {
    expect(OTEL_PRESETS.length).toBeGreaterThanOrEqual(4);
  });

  it('each preset has required fields', () => {
    for (const preset of OTEL_PRESETS) {
      expect(preset.id).toBeTruthy();
      expect(preset.name).toBeTruthy();
      expect(typeof preset.endpoint).toBe('string');
      expect(preset.headersTemplate).toBeDefined();
      expect(preset.helpText).toBeTruthy();
      expect(preset.docsUrl).toMatch(/^https?:\/\//);
    }
  });

  it('includes Grafana Cloud, Datadog, and Honeycomb presets', () => {
    const ids = OTEL_PRESETS.map((p) => p.id);
    expect(ids).toContain('grafana-cloud');
    expect(ids).toContain('datadog');
    expect(ids).toContain('honeycomb');
  });

  it('includes a custom preset with empty endpoint', () => {
    const custom = OTEL_PRESETS.find((p) => p.id === 'custom');
    expect(custom).toBeDefined();
    expect(custom!.endpoint).toBe('');
  });
});
