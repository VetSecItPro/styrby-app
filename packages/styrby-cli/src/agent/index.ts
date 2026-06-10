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
export async function initializeAgents(): Promise<void> {
  // WHY async dynamic import (not require()): this package is ESM
  // ("type": "module"), where bare `require()` is undefined. Under tsx every
  // require() in the previous implementation threw and was silently swallowed
  // by a per-factory try/catch, so NO agent registered at runtime — the CLI
  // reported "Registered agents: none registered" and every `styrby start
  // --agent <x>` failed. `await import('./factories')` loads the factory barrel
  // lazily HERE (only on `start`, not on every CLI command — preserving the
  // original startup-perf intent) and works under both tsx and the esbuild
  // bundle. No try/catch: a factory that fails to load should fail loudly, not
  // leave the registry silently empty.
  const factories = await import('./factories');

  factories.registerClaudeAgent();   // Anthropic — managed binary-spawn (stream-json), subscription billing
  factories.registerCodexAgent();    // OpenAI — MCP transport via `codex mcp-server`
  factories.registerGeminiAgent();   // Google AI
  factories.registerOpenCodeAgent(); // terminal-based, JSON output
  factories.registerAiderAgent();    // AI pair programming
  factories.registerGooseAgent();    // Block/Square (Apache 2.0, MCP)
  factories.registerAmpAgent();      // Sourcegraph (deep mode)
  factories.registerCrushAgent();    // Charmbracelet (ACP)
  factories.registerKiloAgent();     // Community (500+ models)
  factories.registerKiroAgent();     // AWS (per-prompt credits)
  factories.registerDroidAgent();    // BYOK (multi-backend)
}

