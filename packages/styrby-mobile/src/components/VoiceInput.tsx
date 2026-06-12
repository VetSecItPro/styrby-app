/**
 * VoiceInput Component
 *
 * Microphone button that records audio and transcribes it via a configurable
 * Whisper-compatible endpoint. Two interaction modes:
 * - 'hold': press and hold to record, release to transcribe (push-to-talk)
 * - 'toggle': tap to start, tap again to stop and transcribe
 *
 * The recording / transcription state machine lives in {@link useVoiceRecording}
 * (Cluster A2 split); this file is the presentational shell (button, recording
 * label, confirmation modal, error toast).
 *
 * TIER GATE (mobile-side): Voice commands are a premium feature. Callers MUST
 * check the user's subscription tier before rendering VoiceInput — the `config`
 * prop being null is not sufficient.
 *
 *   {userTier === 'growth' ? (
 *     <VoiceInput config={voiceConfig} onTranscript={handleTranscript} />
 *   ) : (
 *     <UpgradePrompt feature="Voice commands" requiredTier="growth" />
 *   )}
 *
 * WHY expo-audio: Expo's official audio package (replaces deprecated expo-av);
 * Whisper-compatible endpoints are widely available and keep Styrby
 * vendor-neutral.
 *
 * @module components/VoiceInput
 */

import { View, Text, Pressable, Modal, TextInput, ActivityIndicator, Animated, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { VoiceInputProps } from './voice/types';
import { useVoiceRecording } from './voice/useVoiceRecording';

// Re-export the public types so existing importers of './VoiceInput' are
// unchanged.
export type { VoiceInputProps, RecordingState } from './voice/types';

/**
 * Voice-to-text input button for the chat screen.
 *
 * @param props - VoiceInputProps.
 * @returns React element, or null when voice is disabled.
 */
export function VoiceInput({ config, onTranscript, disabled = false }: VoiceInputProps) {
  const {
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
  } = useVoiceRecording({ config, onTranscript, disabled });

  // WHY: button color communicates state — orange recording, red error, zinc idle.
  const buttonColor = isRecording ? '#f97316' : hasError ? '#ef4444' : '#3f3f46';

  const iconName: keyof typeof Ionicons.glyphMap = isRecording
    ? 'stop-circle'
    : hasError
      ? 'alert-circle'
      : isTranscribing
        ? 'hourglass'
        : 'mic';

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
          style={{ position: 'absolute', bottom: 72, left: 0, right: 0, alignItems: 'center' }}
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
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' }}>
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
                <Text style={{ color: 'white', fontWeight: '700', fontSize: 15 }}>Send Message</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* Error toast (non-modal, auto-dismisses on next tap) */}
      {hasError && (
        <Pressable
          onPress={handleDismissError}
          style={{ position: 'absolute', bottom: 72, left: 16, right: 16 }}
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
            <Text style={{ color: 'white', fontSize: 13, marginLeft: 8, flex: 1 }}>{errorMessage}</Text>
            <Ionicons name="close" size={16} color="white" />
          </View>
        </Pressable>
      )}
    </>
  );
}
