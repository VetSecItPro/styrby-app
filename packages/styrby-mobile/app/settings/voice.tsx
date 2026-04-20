/**
 * Voice Input Settings Sub-Screen
 *
 * Owns: voice enable toggle, interaction mode selector (toggle/hold),
 * transcription endpoint URL, transcription API key.
 *
 * WHY a sub-screen: the voice config was a 70-LOC inline modal in the
 * 2,720-LOC settings monolith. Promoting it to a full screen eliminates
 * the modal and provides proper scroll space for the form.
 *
 * Security: the transcription API key is stored in SecureStore (not Supabase).
 * WHY SecureStore: it's a per-device credential that does not need to sync
 * across devices. SecureStore encrypts the value using the device keychain.
 * SOC2 CC6.1: access to the key is limited to this screen and the VoiceInput
 * component that reads it on mount.
 *
 * @see docs/planning/settings-refactor-plan-2026-04-19.md Section 3 row 4
 */

import {
  View,
  Text,
  TextInput,
  Pressable,
  Switch,
  ScrollView,
  Alert,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useState, useEffect, useCallback } from 'react';
import * as SecureStore from 'expo-secure-store';
import { type VoiceInputConfig } from 'styrby-shared';
import { SectionHeader, SettingRow } from '../../src/components/ui';

// ============================================================================
// Constants
// ============================================================================

/**
 * SecureStore key for the voice input configuration.
 * WHY SecureStore: voice config contains a sensitive API key for the
 * transcription endpoint that must never leave the device.
 */
const VOICE_INPUT_CONFIG_KEY = 'styrby_voice_input_config';

// ============================================================================
// Component
// ============================================================================

/**
 * Voice Input sub-screen.
 *
 * On mount: loads VoiceInputConfig from SecureStore.
 * On each toggle/change: writes the updated config back to SecureStore
 * immediately. The VoiceInput component reads from SecureStore on its own mount.
 *
 * @returns React element
 */
export default function VoiceScreen() {
  /**
   * Current voice input configuration.
   * WHY default disabled: voice input requires the user to configure a
   * transcription endpoint. Defaulting to disabled prevents confusion when
   * the endpoint is not yet set.
   */
  const [voiceConfig, setVoiceConfig] = useState<VoiceInputConfig>({
    enabled: false,
    mode: 'toggle',
    transcriptionEndpoint: '',
    transcriptionApiKey: '',
  });

  /** Draft endpoint URL (not yet saved) */
  const [endpointDraft, setEndpointDraft] = useState('');

  /** Draft API key (not yet saved) */
  const [apiKeyDraft, setApiKeyDraft] = useState('');

  // --------------------------------------------------------------------------
  // Mount: Load voice config from SecureStore
  // --------------------------------------------------------------------------

  useEffect(() => {
    (async () => {
      try {
        const stored = await SecureStore.getItemAsync(VOICE_INPUT_CONFIG_KEY);
        if (stored) {
          const parsed = JSON.parse(stored) as VoiceInputConfig;
          setVoiceConfig(parsed);
          setEndpointDraft(parsed.transcriptionEndpoint ?? '');
          setApiKeyDraft(parsed.transcriptionApiKey ?? '');
        }
      } catch {
        // Malformed stored value — keep defaults. This handles the case where
        // the JSON schema changed between app versions.
      }
    })();
  }, []);

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  /**
   * Writes the given config to SecureStore and updates local state.
   * Reverts to the previous config on write failure.
   *
   * @param updated - The new config to persist
   * @param onError - Optional callback if storage fails
   */
  const persistConfig = useCallback(async (
    updated: VoiceInputConfig,
    onError?: (prev: VoiceInputConfig) => void,
  ) => {
    try {
      await SecureStore.setItemAsync(VOICE_INPUT_CONFIG_KEY, JSON.stringify(updated));
      setVoiceConfig(updated);
    } catch {
      if (onError) {
        onError(voiceConfig);
      }
    }
  }, [voiceConfig]);

  // --------------------------------------------------------------------------
  // Handlers
  // --------------------------------------------------------------------------

  /**
   * Toggles voice input enabled/disabled and persists.
   *
   * @param value - New enabled state
   */
  const handleEnabledToggle = useCallback(async (value: boolean) => {
    const updated: VoiceInputConfig = { ...voiceConfig, enabled: value };
    setVoiceConfig(updated);
    await persistConfig(updated, () => setVoiceConfig(voiceConfig));
  }, [voiceConfig, persistConfig]);

  /**
   * Switches the interaction mode between 'toggle' and 'hold'.
   *
   * WHY two modes: 'toggle' (tap once to start, tap again to stop) suits
   * hands-free use; 'hold' (press and hold to record) suits quick one-shot queries.
   *
   * @param mode - New interaction mode
   */
  const handleModeChange = useCallback(async (mode: 'hold' | 'toggle') => {
    const updated: VoiceInputConfig = { ...voiceConfig, mode };
    setVoiceConfig(updated);
    await persistConfig(updated, () => setVoiceConfig(voiceConfig));
  }, [voiceConfig, persistConfig]);

  /**
   * Saves the endpoint and API key drafts to SecureStore.
   * Shows an error alert if the SecureStore write fails.
   */
  const handleSaveEndpoint = useCallback(async () => {
    const updated: VoiceInputConfig = {
      ...voiceConfig,
      transcriptionEndpoint: endpointDraft.trim() || undefined,
      transcriptionApiKey: apiKeyDraft.trim() || undefined,
    };

    try {
      await SecureStore.setItemAsync(VOICE_INPUT_CONFIG_KEY, JSON.stringify(updated));
      setVoiceConfig(updated);
      Alert.alert('Saved', 'Voice input settings saved.');
    } catch {
      Alert.alert('Error', 'Failed to save voice input settings.');
    }
  }, [voiceConfig, endpointDraft, apiKeyDraft]);

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      className="flex-1"
    >
      <ScrollView
        className="flex-1 bg-background"
        keyboardShouldPersistTaps="handled"
      >
        {/* Enable Toggle */}
        <SectionHeader title="Voice Commands" />
        <View className="bg-background-secondary">
          <SettingRow
            icon="mic"
            iconColor="#f97316"
            title="Voice Input"
            subtitle={voiceConfig.enabled ? 'Enabled' : 'Disabled'}
            trailing={
              <Switch
                value={voiceConfig.enabled}
                onValueChange={(v) => void handleEnabledToggle(v)}
                trackColor={{ false: '#3f3f46', true: '#f9731650' }}
                thumbColor={voiceConfig.enabled ? '#f97316' : '#71717a'}
                accessibilityRole="switch"
                accessibilityLabel="Toggle voice input"
              />
            }
          />
        </View>

        {/* Interaction Mode (only visible when enabled) */}
        {voiceConfig.enabled && (
          <>
            <SectionHeader title="Interaction Mode" />
            <View className="bg-background-secondary px-4 py-3">
              <View className="flex-row items-center mb-3">
                <View
                  className="w-8 h-8 rounded-lg items-center justify-center mr-3"
                  style={{ backgroundColor: '#f9731620' }}
                >
                  <Text style={{ fontSize: 16, color: '#f97316' }}>👆</Text>
                </View>
                <Text className="text-white font-medium flex-1">Recording Mode</Text>
              </View>

              <View className="flex-row bg-zinc-800 rounded-xl p-1 ml-11">
                {(['toggle', 'hold'] as const).map((option) => {
                  const isSelected = voiceConfig.mode === option;
                  const label = option === 'toggle' ? 'Tap Toggle' : 'Hold to Talk';
                  return (
                    <Pressable
                      key={option}
                      onPress={() => void handleModeChange(option)}
                      className={`flex-1 py-2 rounded-lg items-center ${isSelected ? 'bg-brand' : ''}`}
                      accessibilityRole="radio"
                      accessibilityState={{ checked: isSelected }}
                      accessibilityLabel={`Set voice mode to ${label}`}
                    >
                      <Text
                        className={`text-xs font-semibold ${isSelected ? 'text-white' : 'text-zinc-500'}`}
                      >
                        {label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>

              <Text className="text-zinc-600 text-xs mt-2 ml-11">
                {voiceConfig.mode === 'toggle'
                  ? 'Tap the mic button to start/stop recording.'
                  : 'Hold the mic button while speaking; release to transcribe.'}
              </Text>
            </View>
          </>
        )}

        {/* Transcription Endpoint Configuration */}
        <SectionHeader title="Transcription API" />
        <View className="bg-background-secondary px-4 py-4">
          <Text className="text-zinc-400 text-sm mb-3">
            Configure a Whisper-compatible endpoint for speech-to-text.
            Compatible with OpenAI Whisper API or self-hosted alternatives.
          </Text>

          <Text className="text-zinc-500 text-xs mb-1">Endpoint URL</Text>
          <TextInput
            className="bg-zinc-800 text-white rounded-xl px-4 py-3 text-sm mb-4"
            placeholder="https://api.openai.com/v1/audio/transcriptions"
            placeholderTextColor="#52525b"
            value={endpointDraft}
            onChangeText={setEndpointDraft}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            accessibilityLabel="Transcription endpoint URL"
          />

          {/* WHY secureTextEntry: the API key is a secret credential.
              SecureTextEntry prevents shoulder-surfing and disables autocomplete
              for fields that contain passwords/keys (OWASP M5). */}
          <Text className="text-zinc-500 text-xs mb-1">API Key (stored securely on device)</Text>
          <TextInput
            className="bg-zinc-800 text-white rounded-xl px-4 py-3 text-sm mb-6"
            placeholder="sk-..."
            placeholderTextColor="#52525b"
            value={apiKeyDraft}
            onChangeText={setApiKeyDraft}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            accessibilityLabel="Transcription API key"
          />

          <Pressable
            className="bg-brand py-3 rounded-xl items-center active:opacity-80"
            onPress={() => void handleSaveEndpoint()}
            accessibilityRole="button"
            accessibilityLabel="Save voice input configuration"
          >
            <Text className="text-white font-semibold">Save Configuration</Text>
          </Pressable>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
