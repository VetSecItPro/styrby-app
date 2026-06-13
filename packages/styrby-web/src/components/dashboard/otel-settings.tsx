'use client';

/**
 * OtelSettings Component
 *
 * Settings panel for configuring OpenTelemetry metrics export.
 * Lets users enable/disable OTEL, set an OTLP endpoint, add auth headers,
 * and copy the generated environment variables to use with the CLI.
 *
 * This is an enterprise/power-user feature. The section is visually separated
 * from other settings with a clear "Metrics Export" heading and a "Power" badge.
 *
 * Orchestrator only (Cluster A2 split): form state + save/copy/preset logic
 * live in `useOtelSettings`, header parsing in `parse-headers`, and the row /
 * toggle / env-vars / metrics-table pieces in their own sub-components.
 *
 * @module components/dashboard/otel-settings
 */

import { useOtelSettings } from './otel-settings/useOtelSettings';
import { SettingRow } from './otel-settings/SettingRow';
import { Toggle } from './otel-settings/Toggle';
import { EnvVarsPanel } from './otel-settings/EnvVarsPanel';
import { MetricsReference } from './otel-settings/MetricsReference';
import { OTEL_PRESETS, type OtelUserConfig } from '@/lib/otel-config';

/**
 * Props for the OtelSettings component.
 */
export interface OtelSettingsProps {
  /**
   * Whether the current user is on the Power tier.
   * OTEL export is a Power-only feature - Pro and Free users see the section
   * in a disabled/blurred state with an upgrade prompt.
   *
   * WHY Power-only: OTEL export to external observability platforms (Grafana,
   * Datadog, Honeycomb) is an advanced infrastructure feature targeted at
   * teams and power users. It is listed as Power-only in the TIERS config.
   */
  isPowerTier: boolean;

  /**
   * Initial OTEL config loaded from the Supabase profiles row.
   * null when the user has never configured OTEL before.
   */
  initialConfig: OtelUserConfig | null;
}

/**
 * OTEL metrics export settings panel.
 *
 * Allows users to configure their OTLP endpoint, authenticate via headers,
 * and generate the environment variables needed to activate OTEL export
 * in the Styrby CLI.
 *
 * @param props - Component props.
 *
 * @example
 * <OtelSettings isPowerTier={true} initialConfig={profile?.otel_config ?? null} />
 */
export function OtelSettings({ isPowerTier, initialConfig }: OtelSettingsProps) {
  const {
    config,
    setConfig,
    selectedPreset,
    headersRaw,
    setHeadersRaw,
    saving,
    saveMessage,
    validationErrors,
    copied,
    applyPreset,
    handleSave,
    handleCopyEnvVars,
    envVarsPreview,
    activePreset,
  } = useOtelSettings(initialConfig);

  return (
    <section aria-labelledby="otel-settings-heading">
      {/* Section header */}
      <div className="flex items-center gap-2 mb-4">
        <h2 id="otel-settings-heading" className="text-base font-semibold text-foreground">
          Metrics Export (OTEL)
        </h2>
        <span className="inline-flex items-center rounded-full bg-purple-500/10 border border-purple-500/20 px-2 py-0.5 text-[10px] font-semibold text-purple-400 uppercase tracking-wider">
          Power
        </span>
      </div>
      <p className="text-sm text-muted-foreground mb-6">
        Export session metrics to Grafana, Datadog, or any OpenTelemetry-compatible backend.
        Configure your endpoint below, then copy the generated env vars into your shell profile.
      </p>

      {!isPowerTier && (
        <div className="rounded-lg border border-purple-500/20 bg-purple-500/5 p-4 mb-6">
          <p className="text-sm text-purple-400">
            OTEL metrics export is available on the Power plan.{' '}
            <a href="/pricing" className="underline hover:no-underline">
              Upgrade to Power
            </a>{' '}
            to enable.
          </p>
        </div>
      )}

      <div className={`space-y-5 ${!isPowerTier ? 'opacity-50 pointer-events-none select-none' : ''}`}>
        {/* Enable/Disable Toggle */}
        <div className="flex items-center justify-between rounded-lg border border-border/40 bg-card/60 px-4 py-3">
          <div>
            <p className="text-sm font-medium text-foreground">Enable OTEL Export</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Export session metrics to your configured OTLP endpoint.
            </p>
          </div>
          <Toggle
            checked={config.enabled}
            onChange={(v) => setConfig((prev) => ({ ...prev, enabled: v }))}
            disabled={!isPowerTier}
            label="Enable OTEL metrics export"
          />
        </div>

        {/* Provider Preset */}
        <SettingRow
          label="Provider Preset"
          description="Pre-fill the endpoint and headers for common OTLP backends."
        >
          <select
            value={selectedPreset}
            onChange={(e) => applyPreset(e.target.value)}
            className="w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-sm text-foreground focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring"
            aria-label="Select OTLP provider preset"
          >
            {OTEL_PRESETS.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.name}
              </option>
            ))}
          </select>
          {activePreset && activePreset.id !== 'custom' && (
            <p className="text-xs text-muted-foreground">
              {activePreset.helpText}{' '}
              <a
                href={activePreset.docsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-ring hover:underline"
              >
                View docs
              </a>
            </p>
          )}
        </SettingRow>

        {/* Endpoint URL */}
        <SettingRow
          label="OTLP Endpoint"
          description="Full URL to the OTLP/HTTP metrics endpoint (usually ends in /v1/metrics)."
          error={validationErrors['endpoint']}
        >
          <input
            type="url"
            value={config.endpoint}
            onChange={(e) => setConfig((prev) => ({ ...prev, endpoint: e.target.value }))}
            placeholder="https://otlp.example.com/v1/metrics"
            className="w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring font-mono"
            aria-label="OTLP endpoint URL"
          />
        </SettingRow>

        {/* Auth Headers */}
        <SettingRow
          label="Authentication Headers"
          description='JSON object of HTTP headers for authentication. Example: {"Authorization": "Bearer token"}'
          error={validationErrors['headers']}
        >
          <textarea
            value={headersRaw}
            onChange={(e) => setHeadersRaw(e.target.value)}
            placeholder={'{\n  "Authorization": "Bearer <token>"\n}'}
            rows={4}
            className="w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/40 focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring font-mono resize-none"
            aria-label="Authentication headers as JSON"
            spellCheck={false}
          />
        </SettingRow>

        {/* Service Name */}
        <SettingRow
          label="Service Name"
          description="The OTLP service.name resource attribute. Use a unique name per machine in multi-machine setups."
          error={validationErrors['serviceName']}
        >
          <input
            type="text"
            value={config.serviceName}
            onChange={(e) => setConfig((prev) => ({ ...prev, serviceName: e.target.value }))}
            placeholder="styrby-cli"
            className="w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring"
            aria-label="OTLP service name"
          />
        </SettingRow>

        {/* Timeout */}
        <SettingRow
          label="Export Timeout (ms)"
          description="Maximum time to wait for the OTLP backend to respond. Default: 5000ms."
          error={validationErrors['timeoutMs']}
        >
          <input
            type="number"
            value={config.timeoutMs}
            onChange={(e) => setConfig((prev) => ({ ...prev, timeoutMs: Number(e.target.value) }))}
            min={1000}
            max={30000}
            step={500}
            className="w-40 rounded-lg border border-border/60 bg-background px-3 py-2 text-sm text-foreground focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring"
            aria-label="OTLP export timeout in milliseconds"
          />
        </SettingRow>

        {/* Save Button */}
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="rounded-lg bg-foreground px-4 py-2 text-sm font-semibold text-background hover:opacity-90 disabled:opacity-50 transition-opacity"
          >
            {saving ? 'Saving...' : 'Save Configuration'}
          </button>
          {saveMessage && (
            <p className={`text-sm ${saveMessage.type === 'success' ? 'text-emerald-500' : 'text-red-400'}`}>
              {saveMessage.text}
            </p>
          )}
        </div>

        {/* Generated Env Vars */}
        <EnvVarsPanel envVars={envVarsPreview} copied={copied} onCopy={handleCopyEnvVars} />

        {/* Metrics Reference */}
        <MetricsReference />
      </div>
    </section>
  );
}
