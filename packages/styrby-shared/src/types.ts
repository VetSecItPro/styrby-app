/**
 * Shared type definitions for Styrby
 */

/** Agent identifiers supported by Styrby */
export type AgentType = 'claude' | 'codex' | 'gemini' | 'opencode' | 'aider' | 'goose' | 'amp';

/** Session status */
export type SessionStatus = 'starting' | 'running' | 'idle' | 'stopped' | 'error';

/** Connection status for CLI ↔ Mobile relay */
export type ConnectionStatus = 'connected' | 'connecting' | 'disconnected' | 'error';

/** Error source classification for smart error attribution */
export type ErrorSource =
  | 'styrby'      // Styrby infrastructure issue
  | 'agent'       // Agent error (Claude Code, Codex, Gemini)
  | 'api'         // Provider API error (Anthropic, OpenAI, Google)
  | 'network'     // Network connectivity issue
  | 'build'       // Build tool error (npm, tsc, eslint, etc)
  | 'permission'; // Permission denied error

/** Risk level for permission requests */
export type RiskLevel = 'low' | 'medium' | 'high';

/** Permission request from agent */
export interface PermissionRequest {
  id: string;
  agentType: AgentType;
  action: string;
  description: string;
  riskLevel: RiskLevel;
  payload: unknown;
  createdAt: string;
}

/** Cost data for a session */
export interface SessionCost {
  sessionId: string;
  agentType: AgentType;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  totalCostUsd: number;
  model: string;
}

/** User subscription tier */
export type SubscriptionTier = 'free' | 'pro' | 'power' | 'team';

// ============================================================================
// Phase 7.4 — Per-File Context Breakdown
// ============================================================================

/**
 * Represents a single file's contribution to an agent's context window.
 *
 * WHY: AI agents like Claude Code load project files into the context window
 * before responding. Each file consumes a portion of the fixed token budget.
 * Showing per-file breakdowns helps users understand which files are "expensive"
 * and lets them make informed decisions about what to exclude or summarize.
 */
export interface FileContextEntry {
  /**
   * Absolute or workspace-relative path to the file.
   * Stored as provided by the agent (typically relative to project root).
   */
  filePath: string;

  /**
   * Number of tokens this file consumed in the context window.
   * Based on the agent's tokenizer for the active model.
   */
  tokenCount: number;

  /**
   * This file's share of total context tokens, expressed as a percentage (0–100).
   * Computed as (tokenCount / totalTokens) * 100, rounded to two decimal places.
   */
  percentage: number;

  /**
   * ISO 8601 timestamp of when this file was last read into context.
   * Useful for identifying stale or repeatedly-accessed files.
   */
  lastAccessed: string;
}

/**
 * Snapshot of a session's context window token allocation across all loaded files.
 *
 * WHY: Competitors show only total token counts. Styrby differentiates by showing
 * the per-file breakdown, letting power users optimize their context budget by
 * identifying large or frequently-reloaded files.
 */
export interface ContextBreakdown {
  /**
   * Supabase session ID this breakdown belongs to.
   * Foreign key reference to the `sessions` table.
   */
  sessionId: string;

  /**
   * Total tokens currently allocated across all files in context.
   * Sum of all FileContextEntry.tokenCount values.
   */
  totalTokens: number;

  /**
   * Per-file token allocations, sorted by tokenCount descending (largest first).
   * Allows mobile/web UIs to render the most impactful files first.
   */
  files: FileContextEntry[];

  /**
   * ISO 8601 timestamp of the last time this breakdown was computed.
   * The breakdown is updated every time the agent reads a new file.
   */
  updatedAt: string;
}

// ============================================================================
// Phase 7.5 — Session Export/Import
// ============================================================================

/**
 * Portable export format for a complete Styrby session.
 *
 * WHY: Users need to share sessions with teammates, archive them locally,
 * or migrate between machines. A self-contained JSON export enables all of
 * these workflows without requiring Supabase access at import time.
 *
 * The format is intentionally stable so exports from older CLI versions
 * can be imported by newer versions.
 */
export interface SessionExport {
  /**
   * Export format version, used for backward-compatible parsing.
   * Increment only on breaking schema changes.
   */
  exportVersion: 1;

  /**
   * ISO 8601 timestamp when this export was generated.
   */
  exportedAt: string;

  /**
   * Styrby CLI version that generated this export (e.g. "0.1.0-beta.7").
   */
  generatedBy: string;

  /** Session metadata */
  session: SessionExportMetadata;

  /**
   * Session messages (content_encrypted is preserved as-is from Supabase).
   * WHY: We keep messages encrypted to preserve security guarantees —
   * exported files don't become plaintext transcripts if leaked.
   */
  messages: SessionExportMessage[];

  /** Aggregated cost data for the session */
  cost: SessionExportCost;

  /**
   * Context breakdown at time of export (may be null if not available).
   * null when the CLI never computed a context breakdown for this session.
   */
  contextBreakdown: ContextBreakdown | null;
}

/**
 * Session metadata included in a session export.
 */
export interface SessionExportMetadata {
  id: string;
  title: string | null;
  summary: string | null;
  agentType: string;
  model: string | null;
  status: string;
  projectPath: string | null;
  gitBranch: string | null;
  gitRemoteUrl: string | null;
  tags: string[];
  startedAt: string;
  endedAt: string | null;
  messageCount: number;
  contextWindowUsed: number | null;
  contextWindowLimit: number | null;
}

/**
 * Single message entry in a session export.
 *
 * WHY: We export the encrypted form so that the export is safe to store
 * and share — decryption requires the user's E2E key which is never exported.
 */
export interface SessionExportMessage {
  id: string;
  sequenceNumber: number;
  messageType: string;
  /** Base64-encoded encrypted content, or null for messages without content */
  contentEncrypted: string | null;
  /** Base64-encoded nonce for content_encrypted, or null */
  encryptionNonce: string | null;
  riskLevel: string | null;
  toolName: string | null;
  durationMs: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  createdAt: string;
}

/**
 * Aggregated cost data included in a session export.
 */
export interface SessionExportCost {
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheTokens: number;
  model: string | null;
  agentType: string;
}
