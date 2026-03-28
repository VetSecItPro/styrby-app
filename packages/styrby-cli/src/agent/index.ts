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
 * - Goose (Block/Square, Apache 2.0, MCP-native)
 * - Amp (Sourcegraph, deep mode with sub-agents)
 * - Crush (Charmbracelet, ACP-compatible, charm TUI)
 * - Kilo (Community, 500+ models, Memory Bank)
 * - Kiro (AWS, per-prompt credit billing)
 * - Droid (BYOK, multi-backend via LiteLLM)
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

  // Goose - Block/Square AI coding agent (Apache 2.0, MCP protocol)
  try {
    const { registerGooseAgent } = require('./factories/goose');
    registerGooseAgent();
  } catch {
    // Goose factory not available
  }

  // Amp - Sourcegraph AI coding agent (deep mode with sub-agents)
  try {
    const { registerAmpAgent } = require('./factories/amp');
    registerAmpAgent();
  } catch {
    // Amp factory not available
  }

  // Crush - Charmbracelet AI coding agent (ACP-compatible, charm TUI)
  try {
    const { registerCrushAgent } = require('./factories/crush');
    registerCrushAgent();
  } catch {
    // Crush factory not available
  }

  // Kilo - Community AI coding agent (500+ models, Memory Bank)
  try {
    const { registerKiloAgent } = require('./factories/kilo');
    registerKiloAgent();
  } catch {
    // Kilo factory not available
  }

  // Kiro - AWS AI coding agent (per-prompt credit billing)
  try {
    const { registerKiroAgent } = require('./factories/kiro');
    registerKiroAgent();
  } catch {
    // Kiro factory not available
  }

  // Droid - BYOK AI coding agent (multi-backend via LiteLLM)
  try {
    const { registerDroidAgent } = require('./factories/droid');
    registerDroidAgent();
  } catch {
    // Droid factory not available
  }
}

