/**
 * useVoiceRecording — the recording / transcription state machine for VoiceInput.
 *
 * Extracted verbatim from VoiceInput.tsx (Cluster A2 split) so the component
 * stays under the 400-LOC ceiling. Owns the recording lifecycle (permission →
 * record → stop → transcribe → confirm), the pulse animation, the auto-stop
 * timer, unmount teardown, and the press handlers. The component consumes the
 * returned state + handlers and only renders.
 *
 * The forward-reference refs (stopRecordingRef / transcribeAudioRef) preserve
 * the original TDZ-avoidance pattern: a callback declared earlier needs to call
 * one declared later without a circular dep, so it goes through a ref kept in
 * sync every render.
 *
 * @module components/voice/useVoiceRecording
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { Animated, Alert } from 'react-native';
import type { VoiceInputProps, RecordingState } from './types';
import { RECORDING_OPTIONS, MAX_RECORDING_MS } from './recording-options';

/** Everything VoiceInput needs to render the button + confirmation modal. */
export interface UseVoiceRecording {
  editedTranscript: string;
  setEditedTranscript: (text: string) => void;
  errorMessage: string;
  showConfirmModal: boolean;
  pulseAnim: Animated.Value | null;
  isRecording: boolean;
  isTranscribing: boolean;
  hasError: boolean;
  isDisabled: boolean;
  handleTogglePress: () => void;
  handleHoldPressIn: () => void;
  handleHoldPressOut: () => void;
  handleConfirm: () => void;
  handleDiscard: () => void;
  handleDismissError: () => void;
}

/**
 * @param params - The VoiceInput props (config, onTranscript, disabled).
 * @returns Recording state + handlers for the presentational component.
 */
export function useVoiceRecording({
  config,
  onTranscript,
  disabled = false,
}: VoiceInputProps): UseVoiceRecording {
  const [state, setState] = useState<RecordingState>('idle');
  // WHY only editedTranscript: the raw transcript is rendered into the editable
  // TextInput via setEditedTranscript; we never read the unedited value back.
  const [editedTranscript, setEditedTranscript] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [showConfirmModal, setShowConfirmModal] = useState(false);

  // WHY: store AudioRecorder ref so we can stop it from event handlers without
  // access to closure state. Typed unknown to avoid a module-level import.
  const recordingRef = useRef<unknown>(null);
  const autoStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // WHY this ref (M1.1): startRecording's auto-stop timer must call the latest
  // stopRecording, declared further down — adding it to deps would be a TDZ
  // error. The ref (synced below) always sees the freshest implementation.
  const stopRecordingRef = useRef<(() => Promise<void>) | null>(null);
  // Same TDZ avoidance for transcribeAudio (declared after stopRecording).
  const transcribeAudioRef = useRef<((uri: string) => Promise<void>) | null>(null);

  // WHY: ref-initializer (not inline `new Animated.Value(1)`) to avoid crashing
  // in test environments where Animated.Value may be unimplemented.
  const pulseAnimRef = useRef<Animated.Value | null>(null);
  if (!pulseAnimRef.current) {
    try {
      pulseAnimRef.current = new Animated.Value(1);
    } catch {
      // Animated.Value not available (test environment) — animations disabled
    }
  }
  const pulseAnim = pulseAnimRef.current;

  // --- Pulse Animation ------------------------------------------------------

  const startPulse = useCallback(() => {
    if (!pulseAnim) return;
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.3, duration: 500, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1.0, duration: 500, useNativeDriver: true }),
      ]),
    ).start();
  }, [pulseAnim]);

  const stopPulse = useCallback(() => {
    if (!pulseAnim) return;
    pulseAnim.stopAnimation();
    Animated.timing(pulseAnim, { toValue: 1, duration: 150, useNativeDriver: true }).start();
  }, [pulseAnim]);

  // --- Recording ------------------------------------------------------------

  const startRecording = useCallback(async () => {
    if (disabled || !config?.enabled) return;

    if (!config.transcriptionEndpoint) {
      Alert.alert(
        'No Transcription Endpoint',
        'Configure a Whisper-compatible transcription URL in Settings > Voice Input.',
        [{ text: 'OK' }],
      );
      return;
    }

    // SECURITY: only HTTPS endpoints (or localhost for dev). Audio contains
    // sensitive voice recordings — plain HTTP exposes it to eavesdropping.
    const endpoint = config.transcriptionEndpoint;
    const isSecure = endpoint.startsWith('https://');
    const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1|::1)(:\d+)?\//.test(endpoint);
    if (!isSecure && !isLocalhost) {
      Alert.alert(
        'Insecure Endpoint',
        'The transcription endpoint must use HTTPS to protect your voice data. ' +
          'HTTP is only allowed for localhost development.',
        [{ text: 'OK' }],
      );
      return;
    }

    try {
      // WHY dynamic import: avoid a hard crash if expo-audio is unavailable
      // (e.g. Expo Go); the component degrades to a disabled state instead.
      const { requestRecordingPermissionsAsync, setAudioModeAsync, AudioRecorder } = await import('expo-audio');

      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) {
        Alert.alert(
          'Microphone Permission',
          'Styrby needs microphone access for voice commands. Enable it in Settings.',
          [{ text: 'OK' }],
        );
        return;
      }

      // WHY allowsRecording (not allowsRecordingIOS): the expo-audio API.
      // playsInSilentMode ensures recording works with the iOS silent switch on.
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });

      // expo-audio uses an imperative AudioRecorder: prepare then record.
      const recorder = new AudioRecorder(RECORDING_OPTIONS);
      await recorder.prepareToRecordAsync();
      recorder.record();
      recordingRef.current = recorder;

      setState('recording');
      startPulse();

      // Auto-stop after MAX_RECORDING_MS via stopRecordingRef (latest impl).
      autoStopTimerRef.current = setTimeout(() => {
        void stopRecordingRef.current?.();
      }, MAX_RECORDING_MS);
    } catch (err) {
      setState('error');
      setErrorMessage('Could not start recording. Check microphone permissions.');
      if (__DEV__) console.error('[VoiceInput] startRecording error:', err);
    }
  }, [disabled, config, startPulse]);

  const stopRecording = useCallback(async () => {
    if (!recordingRef.current) return;

    if (autoStopTimerRef.current) {
      clearTimeout(autoStopTimerRef.current);
      autoStopTimerRef.current = null;
    }

    stopPulse();
    setState('transcribing');

    try {
      // AudioRecorder.stop() replaces expo-av's stopAndUnloadAsync(); .uri
      // replaces getURI(). The instance was created in startRecording.
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

      // transcribeAudioRef (M1.1): reach the freshest transcribeAudio without a
      // TDZ/circular dep.
      await transcribeAudioRef.current?.(uri);
    } catch (err) {
      setState('error');
      setErrorMessage('Recording stopped unexpectedly.');
      if (__DEV__) console.error('[VoiceInput] stopRecording error:', err);
    }
  }, [stopPulse]);

  // --- Transcription --------------------------------------------------------

  const transcribeAudio = useCallback(
    async (audioUri: string) => {
      if (!config?.transcriptionEndpoint) return;

      try {
        const formData = new FormData();
        // Whisper requires the file as multipart/form-data, field name 'file'.
        formData.append('file', {
          uri: audioUri,
          name: 'audio.m4a',
          type: 'audio/m4a',
        } as unknown as Blob);
        formData.append('model', 'whisper-1');
        formData.append('response_format', 'text');

        const headers: Record<string, string> = { Accept: 'application/json' };
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
    },
    [config],
  );

  // Keep the forward-reference refs in sync with the latest function values
  // (M1.1): runs every render so .current always points at the latest memoised
  // value, letting earlier callbacks invoke later ones without a TDZ error.
  useEffect(() => {
    stopRecordingRef.current = stopRecording;
    transcribeAudioRef.current = transcribeAudio;
  });

  // Unmount safety: if the user navigates away mid-recording, tear down the
  // auto-stop timer + recorder so the mic doesn't stay engaged. Empty deps so
  // cleanup runs exactly once on teardown; refs read at cleanup time.
  useEffect(() => {
    return () => {
      if (autoStopTimerRef.current) {
        clearTimeout(autoStopTimerRef.current);
        autoStopTimerRef.current = null;
      }
      const recorder = recordingRef.current as { stop?: () => unknown } | null;
      try {
        recorder?.stop?.();
      } catch {
        // Swallow: teardown must never throw.
      }
      recordingRef.current = null;
    };
  }, []);

  // --- Confirmation Modal Actions -------------------------------------------

  const handleConfirm = useCallback(() => {
    const text = editedTranscript.trim();
    if (text) {
      onTranscript(text);
    }
    setShowConfirmModal(false);
    setState('idle');
    setEditedTranscript('');
  }, [editedTranscript, onTranscript]);

  const handleDiscard = useCallback(() => {
    setShowConfirmModal(false);
    setState('idle');
    setEditedTranscript('');
  }, []);

  const handleDismissError = useCallback(() => {
    setState('idle');
    setErrorMessage('');
  }, []);

  // --- Button Press Handlers ------------------------------------------------

  const handleTogglePress = useCallback(() => {
    if (state === 'recording') {
      void stopRecording();
    } else if (state === 'idle') {
      void startRecording();
    } else if (state === 'error') {
      handleDismissError();
    }
  }, [state, startRecording, stopRecording, handleDismissError]);

  const handleHoldPressIn = useCallback(() => {
    if (state === 'idle') {
      void startRecording();
    }
  }, [state, startRecording]);

  const handleHoldPressOut = useCallback(() => {
    if (state === 'recording') {
      void stopRecording();
    }
  }, [state, stopRecording]);

  // --- Derived State --------------------------------------------------------

  const isRecording = state === 'recording';
  const isTranscribing = state === 'transcribing';
  const hasError = state === 'error';
  const isDisabled = disabled || !config?.enabled || isTranscribing || state === 'confirming';

  return {
    editedTranscript,
    setEditedTranscript,
    errorMessage,
    showConfirmModal,
    pulseAnim,
    isRecording,
    isTranscribing,
    hasError,
    isDisabled,
    handleTogglePress,
    handleHoldPressIn,
    handleHoldPressOut,
    handleConfirm,
    handleDiscard,
    handleDismissError,
  };
}
