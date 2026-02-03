/**
 * API Types
 *
 * Type definitions for the Styrby API layer.
 * These types define the contract between CLI and mobile/web clients.
 *
 * WHY: This module contains stubs for Happy Coder's API types.
 * We're keeping the type signatures to maintain compatibility with
 * the forked agent code while replacing the implementation with Supabase.
 *
 * @module api/types
 */

/**
 * Agent type for this module
 */
type AgentType = 'claude' | 'codex' | 'gemini';

/**
 * Session state as seen by the API
 */
export interface ApiSession {
  /** Unique session identifier */
  sessionId: string;
  /** Type of agent running this session */
  agentType: AgentType;
  /** Current session status */
  status: 'starting' | 'running' | 'idle' | 'stopped' | 'error';
  /** Project directory path */
  projectPath: string;
  /** When the session was created */
  createdAt: string;
  /** Last activity timestamp */
  lastActivityAt: string;
}

/**
 * Message sent through the API relay
 */
export interface ApiMessage {
  /** Unique message ID */
  id: string;
  /** Session this message belongs to */
  sessionId: string;
  /** Message type (matches AgentMessage types) */
  type: string;
  /** Message payload (varies by type) */
  payload: unknown;
  /** When the message was created */
  timestamp: string;
}

/**
 * Permission request as sent to mobile
 */
export interface ApiPermissionRequest {
  /** Unique permission request ID */
  id: string;
  /** Session requesting permission */
  sessionId: string;
  /** What the agent wants to do */
  action: string;
  /** Human-readable description */
  description: string;
  /** Risk level for UI display */
  riskLevel: 'low' | 'medium' | 'high';
  /** Full payload for the action */
  payload: unknown;
}

/**
 * Permission response from mobile
 */
export interface ApiPermissionResponse {
  /** Permission request ID being responded to */
  requestId: string;
  /** Whether permission was granted */
  approved: boolean;
}

/**
 * Connection state for the relay
 */
export type ApiConnectionState = 'connecting' | 'connected' | 'disconnected' | 'error';

/**
 * Events emitted by the API layer
 */
export interface ApiEvents {
  'connection:state': (state: ApiConnectionState) => void;
  'session:created': (session: ApiSession) => void;
  'session:updated': (session: ApiSession) => void;
  'session:ended': (sessionId: string) => void;
  'message:received': (message: ApiMessage) => void;
  'permission:request': (request: ApiPermissionRequest) => void;
  'permission:response': (response: ApiPermissionResponse) => void;
  'error': (error: Error) => void;
}

/**
 * Mode for Claude Code operation
 */
export type ClaudeMode = 'local' | 'remote';

/**
 * Session update payload (for compatibility with forked code)
 */
export interface SessionUpdate {
  type: string;
  payload?: unknown;
  [key: string]: unknown;
}
