/**
 * Styrby Relay Types
 *
 * Defines the message types and channel structure for CLI ↔ Mobile communication
 * via Supabase Realtime channels.
 *
 * Architecture:
 * - Each user has a private channel: `relay:{user_id}:{channel_suffix}`
 * - The channel suffix is derived from the shared pairing secret via SHA-256
 *   so that only parties who completed the pairing flow know the full channel name.
 * - CLI and mobile both subscribe to the same channel
 * - Messages are broadcast to all connected devices
 * - Presence tracks online status of CLI and mobile
 *
 * Security:
 * - Without a channelSecret, the channel falls back to `relay:{user_id}` for
 *   backward compatibility with older clients that pre-date SEC-RELAY-001.
 * - All incoming messages are validated at runtime with Zod before processing
 *   (SEC-RELAY-002). Malformed messages are dropped with a console.warn.
 */

// ============================================================================
// Channel Types
// ============================================================================

import { z } from 'zod';

/**
 * Channel name format: relay:{user_id} or relay:{user_id}:{suffix}
 */
export type RelayChannelName = `relay:${string}`;

/**
 * Device types that can connect to the relay
 */
export type DeviceType = 'cli' | 'mobile' | 'web';

// AgentType and code review types are imported from main types
import type { AgentType, CodeReviewStatus, ReviewFile, ReviewComment } from '../types.js';
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
    /**
     * Cryptographic nonce for replay protection.
     *
     * WHY: The Supabase Realtime channel is broadcast — any device subscribed
     * to the user's relay channel receives all messages. Without a nonce, a
     * compromised device or network observer could re-broadcast a captured
     * `permission_response` (approved=true) for a different, future request
     * that happens to share the same `request_id` structure.
     *
     * The CLI generates this nonce (crypto.randomUUID()) before sending the
     * request. The mobile app MUST echo it back verbatim in `request_nonce`
     * on the PermissionResponseMessage. The CLI MUST reject any response where
     * `request_nonce !== nonce`, treating it as a replay or spoofed response.
     *
     * Format: UUID v4 string (e.g. "550e8400-e29b-41d4-a716-446655440000")
     */
    nonce: string;
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
    /**
     * Nonce echoed from the corresponding PermissionRequestMessage.
     *
     * WHY: Binds this response to exactly one specific request. The CLI MUST
     * verify that `request_nonce` matches the `nonce` it sent in the request
     * before acting on this response. A mismatch indicates a replayed,
     * stale, or spoofed response and MUST be rejected without executing the
     * permitted tool.
     *
     * Consumer responsibility: validation is enforced by the CLI and mobile
     * consumers, not this type definition. This field is required to make the
     * contract explicit at the type level so consumers cannot omit it.
     */
    request_nonce: string;
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
 * Code review request from CLI to mobile.
 *
 * WHY: The agent generates code changes and needs a human to review them.
 * The CLI sends this message to notify the mobile app that a review is ready.
 * The mobile reviewer then sends a code_review_response back with their decision.
 */
export interface CodeReviewRequestMessage extends BaseRelayMessage {
  type: 'code_review_request';
  payload: {
    /** UUID of the code review */
    review_id: string;
    /** UUID of the session that generated these changes */
    session_id: string;
    /** Files changed with diffs */
    files: ReviewFile[];
    /** Optional summary of the changes */
    summary?: string;
    /** ISO 8601 timestamp when the review was created */
    created_at: string;
  };
}

/**
 * Code review response from mobile to CLI.
 *
 * WHY: After the reviewer makes a decision (approve/reject/changes_requested),
 * this message is sent back so the CLI can continue the agent workflow.
 */
export interface CodeReviewResponseMessage extends BaseRelayMessage {
  type: 'code_review_response';
  payload: {
    /** UUID of the code review being responded to */
    review_id: string;
    /** The reviewer's decision */
    status: CodeReviewStatus;
    /** Optional reviewer comments */
    comments?: ReviewComment[];
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
  | AckMessage
  | CodeReviewRequestMessage
  | CodeReviewResponseMessage;

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
  /**
   * Automatic reconnect attempt in progress.
   * Emitted each time the relay schedules a retry after an unexpected drop.
   * UI should show "Connection lost, retrying... (attempt N)" copy.
   */
  reconnecting: { attempt: number; delayMs: number };
  /** Index signature for EventEmitter compatibility */
  [key: string]: unknown;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Derive a 16-character hex suffix from a shared secret using SHA-256.
 *
 * WHY: The pairing flow gives both CLI and mobile a shared secret (the raw
 * pairing token bytes). By hashing that secret we produce a stable, short
 * suffix that neither party has to exchange separately — they can each
 * compute it independently. Using only the first 16 hex chars (64-bit) is
 * enough entropy to make channel names unguessable while keeping them short.
 *
 * @param sharedSecret - The shared secret bytes (e.g., raw pairing token)
 * @returns A 16-character lowercase hex string
 *
 * @example
 * const suffix = await deriveChannelSuffix(pairingTokenBytes);
 * // => "a3f8c2d1e4b07f91"
 */
export async function deriveChannelSuffix(sharedSecret: Uint8Array | string): Promise<string> {
  const encoder = new TextEncoder();
  // WHY the copy: crypto.subtle.digest() requires a BufferSource typed as
  // ArrayBuffer. A Uint8Array may wrap a SharedArrayBuffer (whose type is
  // incompatible). Copying bytes into a fresh Uint8Array always gives us a
  // plain ArrayBuffer that satisfies the API's type constraint.
  const raw = typeof sharedSecret === 'string' ? encoder.encode(sharedSecret) : sharedSecret;
  const data: ArrayBuffer = new Uint8Array(raw).buffer as ArrayBuffer;
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  // First 16 hex chars = 64 bits of entropy — sufficient to make channel
  // names unguessable even if the userId is known to an attacker.
  return hex.slice(0, 16);
}

/**
 * Generate a channel name for a user.
 *
 * When a `channelSuffix` is provided (derived from the shared pairing secret
 * via `deriveChannelSuffix`), the channel name is `relay:{userId}:{suffix}`.
 * This prevents attackers who know only a UUID from subscribing to the channel.
 *
 * Falls back to `relay:{userId}` when no suffix is available so that older
 * clients remain compatible during a rolling upgrade.
 *
 * @param userId - The Supabase auth user ID
 * @param channelSuffix - Optional 16-char hex suffix from `deriveChannelSuffix`
 * @returns The fully-qualified Supabase Realtime channel name
 *
 * @example
 * // Legacy (backward-compatible)
 * getChannelName('abc-123');            // => "relay:abc-123"
 *
 * // Secure (suffix derived from shared pairing secret)
 * getChannelName('abc-123', 'a3f8c2d1e4b07f91');  // => "relay:abc-123:a3f8c2d1e4b07f91"
 */
export function getChannelName(userId: string, channelSuffix?: string): RelayChannelName {
  if (channelSuffix) {
    return `relay:${userId}:${channelSuffix}`;
  }
  return `relay:${userId}`;
}

// ============================================================================
// Zod Schemas — Runtime Validation (SEC-RELAY-002)
// ============================================================================

/**
 * WHY runtime validation: Supabase Realtime delivers payloads as `unknown`.
 * Without validation, a malformed or malicious broadcast could pass invalid
 * data into the rest of the application as a typed `RelayMessage`, silently
 * corrupting state or causing runtime crashes. Zod parses and rejects anything
 * that doesn't conform to the expected shape before it reaches application code.
 */

/** Zod schema for base relay message fields shared by all message types */
const BaseRelayMessageSchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  sender_device_id: z.string(),
  sender_type: z.enum(['cli', 'mobile', 'web']),
});

/** Zod schema for AgentType */
const AgentTypeSchema = z.enum([
  'claude', 'codex', 'gemini', 'opencode', 'aider', 'goose',
  'amp', 'crush', 'kilo', 'kiro', 'droid',
]);

/** Zod schema for ChatMessage */
export const ChatMessageSchema = BaseRelayMessageSchema.extend({
  type: z.literal('chat'),
  payload: z.object({
    content: z.string(),
    agent: AgentTypeSchema,
    session_id: z.string().optional(),
  }),
});

/** Zod schema for AgentResponseMessage */
export const AgentResponseMessageSchema = BaseRelayMessageSchema.extend({
  type: z.literal('agent_response'),
  payload: z.object({
    content: z.string(),
    agent: AgentTypeSchema,
    session_id: z.string(),
    is_streaming: z.boolean(),
    is_complete: z.boolean(),
    tokens: z
      .object({
        input: z.number(),
        output: z.number(),
        cache_read: z.number().optional(),
        cache_write: z.number().optional(),
      })
      .optional(),
  }),
});

/** Zod schema for PermissionRequestMessage */
export const PermissionRequestMessageSchema = BaseRelayMessageSchema.extend({
  type: z.literal('permission_request'),
  payload: z.object({
    request_id: z.string(),
    session_id: z.string(),
    agent: AgentTypeSchema,
    tool_name: z.string(),
    tool_args: z.record(z.unknown()),
    risk_level: z.enum(['low', 'medium', 'high', 'critical']),
    description: z.string(),
    affected_files: z.array(z.string()).optional(),
    expires_at: z.string(),
    /** UUID v4 nonce for replay-attack protection (SEC-RELAY-003) */
    nonce: z.string(),
  }),
});

/** Zod schema for PermissionResponseMessage */
export const PermissionResponseMessageSchema = BaseRelayMessageSchema.extend({
  type: z.literal('permission_response'),
  payload: z.object({
    request_id: z.string(),
    approved: z.boolean(),
    modified_args: z.record(z.unknown()).optional(),
    remember: z.boolean().optional(),
    /** Nonce echoed from the PermissionRequestMessage for replay-attack binding */
    request_nonce: z.string(),
  }),
});

/** Zod schema for SessionStateMessage */
export const SessionStateMessageSchema = BaseRelayMessageSchema.extend({
  type: z.literal('session_state'),
  payload: z.object({
    session_id: z.string(),
    agent: AgentTypeSchema,
    state: z.enum(['idle', 'thinking', 'executing', 'waiting_permission', 'error']),
    cwd: z.string().optional(),
    context_window: z
      .object({
        used: z.number(),
        max: z.number(),
        percentage: z.number(),
      })
      .optional(),
    active_file: z.string().optional(),
    error: z
      .object({
        type: z.enum(['agent', 'network', 'build', 'styrby']),
        message: z.string(),
        recoverable: z.boolean(),
      })
      .optional(),
  }),
});

/** Zod schema for CostUpdateMessage */
export const CostUpdateMessageSchema = BaseRelayMessageSchema.extend({
  type: z.literal('cost_update'),
  payload: z.object({
    session_id: z.string(),
    agent: AgentTypeSchema,
    cost_usd: z.number(),
    session_total_usd: z.number(),
    tokens: z.object({
      input: z.number(),
      output: z.number(),
      cache_read: z.number().optional(),
      cache_write: z.number().optional(),
    }),
    model: z.string(),
  }),
});

/** Zod schema for CommandMessage */
export const CommandMessageSchema = BaseRelayMessageSchema.extend({
  type: z.literal('command'),
  payload: z.object({
    action: z.enum([
      'cancel',
      'interrupt',
      'new_session',
      'switch_agent',
      'end_session',
      'sync_history',
      'ping',
    ]),
    params: z.record(z.unknown()).optional(),
  }),
});

/** Zod schema for AckMessage */
export const AckMessageSchema = BaseRelayMessageSchema.extend({
  type: z.literal('ack'),
  payload: z.object({
    ack_id: z.string(),
    success: z.boolean(),
    error: z.string().optional(),
  }),
});

/** Zod schema for ReviewFile */
const ReviewFileSchema = z.object({
  path: z.string(),
  additions: z.number(),
  deletions: z.number(),
  diff: z.string(),
});

/** Zod schema for ReviewComment */
const ReviewCommentSchema = z.object({
  id: z.string(),
  filePath: z.string(),
  lineNumber: z.number().optional(),
  body: z.string(),
  createdAt: z.string(),
});

/** Zod schema for CodeReviewRequestMessage */
export const CodeReviewRequestMessageSchema = BaseRelayMessageSchema.extend({
  type: z.literal('code_review_request'),
  payload: z.object({
    review_id: z.string(),
    session_id: z.string(),
    files: z.array(ReviewFileSchema),
    summary: z.string().optional(),
    created_at: z.string(),
  }),
});

/** Zod schema for CodeReviewResponseMessage */
export const CodeReviewResponseMessageSchema = BaseRelayMessageSchema.extend({
  type: z.literal('code_review_response'),
  payload: z.object({
    review_id: z.string(),
    status: z.enum(['pending', 'approved', 'rejected', 'changes_requested']),
    comments: z.array(ReviewCommentSchema).optional(),
  }),
});

/**
 * Zod discriminated union schema for all relay message types.
 *
 * Use `RelayMessageSchema.safeParse(payload)` to validate an incoming
 * broadcast payload before treating it as a typed RelayMessage.
 *
 * @example
 * const result = RelayMessageSchema.safeParse(rawPayload);
 * if (!result.success) {
 *   console.warn('[Relay] Dropped malformed message:', result.error.issues);
 *   return;
 * }
 * const message = result.data; // fully typed RelayMessage
 */
export const RelayMessageSchema = z.discriminatedUnion('type', [
  ChatMessageSchema,
  AgentResponseMessageSchema,
  PermissionRequestMessageSchema,
  PermissionResponseMessageSchema,
  SessionStateMessageSchema,
  CostUpdateMessageSchema,
  CommandMessageSchema,
  AckMessageSchema,
  CodeReviewRequestMessageSchema,
  CodeReviewResponseMessageSchema,
]);

/**
 * Generate a unique message ID.
 *
 * Uses crypto.randomUUID() for cryptographic uniqueness.
 * Available in Node.js 20+, modern browsers, Deno, Bun, and Hermes (React Native).
 *
 * @returns A unique message ID string
 */
export function generateMessageId(): string {
  return `msg_${crypto.randomUUID()}`;
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
