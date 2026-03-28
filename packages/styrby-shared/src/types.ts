/**
 * Shared type definitions for Styrby
 */

/** Agent identifiers supported by Styrby */
export type AgentType = 'claude' | 'codex' | 'gemini' | 'opencode' | 'aider' | 'goose' | 'amp' | 'crush' | 'kilo' | 'kiro' | 'droid';

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
// Phase 7.14 — Contribution/Activity Graph
// ============================================================================

/**
 * Represents a single day's coding activity for the contribution graph.
 *
 * WHY: Mirrors the GitHub contribution graph model. Each day aggregates all
 * sessions and costs so the heatmap cell renderer has a single, pre-computed
 * value rather than needing to scan raw session records at render time.
 *
 * The `intensity` field maps activity level to one of five visual buckets
 * (0–4), matching GitHub's green-shading convention. Thresholds are computed
 * relative to the max-sessions day in the visible range so heavy users and
 * light users both see meaningful variation across their heatmap.
 */
export interface ActivityDay {
  /**
   * Calendar date in YYYY-MM-DD format.
   * Stored as a string to avoid timezone conversion bugs when comparing dates.
   */
  date: string;

  /**
   * Number of distinct sessions on this day.
   * A session counts for the day on which it was started.
   */
  sessionCount: number;

  /**
   * Total cost in USD across all sessions on this day.
   * Aggregated from the `total_cost_usd` column on the `sessions` table.
   */
  totalCostUsd: number;

  /**
   * Total tokens consumed across all sessions on this day.
   * Sum of input_tokens + output_tokens from session messages.
   */
  totalTokens: number;

  /**
   * De-duplicated list of agent types used on this day.
   * Used by tooltips and legend to show which agents were active.
   */
  agents: AgentType[];

  /**
   * Visual intensity bucket for heatmap coloring.
   * 0 = no activity, 1–4 = increasing activity levels.
   *
   * Computed client-side from `sessionCount` or `totalCostUsd` depending
   * on which metric the user has selected in the heatmap toggle.
   */
  intensity: 0 | 1 | 2 | 3 | 4;
}

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

// ============================================================================
// Phase 7.6 — Named Session Checkpoints
// ============================================================================

/**
 * A named checkpoint in a session timeline — a user-defined branch point
 * that captures session position and context at a specific message.
 *
 * WHY: Inspired by Gemini CLI's `/resume save [name]` feature. Long AI coding
 * sessions can go in multiple directions and users sometimes want to mark a
 * "known good" state before experimenting. Checkpoints let them name that
 * position and restore it later rather than scrolling back through hundreds
 * of messages to find where things diverged.
 *
 * Stored in the `session_checkpoints` Supabase table with RLS enforcing
 * user ownership. The CLI creates checkpoints locally and syncs to Supabase;
 * Web and Mobile surfaces render and manage them from Supabase directly.
 */
export interface SessionCheckpoint {
  /**
   * UUID v4 identifier for the checkpoint.
   * Primary key in the `session_checkpoints` table.
   */
  id: string;

  /**
   * UUID of the parent session this checkpoint belongs to.
   * Foreign key referencing `sessions.id`.
   */
  sessionId: string;

  /**
   * User-provided label for the checkpoint.
   * Must be 1–80 characters, unique within a session.
   * Examples: "before refactor", "auth working", "v1 complete"
   */
  name: string;

  /**
   * Optional longer description of what state this checkpoint captures.
   * Useful for explaining why the checkpoint was saved.
   */
  description?: string;

  /**
   * The sequence_number of the most recent session_message at the time
   * this checkpoint was created.
   *
   * WHY: We record sequence number rather than message ID because sequence
   * numbers are stable integers that preserve ordering semantics. "Restore
   * to sequence 42" means "show me messages 1–42" — unambiguous and easy
   * to implement as a .lte() query on session_messages.
   */
  messageSequenceNumber: number;

  /**
   * Lightweight snapshot of the agent context window at checkpoint time.
   * Used for display only — shows what the agent had loaded when the user
   * decided this was a meaningful checkpoint.
   */
  contextSnapshot: {
    /** Total tokens across all files loaded in context */
    totalTokens: number;
    /** Number of files loaded in the agent's context window */
    fileCount: number;
  };

  /**
   * ISO 8601 timestamp when the checkpoint was created.
   */
  createdAt: string;
}

// ============================================================================
// Phase 7.9 — Per-Message Cost Granularity
// ============================================================================

/**
 * Cost breakdown attached to a single agent response message.
 *
 * WHY: Session-level cost totals tell users how much a session cost overall,
 * but do not help them identify which specific responses were expensive.
 * Per-message cost lets users pinpoint costly prompts (e.g., a large file
 * read that inflated input tokens) and optimise their workflow.
 *
 * This struct is small enough to embed inline in message relay events and
 * to store denormalized on the `session_messages` row (future migration).
 */
export interface MessageCost {
  /**
   * The session_messages row ID this cost is attributed to.
   * Foreign key reference — links the cost pill in the UI to the message.
   */
  messageId: string;

  /**
   * Tokens sent to the model for this message exchange (user prompt + context).
   * Includes any tokens the agent re-sent as context from prior turns.
   */
  inputTokens: number;

  /**
   * Tokens generated by the model in the response.
   */
  outputTokens: number;

  /**
   * Tokens read from the model's prompt cache (billed at reduced rate).
   * WHY: Claude's prompt cache charges ~10x less per token than fresh input.
   * Showing this separately lets users understand the cache benefit.
   */
  cacheReadTokens: number;

  /**
   * Tokens written into the prompt cache for future requests.
   * Billed at a slight premium over standard input tokens.
   */
  cacheWriteTokens: number;

  /**
   * Total cost in USD for this message, calculated from the four token counts
   * above using the model's pricing at the time of the request.
   */
  costUsd: number;

  /**
   * The specific model used for this response (e.g., 'claude-sonnet-4-20250514').
   * Stored per-message because multi-model sessions can switch models mid-session.
   */
  model: string;
}

// ============================================================================
// Phase 7.10 — Session Sharing via URLs
// ============================================================================

/**
 * A shareable session link record.
 *
 * WHY: Users want to share session replays with teammates, reviewers, or
 * clients. Because session messages are E2E encrypted, the share record
 * stores only metadata — the viewer still needs the decryption key, which
 * is communicated via a separate channel. This preserves E2E confidentiality:
 * even if a share link is intercepted, without the key the content is opaque.
 *
 * Access controls (expiry, max-access count) are enforced server-side so
 * the originating user retains control after sharing.
 */
export interface SharedSession {
  /**
   * Short URL-safe identifier used in the public share URL.
   * Format: 12-character nanoid (alphanumeric, URL-safe).
   * Example: /shared/abc123xyz456
   */
  shareId: string;

  /**
   * The Supabase session ID this share record references.
   * Foreign key reference to the sessions table.
   */
  sessionId: string;

  /**
   * Supabase user ID of the user who created this share link.
   * WHY: Stored for audit trail and to allow the owner to revoke the link.
   */
  sharedBy: string;

  /**
   * ISO 8601 expiry timestamp, or null for links that never expire.
   * When set, the share API returns 410 Gone after this time.
   *
   * WHY: Temporary shares are critical for freelancers sharing session
   * replays during a client review -- they want the link to expire once
   * the review is done rather than leaving it permanently accessible.
   */
  expiresAt: string | null;

  /**
   * How many times this share link has been successfully accessed.
   * Incremented atomically by the share API on each valid access.
   */
  accessCount: number;

  /**
   * Maximum number of accesses allowed, or null for unlimited.
   * When accessCount reaches maxAccesses, the API returns 410 Gone.
   *
   * WHY: Bounded access lets users share a replay with exactly one
   * reviewer (maxAccesses: 1) without worrying about link forwarding.
   */
  maxAccesses: number | null;

  /** ISO 8601 timestamp when this share record was created. */
  createdAt: string;
}

/**
 * Request body for creating a session share link.
 */
export interface CreateShareRequest {
  /**
   * Session ID to share (must be owned by the authenticated user).
   */
  sessionId: string;

  /**
   * Optional ISO 8601 expiry timestamp.
   * If omitted, the link never expires (until manually revoked).
   */
  expiresAt?: string | null;

  /**
   * Optional maximum number of times the link can be accessed.
   * If omitted, the link has unlimited accesses.
   */
  maxAccesses?: number | null;
}

/**
 * Response body from the share creation endpoint.
 */
export interface CreateShareResponse {
  /** The created share record */
  share: SharedSession;
  /**
   * Full share URL ready to copy and send.
   * Format: https://app.styrby.com/shared/:shareId
   */
  shareUrl: string;
}

// ============================================================================
// Phase 7.16 — Voice Input
// ============================================================================

/**
 * Configuration for the voice-to-agent input feature.
 *
 * WHY: Voice input allows hands-free agent commands, useful when a developer
 * is focused on their screen or away from the keyboard. The config is stored
 * locally per device since it depends on hardware capabilities and personal
 * preference.
 */
export interface VoiceInputConfig {
  /**
   * Whether voice input is enabled on this device.
   * When false, the microphone button is hidden from the chat input area.
   */
  enabled: boolean;

  /**
   * Interaction mode for the microphone button.
   * - 'hold': Hold button to record, release to stop (push-to-talk)
   * - 'toggle': Tap to start recording, tap again to stop
   *
   * WHY: 'hold' is safer for accidental presses; 'toggle' is better for
   * longer dictation sessions where holding is uncomfortable.
   */
  mode: 'hold' | 'toggle';

  /**
   * Optional URL for the speech-to-text transcription endpoint.
   * When set, recorded audio is sent to this endpoint (Whisper-compatible API).
   * When null, the component shows transcription as unavailable.
   *
   * Format: https://api.openai.com/v1/audio/transcriptions
   * WHY configurable: Allows self-hosted Whisper, enterprise proxies, or
   * alternative providers without hardcoding to a single service.
   */
  transcriptionEndpoint?: string;

  /**
   * API key for the transcription endpoint (stored in SecureStore, never persisted to DB).
   * WHY separate from endpoint: Key rotation should not require re-entering the URL.
   */
  transcriptionApiKey?: string;
}

// ============================================================================
// Phase 7.17 — Cloud Task Monitoring
// ============================================================================

/**
 * Status lifecycle for a cloud-running agent task.
 *
 * WHY the full lifecycle: Cloud tasks have distinct phases that require
 * different UI treatments — queued tasks show estimated wait time, running
 * tasks show progress, completed/failed tasks show results and allow actions.
 */
export type CloudTaskStatus =
  | 'queued'     // Submitted, waiting for an available agent slot
  | 'running'    // Agent is actively executing the task
  | 'completed'  // Task finished successfully with a result
  | 'failed'     // Task ended in an error
  | 'cancelled'; // User cancelled the task before completion

/**
 * A single asynchronous cloud agent task.
 *
 * WHY cloud tasks: Codex cloud-style async execution lets developers kick off
 * a long-running agent task (refactor, add tests, write docs) and check back
 * when it's done via push notification — no need to keep the CLI running or
 * watch the terminal.
 *
 * Stored in the `cloud_tasks` Supabase table with RLS for ownership.
 */
export interface CloudTask {
  /** UUID v4 identifier. Primary key in the `cloud_tasks` table. */
  id: string;
  /**
   * UUID of the parent session. May be null for standalone tasks.
   * Foreign key referencing `sessions.id`.
   */
  sessionId: string | null;
  /** Which AI agent runs this task. */
  agentType: AgentType;
  /** Current execution state. */
  status: CloudTaskStatus;
  /**
   * The user-provided instruction or prompt.
   * Stored in plaintext for display; the CLI may encrypt the execution payload.
   */
  prompt: string;
  /** Final output from the agent (populated when status = 'completed'). */
  result?: string;
  /** Error message (populated when status = 'failed'). */
  errorMessage?: string;
  /** ISO 8601 timestamp when the task was submitted. */
  startedAt: string;
  /** ISO 8601 timestamp when the task finished (any terminal state). */
  completedAt?: string;
  /**
   * Estimated duration in milliseconds.
   * WHY: Sets realistic expectations and drives progress indicators.
   */
  estimatedDurationMs?: number;
  /** Total cost in USD incurred by this task. */
  costUsd?: number;
  /** Optional display metadata (project path, branch, model). */
  metadata?: {
    projectPath?: string;
    gitBranch?: string;
    model?: string;
  };
}

// ============================================================================
// Phase 7.18 — Code Review from Mobile
// ============================================================================

/**
 * Status of a mobile code review.
 *
 * WHY these states: Code review has a clear lifecycle — the agent submits
 * the diff for review, the developer responds, and the CLI receives the decision.
 * The 'changes_requested' state allows for iterative review without rejection.
 */
export type CodeReviewStatus =
  | 'pending'            // Submitted for review, no decision yet
  | 'approved'           // Reviewer approved all changes
  | 'rejected'           // Reviewer rejected the changeset
  | 'changes_requested'; // Reviewer wants modifications before approval

/**
 * A single file included in a code review.
 *
 * WHY store the diff inline: The diff is delivered via relay at review creation
 * time. Storing it in the relay payload avoids an extra API call when the
 * reviewer opens the file — the diff is immediately available offline.
 */
export interface ReviewFile {
  /** Workspace-relative path to the changed file. Example: "src/Button.tsx" */
  path: string;
  /** Number of lines added in this file. */
  additions: number;
  /** Number of lines removed from this file. */
  deletions: number;
  /**
   * Complete unified diff for this file.
   * Format: "--- a/src/file.ts\n+++ b/src/file.ts\n@@ ... @@\n..."
   */
  diff: string;
}

/**
 * A reviewer comment on a specific file or diff hunk.
 *
 * WHY optional lineNumber: Comments can be file-level (general feedback)
 * or line-level (specific to a change). Both types share one struct and
 * the lineNumber field distinguishes them.
 */
export interface ReviewComment {
  /** UUID v4 identifier for the comment. */
  id: string;
  /** Workspace-relative path to the commented file. */
  filePath: string;
  /**
   * Line number in the diff where this comment applies.
   * Omitted for file-level (general) comments.
   */
  lineNumber?: number;
  /** The comment text from the reviewer. */
  body: string;
  /** ISO 8601 timestamp when the comment was created. */
  createdAt: string;
}

/**
 * A complete code review request from an agent to the mobile reviewer.
 *
 * WHY mobile code review: Developers often step away from their desk while
 * an agent is running. Mobile review lets them inspect and approve/reject
 * agent-generated changes from anywhere — reducing the round-trip delay
 * for changes that need human sign-off.
 *
 * Review requests are delivered via the relay channel as 'code_review_request'
 * messages. The reviewer's decision is sent back as 'code_review_response'.
 */
export interface CodeReview {
  /** UUID v4 identifier. Used as the relay correlation ID. */
  id: string;
  /** UUID of the session that generated these changes. */
  sessionId: string;
  /** Files changed, with diffs and line counts. Sorted alphabetically by path. */
  files: ReviewFile[];
  /** Current review decision. */
  status: CodeReviewStatus;
  /** Comments left by the reviewer (may be empty). */
  comments: ReviewComment[];
  /** ISO 8601 timestamp when the review was created. */
  createdAt: string;
  /**
   * Optional summary or title describing what was changed.
   * Populated by the agent to give context before the reviewer opens the diff.
   */
  summary?: string;
  /** Name of the git branch these changes are on. */
  gitBranch?: string;
}
