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

// Crush factory (Charmbracelet, ACP-compatible)
export {
  createCrushBackend,
  registerCrushAgent,
  type CrushBackendOptions,
  type CrushBackendResult,
} from './crush';

// Kilo factory (Community, 500+ models, Memory Bank)
export {
  createKiloBackend,
  registerKiloAgent,
  type KiloBackendOptions,
  type KiloBackendResult,
} from './kilo';

// Kiro factory (AWS, per-prompt credit billing)
export {
  createKiroBackend,
  registerKiroAgent,
  type KiroBackendOptions,
  type KiroBackendResult,
} from './kiro';

// Droid factory (BYOK, multi-backend via LiteLLM)
export {
  createDroidBackend,
  registerDroidAgent,
  type DroidBackendOptions,
  type DroidBackendResult,
} from './droid';

// Future factories:
// export { createCodexBackend, registerCodexAgent, type CodexBackendOptions } from './codex';
// export { createClaudeBackend, registerClaudeAgent, type ClaudeBackendOptions } from './claude';
