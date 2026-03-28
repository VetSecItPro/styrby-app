/**
 * Agent Factories
 *
 * Factory functions for creating agent backends with proper configuration.
 * Each factory includes the appropriate transport handler for the agent.
 *
 * @module factories
 */

// Gemini factory
export {
  createGeminiBackend,
  registerGeminiAgent,
  type GeminiBackendOptions,
  type GeminiBackendResult,
} from './gemini';

// Aider factory
export {
  createAiderBackend,
  registerAiderAgent,
  type AiderBackendOptions,
  type AiderBackendResult,
} from './aider';

// OpenCode factory
export {
  createOpenCodeBackend,
  registerOpenCodeAgent,
  type OpenCodeBackendOptions,
  type OpenCodeBackendResult,
} from './opencode';

// Goose factory (Block/Square, Apache 2.0)
export {
  createGooseBackend,
  registerGooseAgent,
  type GooseBackendOptions,
  type GooseBackendResult,
} from './goose';

// Amp factory (Sourcegraph)
export {
  createAmpBackend,
  registerAmpAgent,
  type AmpBackendOptions,
  type AmpBackendResult,
} from './amp';

// Future factories:
// export { createCodexBackend, registerCodexAgent, type CodexBackendOptions } from './codex';
// export { createClaudeBackend, registerClaudeAgent, type ClaudeBackendOptions } from './claude';
