/**
 * Agent Module - Universal agent backend abstraction
 *
 * This module provides the core abstraction layer for different AI agents
 * (Claude, Codex, Gemini, OpenCode, Aider, etc.) that can be controlled through
 * the Happy CLI and mobile app.
 */

// Core types, interfaces, and registry - re-export from core/
export type {
  AgentMessage,
  AgentMessageHandler,
  AgentBackend,
  AgentBackendConfig,
  AcpAgentConfig,
  McpServerConfig,
  AgentTransport,
  AgentId,
  SessionId,
  ToolCallId,
  StartSessionResult,
  AgentFactory,
  AgentFactoryOptions,
} from './core';

export { AgentRegistry, agentRegistry } from './core';

// ACP backend (low-level)
export * from './acp';

// Agent factories (high-level, recommended)
export * from './factories';

/**
 * Initialize all agent backends and register them with the global registry.
 *
 * Call this function during application startup to make all agents available.
 * Agents are registered dynamically based on which factory modules are available.
 *
 * Registered agents:
 * - Gemini CLI (Google AI)
 * - OpenCode (terminal-based AI coding assistant)
 * - Aider (AI pair programming tool)
 */
export function initializeAgents(): void {
  // Import and register agents from factories
  // Each factory is optional - if it doesn't exist, we skip registration

  // Gemini - Google AI
  try {
    const { registerGeminiAgent } = require('./factories/gemini');
    registerGeminiAgent();
  } catch {
    // Gemini factory not available
  }

  // OpenCode - Terminal-based AI coding assistant with JSON output support
  try {
    const { registerOpenCodeAgent } = require('./factories/opencode');
    registerOpenCodeAgent();
  } catch {
    // OpenCode factory not available
  }

  // Aider - AI pair programming tool
  try {
    const { registerAiderAgent } = require('./factories/aider');
    registerAiderAgent();
  } catch {
    // Aider factory not available
  }
}

