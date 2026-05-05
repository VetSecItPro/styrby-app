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
 * Version of the Styrby CLI.
 *
 * WHY re-exported from cli/version (ESC-3): a single source of truth for the
 * CLI version. cli/version reads package.json at module-load via JSON
 * import, so neither this file nor that one carries a hand-synced literal
 * that can drift across releases.
 */
export { VERSION } from './cli/version';

/**
 * Check if running in development mode
 */
export const isDev = process.env.NODE_ENV === 'development';
