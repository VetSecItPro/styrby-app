/**
 * Context Sync — Shared Types (Phase 3.5)
 *
 * Type definitions for cross-agent context synchronization. These types are
 * consumed by styrby-cli (context commands), styrby-web (focus API extension),
 * and future styrby-mobile surfaces.
 *
 * WHY a separate sub-module:
 *   Context sync involves scrubbing (Phase 3.3 engine), session groups (Phase 3.1),
 *   and its own DB table (migration 039). Keeping types in a dedicated module
 *   prevents circular imports and keeps the barrel index lean.
 *
 * GDPR Art. 5(1)(c) data minimisation:
 *   All types that carry message content (ContextMessage) carry SCRUBBED previews
 *   only. Raw content is never surfaced through these types.
 *
 * SOC2 CC6.1:
 *   The token_budget field is enforced server-side (max 8000). Client-side
 *   types mirror this via the TOKEN_BUDGET_MAX constant.
 *
 * @module context-sync/types
 */

// ============================================================================
// Constants
// ============================================================================

/**
 * Default number of recent messages captured in context memory.
 *
 * WHY 20: Covers approximately one task cycle for all 11 supported agents.
 * Beyond 20, token budget limits become the binding constraint.
 */
export const CONTEXT_MESSAGE_LIMIT = 20 as const;

/**
 * Default token budget for memory injection into a new agent.
 *
 * WHY 4000: ~3× the average message size. Fits comfortably in the context
 * window of all supported agents without dominating available tokens.
 */
export const TOKEN_BUDGET_DEFAULT = 4000 as const;

/**
 * Server-side maximum token budget (enforced in API and summarizer).
 *
 * WHY 8000: Above this, memory injection consumes a meaningful fraction of
 * Claude Haiku's 8192-token context window, leaving no room for the actual
 * task. Cap prevents denial-of-service via oversized memories.
 */
export const TOKEN_BUDGET_MAX = 8000 as const;

/**
 * Minimum allowed token budget.
 *
 * WHY 100: Below 100 tokens the summary_markdown header alone may be truncated,
 * making the injected context useless. The summarizer rejects budgets below this.
 */
export const TOKEN_BUDGET_MIN = 100 as const;

/**
 * Maximum characters captured per message preview.
 *
 * WHY 200: Long enough for the receiver to understand what was being asked/answered;
 * short enough to stay well under the token budget even for 20 messages.
 */
export const MESSAGE_PREVIEW_MAX_CHARS = 200 as const;

/**
 * Maximum relevance score for a file reference.
 * Scores are normalised to [0, 1.0].
 */
export const FILE_REF_RELEVANCE_MAX = 1.0 as const;

// ============================================================================
// File reference
// ============================================================================

/**
 * A file touched during the session, with relevance metadata.
 *
 * Relevance is a normalised [0, 1.0] score combining:
 *   - Recency (exponential decay from lastTouchedAt to now)
 *   - Mention frequency (how many messages reference this path)
 *
 * WHY combined score: Recency alone over-weights files touched once at session
 * start. Frequency alone over-weights noisy output files written on every
 * build. The combined score surfaces files that were recently AND repeatedly
 * touched — which are the files the next agent needs to know about.
 */
export interface ContextFileRef {
  /** Absolute filesystem path (scrubbed: /Users/alice → [PATH]/file.ts not stored). */
  path: string;

  /** ISO 8601 timestamp of the last tool_call that touched this file. */
  lastTouchedAt: string;

  /**
   * Normalised relevance score in [0, 1.0].
   * Higher = more relevant to the current task; injected first.
   */
  relevance: number;
}

// ============================================================================
// Message preview
// ============================================================================

/**
 * A scrubbed preview of a single session message.
 *
 * SECURITY: The `preview` field MUST contain only scrubbed content.
 * The summarizer calls the Phase 3.3 scrub engine before populating
 * this field. Raw content must never appear here.
 *
 * GDPR Art. 5(1)(c): Only the first MESSAGE_PREVIEW_MAX_CHARS characters
 * of each message are stored — minimising personal data retention.
 */
export interface ContextMessage {
  /**
   * Message role — determines which agent or user produced the message.
   * 'tool' covers tool_call + tool_result pairs (collapsed for brevity).
   */
  role: 'user' | 'assistant' | 'tool';

  /**
   * First MESSAGE_PREVIEW_MAX_CHARS characters of the message content,
   * after secrets / file-paths / commands have been scrubbed.
   */
  preview: string;
}

// ============================================================================
// Context memory record (mirrors agent_context_memory table)
// ============================================================================

/**
 * A context memory record as stored in `agent_context_memory`.
 *
 * This is the full DB-mirror shape — all fields present. The API may
 * omit or transform fields before surfacing to CLI callers; see
 * ContextMemorySummary for the read-optimised view.
 */
export interface AgentContextMemory {
  /** UUID primary key. */
  id: string;

  /** UUID of the session group this memory belongs to. */
  sessionGroupId: string;

  /**
   * Condensed project state in Markdown.
   *
   * Fixed template:
   * ```markdown
   * ## Current task
   * <derived from first tool_call goal + last user message>
   *
   * ## Recently touched
   * - path/to/file.ts (relevance 0.95)
   * - path/to/other.ts (relevance 0.72)
   *
   * ## Open questions
   * <last user message if it ends with '?', else empty>
   * ```
   */
  summaryMarkdown: string;

  /**
   * File references sorted descending by relevance.
   * Injected after the summary to give the new agent immediate file context.
   */
  fileRefs: ContextFileRef[];

  /**
   * Last N message previews (scrubbed) in chronological order.
   * N ≤ CONTEXT_MESSAGE_LIMIT.
   */
  recentMessages: ContextMessage[];

  /**
   * Maximum tokens this memory may consume when injected.
   * Enforced at write time (100 ≤ tokenBudget ≤ TOKEN_BUDGET_MAX).
   */
  tokenBudget: number;

  /**
   * Optimistic locking counter.
   * Incremented by 1 on every successful sync write.
   */
  version: number;

  /** ISO 8601 timestamp when the record was created. */
  createdAt: string;

  /** ISO 8601 timestamp of the last successful sync. */
  updatedAt: string;
}

// ============================================================================
// Summarizer input / output
// ============================================================================

/**
 * Raw message as fed into the summarizer.
 *
 * This is a superset of ContextMessage — it includes the full content string
 * (which the summarizer scrubs before truncating to a preview) and optional
 * tool_call data for file-ref extraction.
 *
 * WHY not SessionMessage from @styrby/shared types.ts:
 *   The summarizer is a pure function with no Supabase dependency.
 *   Accepting a narrow interface keeps it decoupled from the DB model.
 */
export interface SummarizerInputMessage {
  /** Message role. */
  role: 'user' | 'assistant' | 'tool' | 'tool_result' | string;

  /** Full raw message content. Secrets/paths/commands will be scrubbed. */
  content: string;

  /**
   * Optional tool call data. When present, the summarizer scans `arguments`
   * for file path strings to populate file_refs.
   *
   * WHY optional: not all messages are tool calls; scanning is skipped for
   * user/assistant messages.
   */
  toolCall?: {
    /** Tool name, e.g. 'str_replace_editor', 'bash', 'read_file'. */
    name: string;

    /**
     * Tool arguments as a JSON string or already-parsed object.
     * The summarizer parses it if it's a string.
     */
    arguments: string | Record<string, unknown>;
  };
}

/**
 * Input to the deterministic context summarizer.
 *
 * WHY not accepting the DB record directly:
 *   The summarizer is called both on fresh messages (CLI auto-sync) and when
 *   building an injection prompt (focus-change handler). Accepting a plain
 *   input struct keeps it decoupled from whether the caller has a DB record.
 */
export interface SummarizerInput {
  /**
   * Messages to summarize — typically the last CONTEXT_MESSAGE_LIMIT×2 messages
   * from the current session to give the summarizer enough signal. The output
   * is capped to CONTEXT_MESSAGE_LIMIT.
   */
  messages: SummarizerInputMessage[];

  /**
   * Maximum tokens the output may occupy when injected.
   * Must be within [TOKEN_BUDGET_MIN, TOKEN_BUDGET_MAX].
   */
  tokenBudget?: number;

  /**
   * Optional seed for the "current task" heading.
   * When provided, overrides the task-detection heuristic.
   * Used by `styrby context import --task "..."`.
   */
  taskOverride?: string;
}

/**
 * Output from the deterministic context summarizer.
 *
 * All fields are safe to write directly to agent_context_memory without
 * additional scrubbing (the summarizer applies the scrub engine internally).
 */
export interface SummarizerOutput {
  /** Assembled Markdown summary within token_budget. */
  summaryMarkdown: string;

  /**
   * Deduplicated file refs sorted descending by relevance.
   * Empty array if no tool_call file references were found.
   */
  fileRefs: ContextFileRef[];

  /**
   * Scrubbed message previews (chronological, length ≤ CONTEXT_MESSAGE_LIMIT).
   */
  recentMessages: ContextMessage[];

  /**
   * Estimated token count of summaryMarkdown.
   * Uses the words×1.3 heuristic (same as styrby-shared tokenizers fallback).
   */
  estimatedTokens: number;
}

// ============================================================================
// CLI command types
// ============================================================================

/**
 * Options for `styrby context show --group <groupId>`.
 *
 * Dumps the current context memory as markdown + file_refs JSON to stdout.
 */
export interface ContextShowOptions {
  /** UUID of the session group. */
  groupId: string;

  /** When true, output raw JSON instead of pretty-printed markdown. */
  json?: boolean;
}

/**
 * Options for `styrby context sync --group <groupId>`.
 *
 * Recomputes the context memory from recent session messages and writes it back.
 */
export interface ContextSyncOptions {
  /** UUID of the session group. */
  groupId: string;

  /**
   * Maximum token budget for the output memory.
   * Capped at TOKEN_BUDGET_MAX server-side.
   */
  tokenBudget?: number;
}

/**
 * Options for `styrby context export --session <sessionId>`.
 *
 * Extracts the context memory from a single session and writes to stdout.
 */
export interface ContextExportOptions {
  /** UUID of the session to export from. */
  sessionId: string;

  /** When true, output raw JSON instead of pretty-printed markdown. */
  json?: boolean;
}

/**
 * Options for `styrby context import --session <target> --from <source>`.
 *
 * Injects another session's memory into the target session's group.
 */
export interface ContextImportOptions {
  /** UUID of the target session (receives the injected memory). */
  sessionId: string;

  /** UUID of the source session (memory is copied from here). */
  fromSessionId: string;

  /**
   * Optional task description to override the imported memory's "Current task"
   * heading. Useful when importing across different task contexts.
   */
  task?: string;
}

// ============================================================================
// Injection payload
// ============================================================================

/**
 * The structured prompt injected into the new agent on focus change.
 *
 * This is what the agent factory receives as its system-role startup context.
 * It is built by buildInjectionPrompt() from an AgentContextMemory record.
 */
export interface ContextInjectionPayload {
  /**
   * System-role prompt content ready to send to the agent.
   *
   * Format:
   * ```
   * [Styrby Context Sync — cross-agent handoff]
   *
   * <summaryMarkdown>
   *
   * ## Files you may need
   * - /path/to/file.ts
   * - /path/to/other.ts
   *
   * ## Recent conversation (last N messages)
   * **user**: <preview>
   * **assistant**: <preview>
   * ```
   */
  systemPrompt: string;

  /**
   * The file refs included in the injection (for logging / audit).
   * Subset of AgentContextMemory.fileRefs filtered to relevance ≥ 0.5.
   */
  includedFileRefs: ContextFileRef[];

  /**
   * Number of recent messages included in the injection.
   * Always ≤ CONTEXT_MESSAGE_LIMIT.
   */
  messageCount: number;

  /** Estimated token count of systemPrompt. */
  estimatedTokens: number;
}
