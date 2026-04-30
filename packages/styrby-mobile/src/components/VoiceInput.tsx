/**
 * VoiceInput Component
 *
 * Microphone button that records audio and transcribes it via a configurable
 * Whisper-compatible endpoint. Supports two interaction modes:
 *
 * - 'hold': Press and hold to record, release to transcribe (push-to-talk)
 * - 'toggle': Tap once to start recording, tap again to stop and transcribe
 *
 * Recording lifecycle:
 * 1. Request microphone permission on first use
 * 2. Start expo-audio AudioRecorder at high-quality mono settings
 * 3. On stop, read the recorded file and POST to the transcription endpoint
 * 4. Surface the transcript text for the user to review before sending
 * 5. User can confirm (fill input) or dismiss (discard)
 *
 * When no transcription endpoint is configured, the button shows a disabled
 * state with a tooltip directing the user to configure one in Settings.
 *
 * WHY expo-audio over a native STT library: expo-audio is Expo's official
 * audio recording package (replaces the deprecated expo-av) and avoids adding
 * a native module dependency. Whisper-compatible APIs are widely available
 * (OpenAI, self-hosted, enterprise) and the config-driven approach keeps
 * Styrby vendor-neutral.
 *
 * TIER GATE (mobile-side): Voice commands are a Power-only feature.
 * When integrating this component into the chat screen or settings screen,
 * the caller MUST check the user's subscription tier before rendering the
 * VoiceInput button. Free and Pro users should see a locked state or an
 * upgrade prompt instead. The `config` prop being null is not sufficient
 * — it must be explicitly blocked based on tier.
 *
 * Example (in the chat screen):
 *   {userTier === 'power' ? (
 *     <VoiceInput config={voiceConfig} onTranscript={handleTranscript} />
 *   ) : (
 *     <UpgradePrompt feature="Voice commands" requiredTier="power" />
 *   )}
 *
 * @module components/VoiceInput
 */

import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  Pressable,
  Modal,
  TextInput,
  ActivityIndicator,
  Animated,
  Platform,
  Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { VoiceInputConfig } from 'styrby-shared';

// ============================================================================
// Constants
// ============================================================================

/**
 * WHY: We sample at 16 kHz mono because Whisper was trained primarily on
 * speech at that sample rate. Higher rates waste bandwidth; lower rates
 * degrade accuracy.
 *
 * expo-audio RecordingOptions uses a flat structure (no android/ios nesting
 * at the top level). Platform-specific overrides are available via `ios`/`android`
 * sub-objects but the top-level fields apply cross-platform.
 */
const RECORDING_OPTIONS = {
  isMeteringEnabled: true,
  extension: '.m4a',
  sampleRate: 16000,
  numberOfChannels: 1,
  bitRate: 32000,
  android: {
    outputFormat: 'mpeg4' as const,
    audioEncoder: 'aac' as const,
  },
  ios: {
    outputFormat: 'aac' as const,
    audioQuality: 96 as const,  // AudioQuality.MEDIUM
    linearPCMBitDepth: 16 as const,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
  },
  web: {
    mimeType: 'audio/webm',
    bitsPerSecond: 32000,
  },
};

/**
 * Maximum recording duration before auto-stop (3 minutes).
 * WHY: Prevents accidental runaway recordings and keeps transcription costs manageable.
 */
const MAX_RECORDING_MS = 3 * 60 * 1000;

// ============================================================================
// Types
// ============================================================================

/**
 * Props for the VoiceInput component.
 */
export interface VoiceInputProps {
  /**
   * Voice input configuration (mode, endpoint, key).
   * When null or disabled, the button renders in a disabled/hidden state.
   */
  config: VoiceInputConfig | null;

  /**
   * Called when the user confirms a transcript to send.
   * The parent chat screen should call its handleSend with this text.
   *
   * @param transcript - The confirmed transcribed text
   */
  onTranscript: (transcript: string) => void;

  /**
   * Whether the parent input is disabled (e.g. no relay connection).
   * Prevents voice recording when the chat cannot accept messages.
   */
  disabled?: boolean;
}

// ============================================================================
// Recording state type
// ============================================================================

type RecordingState = 'idle' | 'recording' | 'transcribing' | 'confirming' | 'error';

// ============================================================================
// Component
// ============================================================================

/**
 * Voice-to-text input button for the chat screen.
 *
 * Renders a microphone icon button that records audio via expo-audio and
 * transcribes it via a configurable Whisper-compatible endpoint.
 *
 * @param props - VoiceInputProps
 * @returns React element or null when voice is disabled
 *
 * @example
 * <VoiceInput
 *   config={voiceConfig}
 *   onTranscript={(text) => setInputText(text)}
 *   disabled={!isConnected}
 * />
 */
export function VoiceInput({ config, onTranscript, disabled = false }: VoiceInputProps) {
  const [state, setState] = useState<RecordingState>('idle');
  // WHY only editedTranscript: the raw transcript is rendered into the
  // editable TextInput via setEditedTranscript; we never read the unedited
  // value back, so storing it separately would just trigger extra renders.
  const [editedTranscript, setEditedTranscript] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [showConfirmModal, setShowConfirmModal] = useState(false);

  // WHY: Store AudioRecorder ref so we can stop it from event handlers
  // that don't have access to closure state. Typed as unknown to avoid
  // importing the class at module level (dynamic import keeps bundle lean).
  const recordingRef = useRef<unknown>(null);
  const autoStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // WHY this ref (M1.1, 2026-04-30): the auto-stop setTimeout in
  // startRecording needs to call the latest stopRecording, but stopRecording
  // is declared further down (so it can't be in startRecording's deps array
  // without a TDZ error). We assign this ref's .current at the bottom of the
  // hook chain (after both startRecording + stopRecording exist) so the
  // timer always sees the freshest implementation.
  const stopRecordingRef = useRef<(() => Promise<void>) | null>(null);
  // Same TDZ avoidance for transcribeAudio (declared after stopRecording).
  // stopRecording calls transcribeAudio inside its async body; the ref lets
  // each invocation reach the latest version without a circular dep.
  const transcribeAudioRef = useRef<((uri: string) => Promise<void>) | null>(null);

  // WHY: Use a ref initializer function instead of inline `new Animated.Value(1)`
  // to avoid crashing in test environments where Animated.Value may not be
  // fully implemented by the jest setup. The function form is only called once.
  const pulseAnimRef = useRef<Animated.Value | null>(null);
  if (!pulseAnimRef.current) {
    try {
      pulseAnimRef.current = new Animated.Value(1);
    } catch {
      // Animated.Value not available (test environment) — animations disabled
    }
  }
  const pulseAnim = pulseAnimRef.current;

  // --------------------------------------------------------------------------
  // Pulse Animation
  // --------------------------------------------------------------------------

  /**
   * Starts a repeating pulse animation to indicate active recording.
   * WHY: Guards pulseAnim null check — in test environments Animated.Value
   * creation may fail silently; we skip animations rather than crashing.
   */
  const startPulse = useCallback(() => {
    if (!pulseAnim) return;
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.3, duration: 500, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1.0, duration: 500, useNativeDriver: true }),
      ])
    ).start();
  }, [pulseAnim]);

  /**
   * Stops the pulse animation and resets scale to 1.
   */
  const stopPulse = useCallback(() => {
    if (!pulseAnim) return;
    pulseAnim.stopAnimation();
    Animated.timing(pulseAnim, { toValue: 1, duration: 150, useNativeDriver: true }).start();
  }, [pulseAnim]);

  // --------------------------------------------------------------------------
  // Recording
  // --------------------------------------------------------------------------

  /**
   * Requests microphone permission and starts audio recording.
   * Sets state to 'recording' and begins the pulse animation.
   *
   * @throws Shows Alert and sets error state if permissions are denied
   */
  const startRecording = useCallback(async () => {
    if (disabled || !config?.enabled) return;

    if (!config.transcriptionEndpoint) {
      Alert.alert(
        'No Transcription Endpoint',
        'Configure a Whisper-compatible transcription URL in Settings > Voice Input.',
        [{ text: 'OK' }]
      );
      return;
    }

    // SECURITY: Only allow HTTPS endpoints (or localhost for development).
    // Audio data contains sensitive voice recordings — sending over plain HTTP
    // exposes it to network-level eavesdropping. Block file://, ftp://, etc.
    const endpoint = config.transcriptionEndpoint;
    const isSecure = endpoint.startsWith('https://');
    const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1|::1)(:\d+)?\//.test(endpoint);
    if (!isSecure && !isLocalhost) {
      Alert.alert(
        'Insecure Endpoint',
        'The transcription endpoint must use HTTPS to protect your voice data. '
          + 'HTTP is only allowed for localhost development.',
        [{ text: 'OK' }]
      );
      return;
    }

    try {
      // WHY: We dynamically import expo-audio here to avoid a hard crash if the
      // module is unavailable (e.g. Expo Go environments that don't include it).
      // The component degrades to a disabled state instead.
      const { requestRecordingPermissionsAsync, setAudioModeAsync, AudioRecorder } = await import('expo-audio');

      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) {
        Alert.alert(
          'Microphone Permission',
          'Styrby needs microphone access for voice commands. Enable it in Settings.',
          [{ text: 'OK' }]
        );
        return;
      }

      // WHY: allowsRecording (not allowsRecordingIOS) is the expo-audio API.
      // playsInSilentMode ensures recording works even when iOS silent switch is on.
      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
      });

      // WHY: expo-audio uses an imperative AudioRecorder class.
      // We prepareToRecordAsync first (allocates native resources), then record().
      const recorder = new AudioRecorder(RECORDING_OPTIONS);
      await recorder.prepareToRecordAsync();
      recorder.record();
      recordingRef.current = recorder;

      setState('recording');
      startPulse();

      // WHY: Auto-stop after MAX_RECORDING_MS to prevent runaway recordings.
      // Uses stopRecordingRef so the timer always invokes the latest
      // stopRecording (see ref initialisation below the stopRecording decl).
      autoStopTimerRef.current = setTimeout(() => {
        void stopRecordingRef.current?.();
      }, MAX_RECORDING_MS);
    } catch (err) {
      setState('error');
      setErrorMessage('Could not start recording. Check microphone permissions.');
      if (__DEV__) console.error('[VoiceInput] startRecording error:', err);
    }
    // WHY stopRecordingRef.current() (M1.1 fix, 2026-04-30): we need to
    // invoke the latest stopRecording from inside this auto-stop timer,
    // but stopRecording is declared further down the file and adding it
    // to this deps array would be a TDZ reference error. The ref pattern
    // (initialised below where stopRecording exists) lets the timer always
    // hit the most recent stopRecording without a circular dep.
  }, [disabled, config, startPulse]);

  /**
   * Stops the current recording, clears the auto-stop timer, and begins
   * transcription.
   *
   * @returns void
   */
  const stopRecording = useCallback(async () => {
    if (!recordingRef.current) return;

    if (autoStopTimerRef.current) {
      clearTimeout(autoStopTimerRef.current);
      autoStopTimerRef.current = null;
    }

    stopPulse();
    setState('transcribing');

    try {
      // WHY: AudioRecorder.stop() is the expo-audio replacement for
      // expo-av's stopAndUnloadAsync(). The uri property replaces getURI().
      // We import the class type from expo-audio (no runtime import needed —
      // the recorder instance was already created in startRecording).
      type AudioRecorderInstance = import('expo-audio').AudioRecorder;
      const recorder = recordingRef.current as AudioRecorderInstance;
      await recorder.stop();
      const uri = recorder.uri;
      recordingRef.current = null;

      if (!uri) {
        setState('error');
        setErrorMessage('Recording failed — no audio captured.');
        return;
      }

      // WHY transcribeAudioRef.current (M1.1, 2026-04-30): transcribeAudio
      // is declared further down the file; adding it to deps directly would
      // be a TDZ reference error. The ref pattern keeps the call always
      // pointing at the freshest implementation without a circular dep.
      await transcribeAudioRef.current?.(uri);
    } catch (err) {
      setState('error');
      setErrorMessage('Recording stopped unexpectedly.');
      if (__DEV__) console.error('[VoiceInput] stopRecording error:', err);
    }
  }, [stopPulse]);

  // --------------------------------------------------------------------------
  // Transcription
  // --------------------------------------------------------------------------

  /**
   * POSTs the recorded audio file to the configured transcription endpoint
   * and surfaces the resulting text for user confirmation.
   *
   * @param audioUri - Local file:// URI of the recorded audio
   * @returns void
   * @throws Sets error state on network or API failure
   */
  const transcribeAudio = useCallback(async (audioUri: string) => {
    if (!config?.transcriptionEndpoint) return;

    try {
      const formData = new FormData();
      // WHY: The Whisper API requires the file as multipart/form-data with
      // the field name 'file' and a MIME type for the audio format.
      formData.append('file', {
        uri: audioUri,
        name: 'audio.m4a',
        type: 'audio/m4a',
      } as unknown as Blob);
      formData.append('model', 'whisper-1');
      formData.append('response_format', 'text');

      const headers: Record<string, string> = {
        'Accept': 'application/json',
      };

      if (config.transcriptionApiKey) {
        headers['Authorization'] = `Bearer ${config.transcriptionApiKey}`;
      }

      const response = await fetch(config.transcriptionEndpoint, {
        method: 'POST',
        headers,
        body: formData,
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => response.statusText);
        throw new Error(`Transcription failed (${response.status}): ${errText}`);
      }

      const text = await response.text();
      const trimmed = text.trim();

      if (!trimmed) {
        setState('error');
        setErrorMessage('No speech detected. Try again in a quieter environment.');
        return;
      }

      setEditedTranscript(trimmed);
      setState('confirming');
      setShowConfirmModal(true);
    } catch (err) {
      setState('error');
      const msg = err instanceof Error ? err.message : 'Transcription service unavailable.';
      setErrorMessage(msg);
      if (__DEV__) console.error('[VoiceInput] transcribeAudio error:', err);
    }
  }, [config]);

  // Keep the forward-reference refs in sync with the latest function values.
  // WHY (M1.1, 2026-04-30): startRecording's auto-stop timer and
  // stopRecording's transcribe call need to invoke the freshest copies of
  // stopRecording / transcribeAudio respectively, but those callbacks are
  // declared after their callers in the file (and across-callback deps would
  // be TDZ errors). This effect runs every render so the .current always
  // points at the latest memoised value.
  useEffect(() => {
    stopRecordingRef.current = stopRecording;
    transcribeAudioRef.current = transcribeAudio;
  });

  // --------------------------------------------------------------------------
  // Confirmation Modal Actions
  // --------------------------------------------------------------------------

  /**
   * Confirms the (optionally edited) transcript and passes it to the parent.
   * Resets local state so the component is ready for the next recording.
   */
  const handleConfirm = useCallback(() => {
    const text = editedTranscript.trim();
    if (text) {
      onTranscript(text);
    }
    setShowConfirmModal(false);
    setState('idle');
    setEditedTranscript('');
  }, [editedTranscript, onTranscript]);

  /**
   * Discards the transcript and resets to idle without calling onTranscript.
   */
  const handleDiscard = useCallback(() => {
    setShowConfirmModal(false);
    setState('idle');
    setEditedTranscript('');
  }, []);

  /**
   * Clears an error state and returns to idle.
   */
  const handleDismissError = useCallback(() => {
    setState('idle');
    setErrorMessage('');
  }, []);

  // --------------------------------------------------------------------------
  // Button Press Handlers
  // --------------------------------------------------------------------------

  /**
   * Handles tap events for toggle mode.
   * First tap starts recording; second tap stops it.
   */
  const handleTogglePress = useCallback(() => {
    if (state === 'recording') {
      void stopRecording();
    } else if (state === 'idle') {
      void startRecording();
    } else if (state === 'error') {
      handleDismissError();
    }
  }, [state, startRecording, stopRecording, handleDismissError]);

  /**
   * Handles press-in for hold mode — starts recording.
   */
  const handleHoldPressIn = useCallback(() => {
    if (state === 'idle') {
      void startRecording();
    }
  }, [state, startRecording]);

  /**
   * Handles press-out for hold mode — stops recording.
   */
  const handleHoldPressOut = useCallback(() => {
    if (state === 'recording') {
      void stopRecording();
    }
  }, [state, stopRecording]);

  // --------------------------------------------------------------------------
  // Derived State
  // --------------------------------------------------------------------------

  const isRecording = state === 'recording';
  const isTranscribing = state === 'transcribing';
  const hasError = state === 'error';
  const isDisabled = disabled || !config?.enabled || isTranscribing || state === 'confirming';

  /**
   * WHY: Button color changes to communicate state:
   * - Brand orange: active recording
   * - Red: error
   * - Zinc: idle / disabled
   */
  const buttonColor = isRecording
    ? '#f97316'
    : hasError
    ? '#ef4444'
    : '#3f3f46';

  const iconName: keyof typeof Ionicons.glyphMap = isRecording
    ? 'stop-circle'
    : hasError
    ? 'alert-circle'
    : isTranscribing
    ? 'hourglass'
    : 'mic';

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------

  if (!config?.enabled) {
    return null;
  }

  return (
    <>
      {/* Microphone Button */}
      <Pressable
        onPress={config.mode === 'toggle' ? handleTogglePress : undefined}
        onPressIn={config.mode === 'hold' ? handleHoldPressIn : undefined}
        onPressOut={config.mode === 'hold' ? handleHoldPressOut : undefined}
        disabled={isDisabled}
        accessibilityRole="button"
        accessibilityLabel={
          isRecording
            ? 'Stop recording'
            : isTranscribing
            ? 'Transcribing...'
            : config.mode === 'hold'
            ? 'Hold to record voice command'
            : 'Tap to record voice command'
        }
        accessibilityState={{ disabled: isDisabled }}
        style={{ marginLeft: 6 }}
      >
        <Animated.View
          style={{
            transform: [{ scale: isRecording && pulseAnim ? pulseAnim : 1 }],
            width: 40,
            height: 40,
            borderRadius: 20,
            backgroundColor: buttonColor,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {isTranscribing ? (
            <ActivityIndicator size="small" color="white" />
          ) : (
            <Ionicons name={iconName} size={20} color="white" />
          )}
        </Animated.View>
      </Pressable>

      {/* Recording indicator label */}
      {isRecording && (
        <View
          style={{
            position: 'absolute',
            bottom: 72,
            left: 0,
            right: 0,
            alignItems: 'center',
          }}
          pointerEvents="none"
        >
          <View
            style={{
              backgroundColor: 'rgba(249,115,22,0.9)',
              paddingHorizontal: 12,
              paddingVertical: 6,
              borderRadius: 16,
              flexDirection: 'row',
              alignItems: 'center',
            }}
          >
            <Ionicons name="radio-button-on" size={12} color="white" />
            <Text style={{ color: 'white', fontWeight: '600', fontSize: 13, marginLeft: 6 }}>
              {config.mode === 'hold' ? 'Recording — release to stop' : 'Recording — tap mic to stop'}
            </Text>
          </View>
        </View>
      )}

      {/* Transcript Confirmation Modal */}
      <Modal
        visible={showConfirmModal}
        transparent
        animationType="slide"
        onRequestClose={handleDiscard}
        accessibilityViewIsModal
      >
        <View
          style={{
            flex: 1,
            backgroundColor: 'rgba(0,0,0,0.6)',
            justifyContent: 'flex-end',
          }}
        >
          <View
            style={{
              backgroundColor: '#18181b',
              borderTopLeftRadius: 20,
              borderTopRightRadius: 20,
              padding: 20,
              paddingBottom: Platform.OS === 'ios' ? 36 : 20,
            }}
          >
            {/* Header */}
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 16 }}>
              <Ionicons name="mic" size={20} color="#f97316" />
              <Text style={{ color: 'white', fontWeight: '700', fontSize: 16, marginLeft: 8 }}>
                Voice Transcript
              </Text>
              <Text style={{ color: '#71717a', fontSize: 13, marginLeft: 'auto' as never }}>
                Edit before sending
              </Text>
            </View>

            {/* Editable transcript */}
            <TextInput
              value={editedTranscript}
              onChangeText={setEditedTranscript}
              multiline
              style={{
                backgroundColor: '#27272a',
                color: 'white',
                borderRadius: 12,
                padding: 12,
                fontSize: 15,
                minHeight: 80,
                maxHeight: 200,
                marginBottom: 16,
                textAlignVertical: 'top',
              }}
              accessibilityLabel="Transcript text — edit before sending"
              placeholder="Transcript will appear here..."
              placeholderTextColor="#71717a"
            />

            {/* Action buttons */}
            <View style={{ flexDirection: 'row', gap: 12 }}>
              <Pressable
                onPress={handleDiscard}
                style={{
                  flex: 1,
                  paddingVertical: 14,
                  borderRadius: 12,
                  backgroundColor: '#27272a',
                  alignItems: 'center',
                }}
                accessibilityRole="button"
                accessibilityLabel="Discard transcript"
              >
                <Text style={{ color: '#71717a', fontWeight: '600', fontSize: 15 }}>Discard</Text>
              </Pressable>

              <Pressable
                onPress={handleConfirm}
                disabled={!editedTranscript.trim()}
                style={{
                  flex: 2,
                  paddingVertical: 14,
                  borderRadius: 12,
                  backgroundColor: editedTranscript.trim() ? '#f97316' : '#3f3f46',
                  alignItems: 'center',
                }}
                accessibilityRole="button"
                accessibilityLabel="Send transcript as message"
                accessibilityState={{ disabled: !editedTranscript.trim() }}
              >
                <Text style={{ color: 'white', fontWeight: '700', fontSize: 15 }}>
                  Send Message
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* Error toast (non-modal, auto-dismisses on next tap) */}
      {hasError && (
        <Pressable
          onPress={handleDismissError}
          style={{
            position: 'absolute',
            bottom: 72,
            left: 16,
            right: 16,
          }}
          accessibilityRole="button"
          accessibilityLabel={`Voice input error: ${errorMessage}. Tap to dismiss.`}
        >
          <View
            style={{
              backgroundColor: 'rgba(239,68,68,0.9)',
              padding: 12,
              borderRadius: 12,
              flexDirection: 'row',
              alignItems: 'center',
            }}
          >
            <Ionicons name="alert-circle" size={16} color="white" />
            <Text style={{ color: 'white', fontSize: 13, marginLeft: 8, flex: 1 }}>
              {errorMessage}
            </Text>
            <Ionicons name="close" size={16} color="white" />
          </View>
        </Pressable>
      )}
    </>
  );
}
