/**
 * Styrby Relay Types
 *
 * Defines the message types and channel structure for CLI ↔ Mobile communication
 * via Supabase Realtime channels.
 *
 * Architecture:
 * - Each user has a private channel: `relay:{user_id}`
 * - CLI and mobile both subscribe to the same channel
 * - Messages are broadcast to all connected devices
 * - Presence tracks online status of CLI and mobile
 */

// ============================================================================
// Channel Types
// ============================================================================

/**
 * Channel name format: relay:{user_id}
 */
export type RelayChannelName = `relay:${string}`;

/**
 * Device types that can connect to the relay
 */
export type DeviceType = 'cli' | 'mobile' | 'web';

// AgentType is imported from main types
import type { AgentType } from '../types.js';
export type { AgentType };

// ============================================================================
// Presence Types
// ============================================================================

/**
 * Presence state for a connected device
 */
export interface PresenceState {
  /** Unique device identifier (machine_id for CLI, device_id for mobile) */
  device_id: string;
  /** Type of device */
  device_type: DeviceType;
  /** User ID owning this device */
  user_id: string;
  /** Current active agent (CLI only) */
  active_agent?: AgentType;
  /** Session ID if in active session (CLI only) */
  session_id?: string;
  /** Human-readable device name */
  device_name?: string;
  /** Platform (darwin, linux, windows, ios, android) */
  platform?: string;
  /** When device came online */
  online_at: string;
}

// ============================================================================
// Message Types
// ============================================================================

/**
 * Base interface for all relay messages
 */
interface BaseRelayMessage {
  /** Unique message ID */
  id: string;
  /** ISO timestamp */
  timestamp: string;
  /** Sender device ID */
  sender_device_id: string;
  /** Sender device type */
  sender_type: DeviceType;
}

/**
 * Chat message from mobile to CLI
 */
export interface ChatMessage extends BaseRelayMessage {
  type: 'chat';
  payload: {
    /** The user's message text */
    content: string;
    /** Target agent to send to */
    agent: AgentType;
    /** Session ID to send to (optional, uses active session if omitted) */
    session_id?: string;
  };
}

/**
 * Agent response from CLI to mobile (streaming)
 */
export interface AgentResponseMessage extends BaseRelayMessage {
  type: 'agent_response';
  payload: {
    /** The agent's response text (may be partial for streaming) */
    content: string;
    /** Which agent responded */
    agent: AgentType;
    /** Session ID */
    session_id: string;
    /** Whether this is a streaming chunk or final response */
    is_streaming: boolean;
    /** Whether this is the final chunk */
    is_complete: boolean;
    /** Token usage for this response */
    tokens?: {
      input: number;
      output: number;
      cache_read?: number;
      cache_write?: number;
    };
  };
}

/**
 * Permission request from CLI to mobile
 */
export interface PermissionRequestMessage extends BaseRelayMessage {
  type: 'permission_request';
  payload: {
    /** Unique request ID for approval/denial */
    request_id: string;
    /** Session ID */
    session_id: string;
    /** Agent requesting permission */
    agent: AgentType;
    /** Tool being requested */
    tool_name: string;
    /** Tool arguments/parameters */
    tool_args: Record<string, unknown>;
    /** Risk level assessment */
    risk_level: 'low' | 'medium' | 'high' | 'critical';
    /** Human-readable description of what the tool will do */
    description: string;
    /** Files affected (if applicable) */
    affected_files?: string[];
    /** Request expires at (ISO timestamp) */
    expires_at: string;
  };
}

/**
 * Permission response from mobile to CLI
 */
export interface PermissionResponseMessage extends BaseRelayMessage {
  type: 'permission_response';
  payload: {
    /** Request ID being responded to */
    request_id: string;
    /** Whether permission is granted */
    approved: boolean;
    /** Optional modified args (if user edited) */
    modified_args?: Record<string, unknown>;
    /** Auto-approve similar requests in future */
    remember?: boolean;
  };
}

/**
 * Session state update from CLI
 */
export interface SessionStateMessage extends BaseRelayMessage {
  type: 'session_state';
  payload: {
    /** Session ID */
    session_id: string;
    /** Agent type */
    agent: AgentType;
    /** Current state */
    state: 'idle' | 'thinking' | 'executing' | 'waiting_permission' | 'error';
    /** Working directory */
    cwd?: string;
    /** Current context window usage */
    context_window?: {
      used: number;
      max: number;
      percentage: number;
    };
    /** Active file being edited (if any) */
    active_file?: string;
    /** Error details (if state is 'error') */
    error?: {
      type: 'agent' | 'network' | 'build' | 'styrby';
      message: string;
      recoverable: boolean;
    };
  };
}

/**
 * Cost update from CLI
 */
export interface CostUpdateMessage extends BaseRelayMessage {
  type: 'cost_update';
  payload: {
    /** Session ID */
    session_id: string;
    /** Agent type */
    agent: AgentType;
    /** Incremental cost in USD */
    cost_usd: number;
    /** Cumulative session cost */
    session_total_usd: number;
    /** Token breakdown */
    tokens: {
      input: number;
      output: number;
      cache_read?: number;
      cache_write?: number;
    };
    /** Model used */
    model: string;
  };
}

/**
 * Command from mobile to CLI (non-chat actions)
 */
export interface CommandMessage extends BaseRelayMessage {
  type: 'command';
  payload: {
    /** Command action */
    action:
      | 'cancel' // Cancel current operation
      | 'interrupt' // Send interrupt signal
      | 'new_session' // Start new session
      | 'switch_agent' // Switch to different agent
      | 'end_session' // End current session
      | 'sync_history' // Request session history sync
      | 'ping'; // Heartbeat ping
    /** Additional action parameters */
    params?: Record<string, unknown>;
  };
}

/**
 * Acknowledgment message (for delivery confirmation)
 */
export interface AckMessage extends BaseRelayMessage {
  type: 'ack';
  payload: {
    /** ID of message being acknowledged */
    ack_id: string;
    /** Whether message was processed successfully */
    success: boolean;
    /** Error message if not successful */
    error?: string;
  };
}

/**
 * Union type of all relay messages
 */
export type RelayMessage =
  | ChatMessage
  | AgentResponseMessage
  | PermissionRequestMessage
  | PermissionResponseMessage
  | SessionStateMessage
  | CostUpdateMessage
  | CommandMessage
  | AckMessage;

/**
 * Message type discriminator
 */
export type RelayMessageType = RelayMessage['type'];

// ============================================================================
// Channel Events
// ============================================================================

/**
 * Events emitted by the relay channel
 */
export interface RelayChannelEvents {
  /** New message received */
  message: RelayMessage;
  /** Device came online */
  presence_join: PresenceState;
  /** Device went offline */
  presence_leave: { device_id: string };
  /** Presence state updated */
  presence_update: PresenceState;
  /** Channel subscription confirmed */
  subscribed: void;
  /** Channel error occurred */
  error: { message: string; code?: string };
  /** Channel closed */
  closed: { reason: string };
  /** Index signature for EventEmitter compatibility */
  [key: string]: unknown;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Generate a channel name for a user
 */
export function getChannelName(userId: string): RelayChannelName {
  return `relay:${userId}`;
}

/**
 * Generate a unique message ID
 */
export function generateMessageId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Create a base message with common fields
 */
export function createBaseMessage(
  deviceId: string,
  deviceType: DeviceType
): Omit<BaseRelayMessage, 'type' | 'payload'> {
  return {
    id: generateMessageId(),
    timestamp: new Date().toISOString(),
    sender_device_id: deviceId,
    sender_type: deviceType,
  };
}
