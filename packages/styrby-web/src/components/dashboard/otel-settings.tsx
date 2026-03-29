'use client';

/**
 * OtelSettings Component
 *
 * Settings panel for configuring OpenTelemetry metrics export.
 * Lets users enable/disable OTEL, set an OTLP endpoint, add auth headers,
 * and copy the generated environment variables to use with the CLI.
 *
 * This is an enterprise/power-user feature. The section is visually separated
 * from other settings with a clear "Metrics Export" heading and a "Pro" badge.
 *
 * @module components/dashboard/otel-settings
 */

import { useState, useCallback, useEffect } from 'react';
import {
  type OtelUserConfig,
  type OtelPreset,
  defaultOtelConfig,
  validateOtelConfig,
  generateEnvVars,
  OTEL_PRESETS,
} from '@/lib/otel-config';
import { createClient } from '@/lib/supabase/client';

// ============================================================================
// Types
// ============================================================================

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
   * Initial OTEL config loaded from Supabase profiles row.
   * null when the user has never configured OTEL before.
   */
  initialConfig: OtelUserConfig | null;
}

// ============================================================================
// Header Row Component
// ============================================================================

/**
 * Renders a settings row with a label, description, and interactive control.
 *
 * @param label - Setting name
 * @param description - Short explanation
 * @param children - The form control (input, toggle, etc.)
 */
function SettingRow({
  label,
  description,
  error,
  children,
}: {
  label: string;
  description?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-sm font-medium text-foreground">{label}</label>
      {description && <p className="text-xs text-muted-foreground">{description}</p>}
      {children}
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}

// ============================================================================
// Toggle Component
// ============================================================================

/**
 * Simple accessible toggle switch.
 *
 * @param checked - Whether the toggle is on
 * @param onChange - Callback when toggled
 * @param disabled - Whether the toggle is disabled
 * @param label - Accessible label for screen readers
 */
function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1 disabled:opacity-50 disabled:cursor-not-allowed ${
        checked ? 'bg-emerald-500' : 'bg-zinc-700'
      }`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-[18px]' : 'translate-x-1'
        }`}
      />
    </button>
  );
}

// ============================================================================
// Main Component
// ============================================================================

/**
 * OTEL metrics export settings panel.
 *
 * Allows users to configure their OTLP endpoint, authenticate via headers,
 * and generate the environment variables needed to activate OTEL export
 * in the Styrby CLI.
 *
 * @param props - Component props
 *
 * @example
 * <OtelSettings isPowerTier={true} initialConfig={profile?.otel_config ?? null} />
 */
export function OtelSettings({ isPowerTier, initialConfig }: OtelSettingsProps) {
  const supabase = createClient();

  // ── Form state ──────────────────────────────────────────────────────────────

  const [config, setConfig] = useState<OtelUserConfig>(initialConfig ?? defaultOtelConfig());
  const [selectedPreset, setSelectedPreset] = useState<string>('custom');
  const [headersRaw, setHeadersRaw] = useState<string>(
    initialConfig?.headers && Object.keys(initialConfig.headers).length > 0
      ? JSON.stringify(initialConfig.headers, null, 2)
      : ''
  );
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState(false);

  // ── Preset Selection ────────────────────────────────────────────────────────

  /**
   * Apply a preset template to the config form.
   * Pre-fills the endpoint and headers template when the user picks a provider.
   *
   * @param presetId - The preset identifier
   */
  const applyPreset = useCallback((presetId: string) => {
    const preset = OTEL_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;

    setSelectedPreset(presetId);
    setConfig((prev) => ({
      ...prev,
      endpoint: preset.endpoint,
      headers: preset.headersTemplate,
    }));
    setHeadersRaw(
      Object.keys(preset.headersTemplate).length > 0
        ? JSON.stringify(preset.headersTemplate, null, 2)
        : ''
    );
  }, []);

  // ── Header Parsing ──────────────────────────────────────────────────────────

  /**
   * Parse the raw headers textarea value into a Record<string, string>.
   * Returns an empty object on parse errors (error shown via validation).
   */
  const parseHeaders = useCallback((raw: string): Record<string, string> => {
    if (!raw.trim()) return {};
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null) {
        return parsed as Record<string, string>;
      }
    } catch {
      // validation will surface this error
    }
    return {};
  }, []);

  // ── Save Handler ────────────────────────────────────────────────────────────

  /**
   * Validate and persist the OTEL config to Supabase.
   *
   * WHY: We validate client-side before saving to give instant feedback.
   * The Supabase upsert is on the `profiles` table `otel_config` JSONB column
   * which is protected by RLS (users can only write their own row).
   */
  const handleSave = useCallback(async () => {
    const parsedHeaders = parseHeaders(headersRaw);
    const fullConfig: OtelUserConfig = { ...config, headers: parsedHeaders };

    // Validate headers JSON separately (validateOtelConfig doesn't check JSON syntax)
    if (headersRaw.trim() && Object.keys(parsedHeaders).length === 0) {
      setValidationErrors({ headers: 'Headers must be a valid JSON object (e.g., {"Authorization": "Bearer ..."})' });
      return;
    }

    const validation = validateOtelConfig(fullConfig);
    if (!validation.isValid) {
      setValidationErrors(validation.errors);
      return;
    }

    setValidationErrors({});
    setSaving(true);
    setSaveMessage(null);

    try {
      const { error } = await supabase
        .from('profiles')
        .update({ otel_config: fullConfig })
        .eq('id', (await supabase.auth.getUser()).data.user?.id ?? '');

      if (error) throw error;

      setConfig(fullConfig);
      setSaveMessage({ type: 'success', text: 'OTEL configuration saved.' });
    } catch (err) {
      setSaveMessage({
        type: 'error',
        text: `Failed to save: ${err instanceof Error ? err.message : 'Unknown error'}`,
      });
    } finally {
      setSaving(false);
    }
  }, [config, headersRaw, parseHeaders, supabase]);

  // ── Env Vars Copy ───────────────────────────────────────────────────────────

  /**
   * Copy the generated env vars to the clipboard.
   */
  const handleCopyEnvVars = useCallback(async () => {
    const parsedHeaders = parseHeaders(headersRaw);
    const fullConfig: OtelUserConfig = { ...config, headers: parsedHeaders };
    const envVars = generateEnvVars(fullConfig);

    try {
      await navigator.clipboard.writeText(envVars);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API not available (non-HTTPS or denied permission)
    }
  }, [config, headersRaw, parseHeaders]);

  // ── Computed env vars preview ────────────────────────────────────────────────

  const parsedHeaders = parseHeaders(headersRaw);
  const envVarsPreview = generateEnvVars({ ...config, headers: parsedHeaders });
  const activePreset = OTEL_PRESETS.find((p) => p.id === selectedPreset);

  // ── Render ──────────────────────────────────────────────────────────────────

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
        <div className="rounded-lg border border-border/40 bg-zinc-950 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-border/40">
            <div>
              <p className="text-xs font-semibold text-foreground">Environment Variables</p>
              <p className="text-[11px] text-muted-foreground">
                Add these to your <code className="text-amber-400">~/.zshrc</code> or <code className="text-amber-400">.env</code> file on each machine.
              </p>
            </div>
            <button
              type="button"
              onClick={handleCopyEnvVars}
              className="rounded-md border border-border/60 px-2.5 py-1 text-xs font-medium text-muted-foreground hover:text-foreground hover:border-border transition-colors"
              aria-label="Copy environment variables to clipboard"
            >
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
          <pre className="px-4 py-3 text-[11px] text-emerald-400 font-mono overflow-x-auto whitespace-pre leading-relaxed">
            {envVarsPreview}
          </pre>
        </div>

        {/* Metrics Reference */}
        <details className="rounded-lg border border-border/40">
          <summary className="px-4 py-3 cursor-pointer text-sm font-medium text-foreground hover:text-muted-foreground transition-colors list-none flex items-center justify-between">
            Exported Metrics Reference
            <svg className="h-4 w-4 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </summary>
          <div className="px-4 pb-4 border-t border-border/40">
            <table className="w-full mt-3 text-xs">
              <thead>
                <tr className="text-muted-foreground">
                  <th className="text-left py-1.5 font-medium">Metric</th>
                  <th className="text-left py-1.5 font-medium">Type</th>
                  <th className="text-left py-1.5 font-medium">Attributes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/20">
                {[
                  { metric: 'styrby.session.duration_ms', type: 'Gauge', attrs: 'agent, model, status' },
                  { metric: 'styrby.tokens.input', type: 'Sum', attrs: 'agent, model' },
                  { metric: 'styrby.tokens.output', type: 'Sum', attrs: 'agent, model' },
                  { metric: 'styrby.tokens.cache_read', type: 'Sum', attrs: 'agent, model' },
                  { metric: 'styrby.tokens.cache_write', type: 'Sum', attrs: 'agent, model' },
                  { metric: 'styrby.cost.usd', type: 'Sum', attrs: 'agent, model' },
                  { metric: 'styrby.errors.count', type: 'Sum', attrs: 'agent, error_source' },
                ].map((row) => (
                  <tr key={row.metric}>
                    <td className="py-1.5 font-mono text-amber-400">{row.metric}</td>
                    <td className="py-1.5 text-muted-foreground">{row.type}</td>
                    <td className="py-1.5 text-muted-foreground">{row.attrs}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </div>
    </section>
  );
}
