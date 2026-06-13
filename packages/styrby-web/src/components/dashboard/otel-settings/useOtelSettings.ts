/**
 * useOtelSettings — form state + save/copy/preset logic for the OTEL panel.
 *
 * Extracted from otel-settings.tsx (Cluster A2 split). Owns the config form
 * state, the Supabase upsert, the preset application, and the env-var clipboard
 * copy. The component consumes the returned state and only renders.
 *
 * @module components/dashboard/otel-settings/useOtelSettings
 */

import { useState, useCallback } from 'react';
import {
  type OtelUserConfig,
  defaultOtelConfig,
  validateOtelConfig,
  generateEnvVars,
  OTEL_PRESETS,
} from '@/lib/otel-config';
import { createClient } from '@/lib/supabase/client';
import { parseHeaders } from './parse-headers';

/** Save-status banner shown next to the Save button. */
export interface SaveMessage {
  type: 'success' | 'error';
  text: string;
}

/** State + handlers the OtelSettings panel renders with. */
export interface UseOtelSettings {
  config: OtelUserConfig;
  setConfig: React.Dispatch<React.SetStateAction<OtelUserConfig>>;
  selectedPreset: string;
  headersRaw: string;
  setHeadersRaw: (raw: string) => void;
  saving: boolean;
  saveMessage: SaveMessage | null;
  validationErrors: Record<string, string>;
  copied: boolean;
  applyPreset: (presetId: string) => void;
  handleSave: () => Promise<void>;
  handleCopyEnvVars: () => Promise<void>;
  envVarsPreview: string;
  activePreset: (typeof OTEL_PRESETS)[number] | undefined;
}

/**
 * Drive the OTEL settings form.
 *
 * @param initialConfig - Config loaded from the profiles row, or null.
 * @returns Form state + handlers + computed preview.
 */
export function useOtelSettings(initialConfig: OtelUserConfig | null): UseOtelSettings {
  const supabase = createClient();

  const [config, setConfig] = useState<OtelUserConfig>(initialConfig ?? defaultOtelConfig());
  const [selectedPreset, setSelectedPreset] = useState<string>('custom');
  const [headersRaw, setHeadersRaw] = useState<string>(
    initialConfig?.headers && Object.keys(initialConfig.headers).length > 0
      ? JSON.stringify(initialConfig.headers, null, 2)
      : '',
  );
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<SaveMessage | null>(null);
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState(false);

  /**
   * Apply a preset template to the config form.
   * Pre-fills the endpoint and headers when the user picks a provider.
   *
   * @param presetId - The preset identifier.
   */
  const applyPreset = useCallback((presetId: string) => {
    const preset = OTEL_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;

    setSelectedPreset(presetId);
    setConfig((prev) => ({ ...prev, endpoint: preset.endpoint, headers: preset.headersTemplate }));
    setHeadersRaw(
      Object.keys(preset.headersTemplate).length > 0
        ? JSON.stringify(preset.headersTemplate, null, 2)
        : '',
    );
  }, []);

  /**
   * Validate and persist the OTEL config to Supabase.
   *
   * WHY: We validate client-side before saving to give instant feedback. The
   * Supabase upsert targets the `profiles` table `otel_config` JSONB column,
   * protected by RLS (users can only write their own row).
   */
  const handleSave = useCallback(async () => {
    const parsedHeaders = parseHeaders(headersRaw);
    const fullConfig: OtelUserConfig = { ...config, headers: parsedHeaders };

    // Validate headers JSON separately (validateOtelConfig doesn't check JSON syntax).
    // A non-empty raw string that parsed to {} means malformed JSON.
    if (headersRaw.trim() && Object.keys(parsedHeaders).length === 0) {
      setValidationErrors({
        headers: 'Headers must be a valid JSON object (e.g., {"Authorization": "Bearer ..."})',
      });
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
  }, [config, headersRaw, supabase]);

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
      // Clipboard API not available (non-HTTPS or denied permission).
    }
  }, [config, headersRaw]);

  // Computed preview — recomputed each render from current config + headers.
  const parsedHeaders = parseHeaders(headersRaw);
  const envVarsPreview = generateEnvVars({ ...config, headers: parsedHeaders });
  const activePreset = OTEL_PRESETS.find((p) => p.id === selectedPreset);

  return {
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
  };
}
