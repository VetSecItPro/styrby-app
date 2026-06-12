/**
 * VoiceInput types.
 *
 * Extracted from VoiceInput.tsx (Cluster A2 split).
 *
 * @module components/voice/types
 */

import type { VoiceInputConfig } from 'styrby-shared';

/** Props for the VoiceInput component. */
export interface VoiceInputProps {
  /**
   * Voice input configuration (mode, endpoint, key). When null or disabled, the
   * button renders in a disabled/hidden state.
   */
  config: VoiceInputConfig | null;

  /**
   * Called when the user confirms a transcript to send. The parent chat screen
   * should call its handleSend with this text.
   *
   * @param transcript - The confirmed transcribed text.
   */
  onTranscript: (transcript: string) => void;

  /**
   * Whether the parent input is disabled (e.g. no relay connection). Prevents
   * voice recording when the chat cannot accept messages.
   */
  disabled?: boolean;
}

/** Recording lifecycle state. */
export type RecordingState = 'idle' | 'recording' | 'transcribing' | 'confirming' | 'error';
