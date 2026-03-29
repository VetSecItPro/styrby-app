/**
 * OTEL Configuration - Mobile Settings Module
 *
 * Types, validation, and preset templates for per-user OpenTelemetry export
 * configuration in the mobile app. Mirrors the web otel-config module so
 * both platforms share the same rules.
 *
 * Configuration is stored in `agent_configs.otel_config` JSONB column.
 *
 * @module src/lib/otel-config
 */

// ============================================================================
// Types
// ============================================================================

/**
 * User-facing OTEL configuration saved to Supabase agent_configs.
 *
 * WHY: Storing the config in Supabase lets the user manage it from the mobile
 * app and the web dashboard. The CLI reads OTEL settings from env vars — the
 * DB is a convenient form-backed store that the user copies to their shell profile.
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
   * WHY: Headers contain secrets. Stored here to populate the form but never
   * logged or exposed. Protected by Supabase RLS on the agent_configs table.
   */
  headers: Record<string, string>;

  /**
   * Service name to use as the OTLP `service.name` resource attribute.
   * Defaults to 'styrby-cli'.
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

/**
 * A named OTLP backend preset for common providers.
 * Presets pre-fill the endpoint URL and required headers template.
 */
export interface OtelPreset {
  /** Display name shown in the preset picker */
  name: string;
  /** Short identifier used as the option value */
  id: string;
  /** Pre-filled endpoint URL */
  endpoint: string;
  /**
   * Headers template with placeholder values.
   * Keys with values like '<YOUR_KEY>' must be filled in by the user.
   */
  headersTemplate: Record<string, string>;
  /** Help text shown below the preset picker */
  helpText: string;
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
 * WHY: Client-side validation gives instant feedback before the user saves.
 * The same rules are enforced on the web dashboard to ensure consistency.
 *
 * @param config - The config to validate
 * @returns Validation result with isValid flag and field errors
 *
 * @example
 * const result = validateOtelConfig(config);
 * if (!result.isValid) {
 *   console.error(result.errors); // { endpoint: 'Endpoint must start with https://' }
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

  // Service name must be non-empty and within length limit
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
// Preset Templates
// ============================================================================

/**
 * Built-in presets for common OTLP backends.
 *
 * WHY: Most users use Grafana Cloud or Datadog. Pre-configured presets
 * eliminate the most common support questions about endpoint URLs and headers.
 */
export const OTEL_PRESETS: OtelPreset[] = [
  {
    id: 'grafana-cloud',
    name: 'Grafana Cloud',
    endpoint: 'https://otlp-gateway-prod-us-east-0.grafana.net/otlp/v1/metrics',
    headersTemplate: { Authorization: 'Basic <BASE64_INSTANCE_ID:API_KEY>' },
    helpText:
      'Find your instance ID and API key at grafana.com/orgs → Access Policies.',
  },
  {
    id: 'datadog',
    name: 'Datadog',
    endpoint: 'https://api.datadoghq.com/api/intake/otlp/v1/metrics',
    headersTemplate: { 'DD-API-KEY': '<YOUR_DATADOG_API_KEY>' },
    helpText:
      'Find your API key at app.datadoghq.com → Organization Settings → API Keys.',
  },
  {
    id: 'honeycomb',
    name: 'Honeycomb',
    endpoint: 'https://api.honeycomb.io/v1/metrics',
    headersTemplate: { 'X-Honeycomb-Team': '<YOUR_API_KEY>' },
    helpText: 'Find your API key at ui.honeycomb.io → Environment Settings.',
  },
  {
    id: 'new-relic',
    name: 'New Relic',
    endpoint: 'https://otlp.nr-data.net/v1/metrics',
    headersTemplate: { 'api-key': '<YOUR_LICENSE_KEY>' },
    helpText:
      'Use your New Relic license key (not API key) from Account Settings.',
  },
  {
    id: 'custom',
    name: 'Custom',
    endpoint: '',
    headersTemplate: {},
    helpText: 'Enter your OTLP/HTTP endpoint URL ending in /v1/metrics.',
  },
];
