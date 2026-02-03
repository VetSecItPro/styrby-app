/**
 * Styrby CLI Library Exports
 *
 * Re-exports core functionality for external use.
 * This module provides the public API for the CLI.
 *
 * @module lib
 */

// Agent types and interfaces
export type {
  AgentBackend,
  AgentId,
  AgentTransport,
  AgentBackendConfig,
  SessionId,
  ToolCallId,
  AgentMessage,
  AgentMessageHandler,
  StartSessionResult,
} from './agent/core/AgentBackend';

// Agent registry
export { AgentRegistry } from './agent/core/AgentRegistry';

// Re-export shared types
export type {
  AgentType,
  SessionStatus,
  ConnectionStatus,
  ErrorSource,
  RiskLevel,
  PermissionRequest,
  SessionCost,
  SubscriptionTier,
} from 'styrby-shared';

/**
 * Version of the Styrby CLI
 */
export const VERSION = '0.1.0';

/**
 * Check if running in development mode
 */
export const isDev = process.env.NODE_ENV === 'development';
