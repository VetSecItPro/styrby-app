/**
 * Type definitions for the session replay feature.
 *
 * The session replay allows users to step through past sessions like a debugger,
 * watching messages appear with original timing.
 */

/**
 * Represents a message in the session replay.
 * Maps to the session_messages table schema.
 */
export interface ReplayMessage {
  /** Unique message identifier */
  id: string;
  /** ID of the session this message belongs to */
  session_id: string;
  /** Message ordering within session */
  sequence_number: number;
  /** Type of message (determines rendering) */
  message_type:
    | 'user_prompt'
    | 'agent_response'
    | 'agent_thinking'
    | 'permission_request'
    | 'permission_response'
    | 'tool_use'
    | 'tool_result'
    | 'error'
    | 'system';
  /** Encrypted content (E2E encrypted for security) */
  content_encrypted: string | null;
  /** Risk level for permission requests */
  risk_level: 'low' | 'medium' | 'high' | null;
  /** Whether permission was granted */
  permission_granted: boolean | null;
  /** Tool name for tool_use messages */
  tool_name: string | null;
  /** Response duration in ms */
  duration_ms: number | null;
  /** Extensible metadata */
  metadata: Record<string, unknown> | null;
  /** ISO 8601 timestamp */
  created_at: string;
}

/**
 * Playback speed options for the replay player.
 * 1 = real-time, 0.5 = half speed, 2 = double speed, etc.
 */
export type PlaybackSpeed = 0.5 | 1 | 2 | 4;

/**
 * Playback state for the replay player.
 */
export type PlaybackState = 'playing' | 'paused' | 'stopped';

/**
 * Props for the ReplayPlayer component.
 */
export interface ReplayPlayerProps {
  /** The session ID for context */
  sessionId: string;
  /** All messages in the session, sorted by timestamp */
  messages: ReplayMessage[];
  /** Callback when a message is reached during playback */
  onMessageReached?: (messageId: string, index: number) => void;
  /** Callback when playback state changes */
  onPlaybackStateChange?: (state: PlaybackState) => void;
  /** Callback when the replay completes */
  onReplayComplete?: () => void;
}

/**
 * Props for the ReplayControls component.
 */
export interface ReplayControlsProps {
  /** Whether the player is currently playing */
  isPlaying: boolean;
  /** Current playback speed */
  speed: PlaybackSpeed;
  /** Current position in milliseconds from session start */
  currentTimeMs: number;
  /** Total duration in milliseconds */
  totalDurationMs: number;
  /** Current message index */
  currentMessageIndex: number;
  /** Total number of messages */
  totalMessages: number;
  /** Callback to toggle play/pause */
  onTogglePlay: () => void;
  /** Callback to change playback speed */
  onSpeedChange: (speed: PlaybackSpeed) => void;
  /** Callback to seek to a specific time */
  onSeek: (timeMs: number) => void;
  /** Callback to jump to a specific message */
  onJumpToMessage: (index: number) => void;
}
