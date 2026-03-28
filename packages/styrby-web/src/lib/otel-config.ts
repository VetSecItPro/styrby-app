/**
 * OTEL Configuration — Web Settings Module
 *
 * Provides types, validation, and Supabase persistence for per-user
 * OpenTelemetry export configuration.
 *
 * Users configure their OTLP endpoint and headers via the Settings page.
 * The configuration is stored in the `profiles` table under the
 * `otel_config` JSONB column (null when not configured).
 *
 * The CLI reads OTEL settings from environment variables (see otel-exporter.ts),
 * not from Supabase. This web module provides the UI for managing the config
 * that the user then copies to their shell profile or `.env`.
 *
 * @module lib/otel-config
 */

// ============================================================================
// Types
// ============================================================================

/**
 * User-facing OTEL configuration saved to Supabase profiles.
 *
 * WHY: Storing the config in Supabase lets the user manage it via the web
 * dashboard and syncs it across machines (the user copies the generated
 * env vars to each machine). We never auto-apply the config to the CLI
 * because CLI env vars are the authoritative source — the DB is just a
 * convenient form-backed storage.
 */
export interface OtelUserConfig {
  /**
   * Whether OTEL export is enabled for this user.
   * Corresponds to `STYRBY_OTEL_ENABLED=true` in the CLI.
   */
  enabled: boolean;

  /**
   * OTLP/HTTP endpoint URL.
   * Must end in `/v1/metrics` for standard OTLP collectors.
   * Example: `https://otlp-gateway-prod-us-east-0.grafana.net/otlp/v1/metrics`
   */
  endpoint: string;

  /**
   * Optional HTTP headers for authentication (e.g., Grafana Cloud API key).
   * Stored as a JSON object. Example: `{"Authorization": "Basic <b64-token>"}`.
   *
   * WHY: Headers contain secrets. We store them here to populate the settings
   * form but never log or expose them. The user is responsible for keeping
   * their Supabase row secure (it's protected by RLS).
   */
  headers: Record<string, string>;

  /**
   * Service name to use as the OTLP `service.name` resource attribute.
   * Defaults to 'styrby-cli'. Teams can set this per machine if needed.
   */
  serviceName: string;

  /**
   * HTTP request timeout in milliseconds for export calls.
   * Defaults to 5000ms.
   */
  timeoutMs: number;
}

/**
 * Validation result for an OtelUserConfig.
 */
export interface OtelConfigValidation {
  /** Whether the config passes all validation checks */
  isValid: boolean;
  /** Field-level error messages (empty when isValid is true) */
  errors: Record<string, string>;
}

// ============================================================================
// Defaults
// ============================================================================

/**
 * Default OTEL configuration for new users.
 *
 * @returns A fresh OtelUserConfig with safe defaults
 */
export function defaultOtelConfig(): OtelUserConfig {
  return {
    enabled: false,
    endpoint: '',
    headers: {},
    serviceName: 'styrby-cli',
    timeoutMs: 5000,
  };
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Validate an OtelUserConfig and return field-level error messages.
 *
 * WHY: Client-side validation gives instant feedback before the user
 * saves. The same rules are enforced server-side in the settings API route
 * so there is no way to persist an invalid config.
 *
 * @param config - The config to validate
 * @returns Validation result with isValid flag and field errors
 *
 * @example
 * const result = validateOtelConfig(config);
 * if (!result.isValid) {
 *   console.error(result.errors); // { endpoint: 'Endpoint must start with http://' }
 * }
 */
export function validateOtelConfig(config: Partial<OtelUserConfig>): OtelConfigValidation {
  const errors: Record<string, string> = {};

  // Endpoint is required when enabled
  if (config.enabled) {
    if (!config.endpoint || config.endpoint.trim() === '') {
      errors['endpoint'] = 'Endpoint URL is required when OTEL export is enabled';
    } else {
      const trimmed = config.endpoint.trim();
      if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
        errors['endpoint'] = 'Endpoint must start with http:// or https://';
      } else {
        try {
          new URL(trimmed);
        } catch {
          errors['endpoint'] = 'Endpoint must be a valid URL';
        }
      }
    }
  }

  // Service name must be non-empty
  if (config.serviceName !== undefined) {
    if (config.serviceName.trim() === '') {
      errors['serviceName'] = 'Service name cannot be empty';
    } else if (config.serviceName.length > 128) {
      errors['serviceName'] = 'Service name must be 128 characters or fewer';
    }
  }

  // Timeout must be a positive integer within reason
  if (config.timeoutMs !== undefined) {
    if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1000) {
      errors['timeoutMs'] = 'Timeout must be at least 1000ms';
    } else if (config.timeoutMs > 30_000) {
      errors['timeoutMs'] = 'Timeout must be 30,000ms or less';
    }
  }

  return { isValid: Object.keys(errors).length === 0, errors };
}

// ============================================================================
// Env-var Generator
// ============================================================================

/**
 * Generate the shell environment variables for a given OTEL config.
 *
 * WHY: The user copies these env vars into their shell profile (`.zshrc`,
 * `.bashrc`, or a `.env` file) to activate OTEL export in the CLI.
 * Generating them in code ensures they are always in sync with the stored
 * config and eliminates copy-paste errors.
 *
 * @param config - The OTEL configuration to serialize
 * @returns Multi-line string of `export VAR=value` shell assignments
 *
 * @example
 * const envVars = generateEnvVars(config);
 * // "export STYRBY_OTEL_ENABLED=true\nexport STYRBY_OTEL_ENDPOINT=..."
 */
export function generateEnvVars(config: OtelUserConfig): string {
  const lines: string[] = [
    `export STYRBY_OTEL_ENABLED=${config.enabled ? 'true' : 'false'}`,
    `export STYRBY_OTEL_ENDPOINT="${config.endpoint}"`,
    `export STYRBY_OTEL_SERVICE="${config.serviceName}"`,
    `export STYRBY_OTEL_TIMEOUT_MS="${config.timeoutMs}"`,
  ];

  if (Object.keys(config.headers).length > 0) {
    // Serialize headers as a single-line JSON string, escaped for shell safety
    const headersJson = JSON.stringify(config.headers).replace(/"/g, '\\"');
    lines.push(`export STYRBY_OTEL_HEADERS="${headersJson}"`);
  }

  return lines.join('\n');
}

// ============================================================================
// Preset Templates
// ============================================================================

/**
 * A named OTLP backend preset for common providers.
 *
 * Presets pre-fill the endpoint URL and required headers template
 * so users can get started without reading provider docs.
 */
export interface OtelPreset {
  /** Display name shown in the preset dropdown */
  name: string;
  /** Short identifier used as the option value */
  id: string;
  /** Pre-filled endpoint URL */
  endpoint: string;
  /**
   * Headers template with placeholder values.
   * Keys with values like '<YOUR_KEY>' need to be filled in by the user.
   */
  headersTemplate: Record<string, string>;
  /** Help text shown below the preset dropdown */
  helpText: string;
  /** URL to the provider's OTLP documentation */
  docsUrl: string;
}

/**
 * Built-in presets for common OTLP backends.
 *
 * WHY: Most users use Grafana Cloud or Datadog. Providing pre-configured
 * presets eliminates the most common support questions about endpoint URLs
 * and header formats.
 */
export const OTEL_PRESETS: OtelPreset[] = [
  {
    id: 'grafana-cloud',
    name: 'Grafana Cloud',
    endpoint: 'https://otlp-gateway-prod-us-east-0.grafana.net/otlp/v1/metrics',
    headersTemplate: { Authorization: 'Basic <BASE64_INSTANCE_ID:API_KEY>' },
    helpText: 'Find your instance ID and API key at grafana.com/orgs → Access Policies.',
    docsUrl: 'https://grafana.com/docs/grafana-cloud/monitor-applications/application-observability/collector/opentelemetry-collector/',
  },
  {
    id: 'datadog',
    name: 'Datadog',
    endpoint: 'https://api.datadoghq.com/api/intake/otlp/v1/metrics',
    headersTemplate: { 'DD-API-KEY': '<YOUR_DATADOG_API_KEY>' },
    helpText: 'Find your API key at app.datadoghq.com → Organization Settings → API Keys.',
    docsUrl: 'https://docs.datadoghq.com/opentelemetry/interoperability/otlp_ingest_in_the_agent/',
  },
  {
    id: 'honeycomb',
    name: 'Honeycomb',
    endpoint: 'https://api.honeycomb.io/v1/metrics',
    headersTemplate: { 'X-Honeycomb-Team': '<YOUR_API_KEY>' },
    helpText: 'Find your API key at ui.honeycomb.io → Environment Settings.',
    docsUrl: 'https://docs.honeycomb.io/send-data/opentelemetry/',
  },
  {
    id: 'new-relic',
    name: 'New Relic',
    endpoint: 'https://otlp.nr-data.net/v1/metrics',
    headersTemplate: { 'api-key': '<YOUR_LICENSE_KEY>' },
    helpText: 'Use your New Relic license key (not API key) from Account Settings.',
    docsUrl: 'https://docs.newrelic.com/docs/opentelemetry/get-started/opentelemetry-introduction/',
  },
  {
    id: 'custom',
    name: 'Custom',
    endpoint: '',
    headersTemplate: {},
    helpText: 'Enter your OTLP/HTTP endpoint URL ending in /v1/metrics.',
    docsUrl: 'https://opentelemetry.io/docs/specs/otlp/',
  },
];
