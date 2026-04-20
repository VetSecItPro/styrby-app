/**
 * Metrics Export (OTEL) Settings Sub-Screen
 *
 * Owns: Power-tier gate, OTEL enable/disable toggle, preset picker,
 * endpoint URL, authentication headers JSON, service name, timeout.
 *
 * WHY a sub-screen: the OTEL config form was a 250-LOC inline modal inside the
 * 2,720-LOC settings monolith. Promoting it to a full screen gives it proper
 * scroll space, eliminates the modal, and makes deep-linking possible.
 *
 * Data:
 * - Config loaded from `profiles.otel_config` JSONB column on mount.
 * - Config saved back to the same column on submit.
 * - Subscription tier checked via useSubscriptionTier (Power gate).
 *
 * Security: RLS on the profiles table ensures only the authenticated user can
 * read/write their own otel_config. SOC2 CC6.1: OTEL headers may contain
 * sensitive API keys — stored in Supabase (not SecureStore) because they need
 * to be read by the CLI from the server side.
 *
 * @see docs/planning/settings-refactor-plan-2026-04-19.md Section 3 row 6
 */

import {
  View,
  Text,
  TextInput,
  Pressable,
  Switch,
  ScrollView,
  Alert,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../../src/lib/supabase';
import { useCurrentUser } from '../../src/hooks/useCurrentUser';
import { useSubscriptionTier } from '../../src/hooks/useSubscriptionTier';
import { SectionHeader, SettingRow } from '../../src/components/ui';
import {
  type OtelUserConfig,
  type OtelPreset,
  defaultOtelConfig,
  validateOtelConfig,
  OTEL_PRESETS,
} from '../../src/lib/otel-config';

// ============================================================================
// Component
// ============================================================================

/**
 * Metrics Export sub-screen.
 *
 * On mount: loads otel_config from profiles table.
 * On save: validates, then writes back to profiles.otel_config.
 * On enable toggle: writes the new enabled flag immediately (no full-form validation).
 *
 * @returns React element
 */
export default function MetricsScreen() {
  const { user } = useCurrentUser();
  const { tier } = useSubscriptionTier(user?.id ?? null);
  const isPowerTier = tier === 'power';

  /**
   * Current OTEL configuration loaded from profiles.otel_config JSONB column.
   * WHY profiles not agent_configs: the web dashboard already uses profiles
   * to store otel_config so changes on either platform are immediately visible
   * on the other.
   */
  const [otelConfig, setOtelConfig] = useState<OtelUserConfig>(defaultOtelConfig());

  /**
   * Draft OTEL config being edited in the form (not yet saved).
   * WHY separate draft: the user can cancel edits without touching the live config.
   */
  const [otelDraft, setOtelDraft] = useState<OtelUserConfig>(defaultOtelConfig());

  /**
   * Raw text of the headers JSON field.
   * WHY keep raw separately: allows partial JSON input mid-keystroke without
   * clobbering the value. Parsed on save.
   */
  const [otelHeadersRaw, setOtelHeadersRaw] = useState('');

  /** Selected preset ID in the preset picker */
  const [otelPresetId, setOtelPresetId] = useState('custom');

  /** Field-level validation errors for the OTEL form */
  const [otelValidationErrors, setOtelValidationErrors] = useState<Record<string, string>>({});

  /** Whether the save is in progress */
  const [isSavingOtel, setIsSavingOtel] = useState(false);

  /** Whether the initial config load is in progress */
  const [isLoading, setIsLoading] = useState(true);

  // --------------------------------------------------------------------------
  // Mount: Load OTEL config
  // --------------------------------------------------------------------------

  useEffect(() => {
    if (!user) return;

    (async () => {
      try {
        const { data: profileData } = await supabase
          .from('profiles')
          .select('otel_config')
          .eq('id', user.id)
          .single();

        if (profileData && (profileData as Record<string, unknown>)['otel_config']) {
          const loaded = (profileData as Record<string, unknown>)['otel_config'] as OtelUserConfig;
          setOtelConfig(loaded);
          setOtelDraft({ ...loaded });
          setOtelHeadersRaw(
            Object.keys(loaded.headers).length > 0
              ? JSON.stringify(loaded.headers, null, 2)
              : '',
          );
        }
      } catch {
        // Non-fatal: keep defaults
      } finally {
        setIsLoading(false);
      }
    })();
  }, [user]);

  // --------------------------------------------------------------------------
  // Handlers
  // --------------------------------------------------------------------------

  /**
   * Applies a preset template to the draft config.
   * Pre-fills endpoint and headers for well-known OTLP backends.
   *
   * @param presetId - The preset identifier from OTEL_PRESETS
   */
  const handlePresetChange = useCallback((presetId: string) => {
    const preset = OTEL_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;

    setOtelPresetId(presetId);
    setOtelDraft((prev) => ({
      ...prev,
      endpoint: preset.endpoint,
      headers: preset.headersTemplate,
    }));
    setOtelHeadersRaw(
      Object.keys(preset.headersTemplate).length > 0
        ? JSON.stringify(preset.headersTemplate, null, 2)
        : '',
    );
  }, []);

  /**
   * Parses the raw headers textarea string.
   *
   * @param raw - Raw JSON string
   * @returns Parsed headers object or empty object on failure
   */
  const parseHeaders = useCallback((raw: string): Record<string, string> => {
    if (!raw.trim()) return {};
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, string>;
      }
    } catch {
      // Validation will surface the error
    }
    return {};
  }, []);

  /**
   * Validates and persists the OTEL config to Supabase profiles.otel_config.
   *
   * WHY we validate before saving: the endpoint field requires a valid HTTPS URL
   * (when enabled). Client-side validation gives immediate feedback without a
   * network round trip. Server-side constraint is a belt-and-suspenders backup.
   */
  const handleSave = useCallback(async () => {
    const parsedHeaders = parseHeaders(otelHeadersRaw);

    if (otelHeadersRaw.trim() && Object.keys(parsedHeaders).length === 0) {
      setOtelValidationErrors({ headers: 'Headers must be a valid JSON object' });
      return;
    }

    const fullConfig: OtelUserConfig = { ...otelDraft, headers: parsedHeaders };
    const validation = validateOtelConfig(fullConfig);

    if (!validation.isValid) {
      setOtelValidationErrors(validation.errors);
      return;
    }

    setOtelValidationErrors({});
    setIsSavingOtel(true);

    try {
      if (!user) return;

      const { error } = await supabase
        .from('profiles')
        .update({ otel_config: fullConfig } as Record<string, unknown>)
        .eq('id', user.id);

      if (error) {
        Alert.alert('Save Failed', `Could not save OTEL config: ${error.message}`);
        if (__DEV__) {
          console.error('[Metrics] Failed to save OTEL config:', error);
        }
      } else {
        setOtelConfig(fullConfig);
        Alert.alert('Saved', 'Metrics export configuration saved.');
      }
    } catch (err) {
      Alert.alert('Save Failed', 'An unexpected error occurred. Please try again.');
      if (__DEV__) {
        console.error('[Metrics] OTEL save error:', err);
      }
    } finally {
      setIsSavingOtel(false);
    }
  }, [otelDraft, otelHeadersRaw, parseHeaders, user]);

  /**
   * Toggles OTEL export on/off and immediately persists the change.
   * WHY immediate persist: the enable/disable flag is a lightweight boolean
   * that does not require re-validating the full form.
   *
   * @param value - New enabled state
   */
  const handleEnabledToggle = useCallback(async (value: boolean) => {
    const updated = { ...otelConfig, enabled: value };
    setOtelConfig(updated);
    setOtelDraft((prev) => ({ ...prev, enabled: value }));

    try {
      if (!user) return;

      const { error } = await supabase
        .from('profiles')
        .update({ otel_config: updated } as Record<string, unknown>)
        .eq('id', user.id);

      if (error) {
        setOtelConfig((prev) => ({ ...prev, enabled: !value }));
        setOtelDraft((prev) => ({ ...prev, enabled: !value }));
        if (__DEV__) {
          console.error('[Metrics] Failed to toggle OTEL:', error);
        }
      }
    } catch (err) {
      setOtelConfig((prev) => ({ ...prev, enabled: !value }));
      setOtelDraft((prev) => ({ ...prev, enabled: !value }));
      if (__DEV__) {
        console.error('[Metrics] OTEL toggle error:', err);
      }
    }
  }, [otelConfig, user]);

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------

  if (isLoading) {
    return (
      <View className="flex-1 bg-background items-center justify-center">
        <ActivityIndicator size="small" color="#8b5cf6" accessibilityLabel="Loading metrics config" />
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      className="flex-1"
    >
      <ScrollView
        className="flex-1 bg-background"
        keyboardShouldPersistTaps="handled"
      >
        {/* Power tier gate banner */}
        {!isPowerTier && (
          <>
            <SectionHeader title="Requirements" />
            <View className="mx-4 my-2 px-3 py-3 rounded-lg bg-purple-500/10 border border-purple-500/20">
              <Text className="text-sm text-purple-400 font-medium mb-1">Power Plan Required</Text>
              <Text className="text-xs text-purple-300">
                OTEL metrics export requires the Power plan ($49/mo or $41/mo annual).
                Upgrade to stream session metrics to Grafana, Datadog, Honeycomb, or any OTLP backend.
              </Text>
            </View>
          </>
        )}

        {/* Enable toggle */}
        <SectionHeader title="Export" />
        <View className="bg-background-secondary">
          <SettingRow
            icon="pulse"
            iconColor="#8b5cf6"
            title="Enable OTEL Export"
            subtitle={
              !isPowerTier
                ? 'Power plan required'
                : otelConfig.enabled
                  ? 'Exporting to ' + (otelConfig.endpoint
                    ? otelConfig.endpoint.replace(/https?:\/\//, '').slice(0, 30) + '…'
                    : 'endpoint not set')
                  : 'Disabled'
            }
            trailing={
              <Switch
                value={otelConfig.enabled && isPowerTier}
                onValueChange={(v) => void handleEnabledToggle(v)}
                disabled={!isPowerTier}
                trackColor={{ false: '#3f3f46', true: '#8b5cf650' }}
                thumbColor={otelConfig.enabled && isPowerTier ? '#8b5cf6' : '#71717a'}
                accessibilityRole="switch"
                accessibilityLabel="Toggle OTEL metrics export"
              />
            }
          />
        </View>

        {/* Configuration form — only shown for Power users */}
        {isPowerTier && (
          <>
            <SectionHeader title="Provider Preset" />
            <View className="bg-background-secondary px-4 py-3">
              <View className="flex-row flex-wrap">
                {OTEL_PRESETS.map((preset: OtelPreset) => (
                  <Pressable
                    key={preset.id}
                    onPress={() => handlePresetChange(preset.id)}
                    className={`px-3 py-1.5 rounded-full mr-2 mb-2 ${
                      otelPresetId === preset.id ? 'bg-purple-500/20' : 'bg-zinc-800'
                    }`}
                    accessibilityRole="button"
                    accessibilityLabel={`Select ${preset.name} preset`}
                    accessibilityState={{ selected: otelPresetId === preset.id }}
                  >
                    <Text
                      className="text-xs font-medium"
                      style={{ color: otelPresetId === preset.id ? '#a855f7' : '#a1a1aa' }}
                    >
                      {preset.name}
                    </Text>
                  </Pressable>
                ))}
              </View>

              {otelPresetId !== 'custom' && (
                <Text className="text-zinc-500 text-xs mt-1">
                  {OTEL_PRESETS.find((p: OtelPreset) => p.id === otelPresetId)?.helpText ?? ''}
                </Text>
              )}
            </View>

            <SectionHeader title="Endpoint" />
            <View className="bg-background-secondary px-4 py-3">
              {/* OTLP Endpoint */}
              <Text className="text-zinc-400 text-xs font-semibold uppercase mb-1">OTLP Endpoint URL</Text>
              <TextInput
                className={`bg-zinc-800 text-white rounded-xl px-4 py-3 text-sm font-mono mb-1 ${
                  otelValidationErrors['endpoint'] ? 'border border-red-500' : ''
                }`}
                placeholder="https://otlp.example.com/v1/metrics"
                placeholderTextColor="#52525b"
                value={otelDraft.endpoint}
                onChangeText={(v) => setOtelDraft((prev) => ({ ...prev, endpoint: v }))}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                accessibilityLabel="OTLP endpoint URL"
              />
              {otelValidationErrors['endpoint'] ? (
                <Text className="text-red-400 text-xs mb-3">{otelValidationErrors['endpoint']}</Text>
              ) : (
                <View className="mb-3" />
              )}

              {/* Auth Headers */}
              <Text className="text-zinc-400 text-xs font-semibold uppercase mb-1">
                Authentication Headers (JSON)
              </Text>
              <TextInput
                className={`bg-zinc-800 text-white rounded-xl px-4 py-3 text-xs font-mono min-h-[80px] mb-1 ${
                  otelValidationErrors['headers'] ? 'border border-red-500' : ''
                }`}
                placeholder={'{\n  "Authorization": "Bearer <token>"\n}'}
                placeholderTextColor="#52525b"
                value={otelHeadersRaw}
                onChangeText={setOtelHeadersRaw}
                multiline
                textAlignVertical="top"
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
                accessibilityLabel="Authentication headers JSON"
              />
              {otelValidationErrors['headers'] ? (
                <Text className="text-red-400 text-xs mb-3">{otelValidationErrors['headers']}</Text>
              ) : (
                <View className="mb-3" />
              )}

              {/* Service Name */}
              <Text className="text-zinc-400 text-xs font-semibold uppercase mb-1">Service Name</Text>
              <TextInput
                className={`bg-zinc-800 text-white rounded-xl px-4 py-3 text-sm mb-1 ${
                  otelValidationErrors['serviceName'] ? 'border border-red-500' : ''
                }`}
                placeholder="styrby-cli"
                placeholderTextColor="#52525b"
                value={otelDraft.serviceName}
                onChangeText={(v) => setOtelDraft((prev) => ({ ...prev, serviceName: v }))}
                autoCapitalize="none"
                autoCorrect={false}
                accessibilityLabel="OTLP service name"
              />
              {otelValidationErrors['serviceName'] ? (
                <Text className="text-red-400 text-xs mb-3">{otelValidationErrors['serviceName']}</Text>
              ) : (
                <View className="mb-3" />
              )}

              {/* Timeout */}
              <Text className="text-zinc-400 text-xs font-semibold uppercase mb-1">Timeout (ms)</Text>
              <TextInput
                className={`bg-zinc-800 text-white rounded-xl px-4 py-3 text-sm mb-1 w-36 ${
                  otelValidationErrors['timeoutMs'] ? 'border border-red-500' : ''
                }`}
                placeholder="5000"
                placeholderTextColor="#52525b"
                value={String(otelDraft.timeoutMs)}
                onChangeText={(v) =>
                  setOtelDraft((prev) => ({ ...prev, timeoutMs: parseInt(v, 10) || 5000 }))
                }
                keyboardType="number-pad"
                accessibilityLabel="OTLP export timeout in milliseconds"
              />
              {otelValidationErrors['timeoutMs'] ? (
                <Text className="text-red-400 text-xs mb-3">{otelValidationErrors['timeoutMs']}</Text>
              ) : (
                <View className="mb-4" />
              )}

              {/* Save Button */}
              <Pressable
                onPress={() => void handleSave()}
                disabled={isSavingOtel}
                className={`py-3 rounded-xl items-center ${
                  isSavingOtel ? 'bg-zinc-700' : 'bg-purple-600 active:opacity-80'
                }`}
                accessibilityRole="button"
                accessibilityLabel="Save OTEL configuration"
              >
                {isSavingOtel ? (
                  <ActivityIndicator size="small" color="#ffffff" />
                ) : (
                  <Text className="text-white font-semibold">Save Configuration</Text>
                )}
              </Pressable>
            </View>
          </>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
