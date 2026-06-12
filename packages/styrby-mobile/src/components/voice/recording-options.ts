/**
 * Audio recording configuration for VoiceInput.
 *
 * Extracted from VoiceInput.tsx (Cluster A2 split).
 *
 * @module components/voice/recording-options
 */

/**
 * expo-audio RecordingOptions.
 *
 * WHY 16 kHz mono: Whisper was trained primarily on speech at that rate.
 * Higher rates waste bandwidth; lower rates degrade accuracy. expo-audio uses
 * a flat structure with optional ios/android/web sub-objects for overrides.
 */
export const RECORDING_OPTIONS = {
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
    audioQuality: 96 as const, // AudioQuality.MEDIUM
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
 * WHY: prevents accidental runaway recordings and keeps transcription costs
 * manageable.
 */
export const MAX_RECORDING_MS = 3 * 60 * 1000;
