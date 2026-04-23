/**
 * Context Sync — Public API (Phase 3.5)
 *
 * Re-exports all public symbols from the context-sync sub-module.
 *
 * WHY NOT re-exported from the main barrel:
 *   The summarizer imports the scrub engine regex patterns. Consumers who
 *   only need the types can import from '@styrby/shared/context-sync'
 *   without pulling in the scrub regex runtime.
 *
 *   Import the full summarizer:
 *   `import { summarize, buildInjectionPrompt } from '@styrby/shared/context-sync'`
 *
 *   Import types only:
 *   `import type { AgentContextMemory, ... } from '@styrby/shared/context-sync'`
 *
 * @module context-sync
 */

// Types and constants
export type {
  ContextFileRef,
  ContextMessage,
  AgentContextMemory,
  SummarizerInput,
  SummarizerInputMessage,
  SummarizerOutput,
  ContextShowOptions,
  ContextSyncOptions,
  ContextExportOptions,
  ContextImportOptions,
  ContextInjectionPayload,
} from './types.js';

export {
  CONTEXT_MESSAGE_LIMIT,
  TOKEN_BUDGET_DEFAULT,
  TOKEN_BUDGET_MAX,
  TOKEN_BUDGET_MIN,
  MESSAGE_PREVIEW_MAX_CHARS,
  FILE_REF_RELEVANCE_MAX,
} from './types.js';

// Summarizer functions (pure, deterministic)
export {
  summarize,
  buildInjectionPrompt,
  estimateTokens,
  extractPathsFromString,
  extractPathsFromToolCall,
  computeRelevance,
  normaliseRole,
  buildMessagePreview,
  detectCurrentTask,
  detectOpenQuestion,
  buildSummaryMarkdown,
  buildFileRefs,
} from './summarizer.js';
