/**
 * Shared factory result types for agent backends.
 *
 * WHY: Every streaming agent factory (aider, amp, crush, droid, goose, kilo,
 * kiro, opencode) returns { backend, model } today. This module introduces a
 * unified, ADDITIVE result shape that keeps the existing two fields intact
 * while allowing factories to optionally attach metadata (modelSource,
 * capability flags, etc.) for future UI/routing decisions.
 *
 * DESIGN DECISION: The `metadata` field is optional so no caller breaks.
 * Any future migration to "force metadata everywhere" must be a separate PR.
 *
 * @module core/types
 */

import type { AgentBackend } from './AgentBackend';

/**
 * Describes how the active model was resolved for a factory invocation.
 *
 * - `'explicit'` - caller passed `options.model` directly
 * - `'default'` - factory fell back to its hardcoded default
 * - `'env'` - factory pulled the model name from an environment variable
 */
export type ModelSource = 'explicit' | 'default' | 'env';

/**
 * Optional metadata attached to a factory result.
 *
 * Factories SHOULD populate fields that are known for their agent. Unknown
 * fields may be omitted - consumers must tolerate absence gracefully.
 */
export interface AgentFactoryMetadata {
  /** How the model field was resolved (explicit vs default vs env) */
  modelSource?: ModelSource;

  /** True if the underlying agent streams output incrementally to stdout. */
  supportsStreaming?: boolean;

  /** True if the agent can invoke tools / perform file edits. */
  supportsTools?: boolean;

  /** Additional agent-specific metadata. */
  [key: string]: unknown;
}

/**
 * Unified result returned by every streaming agent factory.
 *
 * Backward compatibility: the `{ backend, model }` shape is preserved.
 * Existing callers that only destructure those two fields continue to work.
 *
 * @example
 * const { backend, model, metadata } = createAiderBackend({ cwd });
 * if (metadata?.supportsStreaming) { ... }
 */
export interface AgentFactoryResult {
  /** The constructed backend, ready for startSession() */
  backend: AgentBackend;

  /** The resolved model name, or undefined if the agent chooses one at runtime */
  model: string | undefined;

  /** Optional, additive metadata about the resolution and capabilities. */
  metadata?: AgentFactoryMetadata;
}
