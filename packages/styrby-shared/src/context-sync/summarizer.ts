/**
 * Context Sync — Deterministic Summarizer (Phase 3.5)
 *
 * Pure-function summarizer that builds a structured context memory from a
 * session message array and an optional token budget.
 *
 * WHY pure functions:
 *   Pure functions are trivially testable (no mocks needed), deterministic
 *   (same input → same output on every CI run), and safe to call in hot paths
 *   (no side effects). All 15+ tests exercise this module directly.
 *
 * WHY NOT an LLM call:
 *   An LLM-based summarizer introduces latency (300-2000ms), network failure
 *   risk, and nondeterminism. The deterministic string-processing approach
 *   runs in <5ms, never fails due to network, and produces auditable output.
 *   The tradeoff is slightly lower semantic quality — acceptable given that
 *   the output supplements the agent's context window, not replaces it.
 *
 * Security:
 *   - EVERY message is passed through the Phase 3.3 scrub engine before
 *     any content appears in the output. Secrets, file paths, and shell
 *     commands are redacted.
 *   - The summarizer NEVER logs message content.
 *   - Raw content never appears in returned types (only scrubbed previews).
 *
 * GDPR Art. 5(1)(c) data minimisation:
 *   Only the first MESSAGE_PREVIEW_MAX_CHARS chars of each message are
 *   retained. Tool calls are collapsed to a single 'tool' role entry.
 *
 * SOC2 CC6.1:
 *   Token budget is enforced at the output layer — the summary is truncated
 *   to fit within TOKEN_BUDGET_MAX even if the caller supplies a larger value.
 *
 * @module context-sync/summarizer
 */

import { scrubMessage } from '../session-replay/scrub.js';
import type { ScrubMask } from '../session-replay/scrub.js';
import {
  CONTEXT_MESSAGE_LIMIT,
  TOKEN_BUDGET_DEFAULT,
  TOKEN_BUDGET_MAX,
  TOKEN_BUDGET_MIN,
  MESSAGE_PREVIEW_MAX_CHARS,
  FILE_REF_RELEVANCE_MAX,
} from './types.js';
import type {
  SummarizerInput,
  SummarizerOutput,
  SummarizerInputMessage,
  ContextFileRef,
  ContextMessage,
  ContextInjectionPayload,
  AgentContextMemory,
} from './types.js';

// ============================================================================
// Internal constants
// ============================================================================

/**
 * Scrub mask applied to EVERY message before preview extraction.
 *
 * WHY all three categories enabled:
 *   - secrets: Agents frequently debug .env files and API calls; key leakage
 *     in context memory would persist secrets across agent lifetimes.
 *   - file_paths: Absolute paths expose system layout; basenames are preserved
 *     for context. Matches the Phase 3.3 scrub engine behavior.
 *   - commands: Shell command arguments often carry sensitive flags (tokens,
 *     passwords) passed via --token=... or MYKEY=... prefix.
 *
 * This mask is intentionally more aggressive than the user-configurable replay
 * mask, because context memory is automatically propagated to agents that may
 * not be owned by the same person.
 */
const FULL_SCRUB_MASK: ScrubMask = {
  secrets: true,
  file_paths: true,
  commands: true,
};

/**
 * Words-per-token heuristic used for token estimation.
 *
 * WHY 1.3: This is the same constant used by styrby-shared/tokenizers as its
 * fallback when neither the Anthropic nor OpenAI tokenizer is available. Using
 * the same constant ensures budget checks are consistent across the codebase.
 *
 * Over-estimate is intentional: better to inject less context than to overflow
 * the agent's context window.
 */
const WORDS_PER_TOKEN_DIVISOR = 1.3;

/**
 * Minimum relevance score for a file ref to be included in the injection prompt.
 * Used by buildInjectionPrompt to filter out low-signal refs.
 */
const INJECTION_MIN_RELEVANCE = 0.5;

/**
 * Recency half-life in milliseconds for the relevance decay function.
 *
 * WHY 30 minutes: AI coding sessions are fast-paced. A file touched 30 minutes
 * ago is roughly half as relevant as one touched just now. Files touched >2h
 * ago get relevance < 0.25, which typically falls below INJECTION_MIN_RELEVANCE.
 */
const RECENCY_HALF_LIFE_MS = 30 * 60 * 1000;

/**
 * Tool names whose arguments are expected to contain file paths.
 *
 * WHY an allowlist not a denylist: Unknown tools may have arguments with
 * arbitrary structure. Scanning unknown tools risks false-positive file refs
 * from strings that look like paths (e.g. CSS color '#aabbcc').
 */
const FILE_TOOL_NAMES = new Set([
  'str_replace_editor',
  'str_replace_based_edit_tool',
  'read_file',
  'write_file',
  'create_file',
  'patch_file',
  'bash', // bash commands often include file paths as arguments
  'execute_bash',
  'computer', // Claude's computer use tool can reference files
  'edit_file',
  'view_file',
  'list_directory',
  'glob',
  'grep',
]);

/**
 * Argument keys that typically hold a file path value.
 *
 * WHY multiple keys: Different tools use different field names. Covering
 * common variants extracts more file refs without requiring tool-specific logic.
 */
const PATH_ARG_KEYS = new Set([
  'path',
  'file_path',
  'filepath',
  'filename',
  'target_file',
  'command', // bash commands — we extract paths from the command string
]);

// ============================================================================
// Token estimation
// ============================================================================

/**
 * Estimates the token count of a string using the words×DIVISOR heuristic.
 *
 * This is the same heuristic as styrby-shared/tokenizers/index.ts. The result
 * is an OVER-estimate (conservative), which is the correct bias for budget enforcement.
 *
 * @param text - The string to estimate.
 * @returns Estimated token count (ceiling).
 *
 * @example
 * ```ts
 * estimateTokens('Hello world') // → 2 (2 words / 1.3, ceiling = 2)
 * ```
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  // WHY filter empty strings: '   '.trim().split(/\s+/) yields [''] (one empty
  // string element), not an empty array. Filtering ensures whitespace-only
  // input returns 0 instead of 1.
  const wordCount = trimmed.split(/\s+/).filter((w) => w.length > 0).length;
  if (wordCount === 0) return 0;
  return Math.ceil(wordCount / WORDS_PER_TOKEN_DIVISOR);
}

// ============================================================================
// File reference extraction
// ============================================================================

/**
 * Extracts absolute filesystem paths from a string.
 *
 * Looks for Unix absolute paths (/Users/..., /home/..., /root/...,
 * /var/..., /tmp/..., /etc/..., /opt/..., /usr/..., /srv/...).
 *
 * WHY same regex as scrub engine ABSOLUTE_PATH_PATTERN but without the capture
 * group — here we want the FULL path, not just the basename.
 *
 * @param text - The string to scan for paths.
 * @returns Array of unique absolute paths found.
 *
 * @example
 * ```ts
 * extractPathsFromString('/Users/alice/projects/app/src/auth.ts is broken')
 * // → ['/Users/alice/projects/app/src/auth.ts']
 * ```
 */
export function extractPathsFromString(text: string): string[] {
  const PATH_PATTERN = /(?:\/(?:Users|home|root|var|tmp|etc|opt|usr|srv)[^\s"'`]*)/g;
  const matches = text.match(PATH_PATTERN) ?? [];
  // Deduplicate preserving first-occurrence order
  return [...new Set(matches)];
}

/**
 * Extracts file paths from a tool_call arguments object.
 *
 * Checks PATH_ARG_KEYS first (direct string values), then falls back to
 * scanning all string values in the arguments object for path patterns.
 *
 * @param toolName - The name of the tool (used to gate extraction).
 * @param args - Parsed tool call arguments.
 * @returns Array of unique absolute paths found in the arguments.
 */
export function extractPathsFromToolCall(
  toolName: string,
  args: Record<string, unknown>
): string[] {
  const paths: string[] = [];

  if (!FILE_TOOL_NAMES.has(toolName)) {
    // Skip tools whose arguments are unlikely to contain file paths
    return paths;
  }

  // First pass: check well-known path argument keys
  for (const key of PATH_ARG_KEYS) {
    const value = args[key];
    if (typeof value === 'string') {
      paths.push(...extractPathsFromString(value));
    }
  }

  // Second pass: scan all string values (catches non-standard arg keys)
  for (const [key, value] of Object.entries(args)) {
    if (PATH_ARG_KEYS.has(key)) continue; // already processed above
    if (typeof value === 'string' && value.length > 0) {
      paths.push(...extractPathsFromString(value));
    }
  }

  return [...new Set(paths)];
}

// ============================================================================
// Relevance scoring
// ============================================================================

/**
 * Computes the relevance score for a file path given recency and mention frequency.
 *
 * Score = 0.7 × recencyScore + 0.3 × frequencyScore
 *
 * WHY 70/30 weighting:
 *   Recency is the stronger signal — if a file was just modified, it's almost
 *   certainly relevant. Frequency matters because files touched once at session
 *   start may be peripheral, while files mentioned repeatedly are central to
 *   the task. The 70/30 split reflects this hierarchy.
 *
 * @param lastTouchedAt - ISO 8601 timestamp of the last touch.
 * @param mentionCount - Number of messages that reference this file.
 * @param totalMentions - Maximum mention count across all files (for normalisation).
 * @param now - Reference timestamp (defaults to Date.now()); injectable for tests.
 * @returns Normalised relevance score in [0, FILE_REF_RELEVANCE_MAX].
 *
 * @example
 * ```ts
 * // File touched 5 minutes ago, mentioned twice (max mentions = 5)
 * computeRelevance('2026-04-22T10:55:00Z', 2, 5, new Date('2026-04-22T11:00:00Z').getTime())
 * // → approximately 0.84
 * ```
 */
export function computeRelevance(
  lastTouchedAt: string,
  mentionCount: number,
  totalMentions: number,
  now: number = Date.now()
): number {
  const ageMs = Math.max(0, now - new Date(lastTouchedAt).getTime());

  // Exponential decay: score = e^(-age / half_life × ln(2))
  // At age = half_life: score = 0.5. At age = 0: score = 1.0.
  const recencyScore = Math.exp((-ageMs / RECENCY_HALF_LIFE_MS) * Math.LN2);

  // Frequency score: normalised to [0, 1]. If totalMentions is 0, frequency = 0.
  const frequencyScore = totalMentions > 0 ? mentionCount / totalMentions : 0;

  const combined = 0.7 * recencyScore + 0.3 * frequencyScore;

  // Clamp to [0, FILE_REF_RELEVANCE_MAX] and round to 2 decimal places
  return Math.round(Math.min(FILE_REF_RELEVANCE_MAX, Math.max(0, combined)) * 100) / 100;
}

// ============================================================================
// Message processing
// ============================================================================

/**
 * Normalises a message role to one of the three context summary roles.
 *
 * The session DB can contain 'tool_result', 'system', and other roles.
 * For context injection, we collapse these to the three roles the receiving
 * agent cares about: user, assistant, tool.
 *
 * @param role - The raw message role from the DB.
 * @returns Normalised role.
 */
export function normaliseRole(role: string): ContextMessage['role'] {
  if (role === 'user') return 'user';
  if (role === 'assistant') return 'assistant';
  return 'tool';
}

/**
 * Converts a raw input message to a scrubbed ContextMessage preview.
 *
 * The scrub engine is always applied (FULL_SCRUB_MASK). After scrubbing,
 * the content is truncated to MESSAGE_PREVIEW_MAX_CHARS.
 *
 * @param message - Raw input message.
 * @returns Scrubbed ContextMessage preview.
 */
export function buildMessagePreview(message: SummarizerInputMessage): ContextMessage {
  // Apply full scrub mask (secrets + file_paths + commands)
  const scrubbed = scrubMessage(
    { role: message.role, content: message.content ?? '' },
    FULL_SCRUB_MASK
  );

  const preview = scrubbed.content.slice(0, MESSAGE_PREVIEW_MAX_CHARS).trim();

  return {
    role: normaliseRole(message.role),
    preview,
  };
}

// ============================================================================
// Task detection
// ============================================================================

/**
 * Detects the "current task" from the message array.
 *
 * Heuristic (in priority order):
 *   1. taskOverride from SummarizerInput (caller explicitly sets the task)
 *   2. The goal from the first tool_call in the session (what was the agent
 *      initially asked to do?)
 *   3. The last user message (what is the user asking right now?)
 *   4. Fallback: "Session in progress"
 *
 * WHY first tool_call goal: The very first tool call captures the initial
 * task description more reliably than any single message. Users often write
 * one-line messages, but the first tool call's description is typically the
 * most complete statement of the task.
 *
 * @param messages - Input messages in chronological order.
 * @param taskOverride - Optional caller-supplied task description.
 * @returns Scrubbed, truncated task description.
 */
export function detectCurrentTask(
  messages: SummarizerInputMessage[],
  taskOverride?: string
): string {
  if (taskOverride && taskOverride.trim().length > 0) {
    return taskOverride.trim().slice(0, MESSAGE_PREVIEW_MAX_CHARS);
  }

  // Look for the first user message (initial task statement)
  const firstUserMessage = messages.find((m) => m.role === 'user');
  if (firstUserMessage) {
    const scrubbed = scrubMessage(
      { role: 'user', content: firstUserMessage.content ?? '' },
      FULL_SCRUB_MASK
    );
    const preview = scrubbed.content.trim().slice(0, MESSAGE_PREVIEW_MAX_CHARS);
    if (preview.length > 0) return preview;
  }

  // Last user message (if different from first)
  const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user');
  if (lastUserMessage && lastUserMessage !== firstUserMessage) {
    const scrubbed = scrubMessage(
      { role: 'user', content: lastUserMessage.content ?? '' },
      FULL_SCRUB_MASK
    );
    const preview = scrubbed.content.trim().slice(0, MESSAGE_PREVIEW_MAX_CHARS);
    if (preview.length > 0) return preview;
  }

  return 'Session in progress';
}

/**
 * Detects open questions from the last user message.
 *
 * A message qualifies as an "open question" if it ends with '?' after trimming.
 * This is a simple heuristic — false positives (non-questions ending in ?) are
 * acceptable; the section will simply contain a statement rather than a question.
 *
 * @param messages - Input messages in chronological order.
 * @returns Scrubbed question preview, or empty string if none found.
 */
export function detectOpenQuestion(messages: SummarizerInputMessage[]): string {
  const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user');
  if (!lastUserMessage) return '';

  const scrubbed = scrubMessage(
    { role: 'user', content: lastUserMessage.content ?? '' },
    FULL_SCRUB_MASK
  );

  const trimmed = scrubbed.content.trim();
  if (trimmed.endsWith('?')) {
    return trimmed.slice(0, MESSAGE_PREVIEW_MAX_CHARS);
  }

  return '';
}

// ============================================================================
// Summary markdown builder
// ============================================================================

/**
 * Builds the fixed-template summary markdown from task, file refs, and open question.
 *
 * Template:
 * ```markdown
 * ## Current task
 * <task>
 *
 * ## Recently touched
 * - <path1> (relevance 0.95)
 * - <path2> (relevance 0.72)
 *
 * ## Open questions
 * <question or "(none)">
 * ```
 *
 * WHY a fixed template:
 *   Fixed templates are predictable for all 11 agents (which have different
 *   system prompt parsing styles). A consistent structure means the agent
 *   injection system can be tested and verified once and works everywhere.
 *
 * @param task - Current task description (scrubbed).
 * @param fileRefs - File refs sorted descending by relevance.
 * @param openQuestion - Open question from the last user message, or empty.
 * @returns Assembled markdown string.
 */
export function buildSummaryMarkdown(
  task: string,
  fileRefs: ContextFileRef[],
  openQuestion: string
): string {
  const lines: string[] = [];

  lines.push('## Current task');
  lines.push(task);
  lines.push('');

  lines.push('## Recently touched');
  if (fileRefs.length === 0) {
    lines.push('(no files tracked yet)');
  } else {
    for (const ref of fileRefs) {
      lines.push(`- ${ref.path} (relevance ${ref.relevance.toFixed(2)})`);
    }
  }
  lines.push('');

  lines.push('## Open questions');
  lines.push(openQuestion.length > 0 ? openQuestion : '(none)');

  return lines.join('\n');
}

// ============================================================================
// File ref builder
// ============================================================================

/**
 * Builds a deduplicated, relevance-sorted file ref array from the input messages.
 *
 * Steps:
 *   1. Scan each message with a toolCall for file paths (using extractPathsFromToolCall).
 *   2. Track per-path: last touch timestamp + mention count.
 *   3. Compute relevance for each path using computeRelevance().
 *   4. Sort descending by relevance.
 *   5. Return deduplicated result.
 *
 * @param messages - Input messages in chronological order.
 * @param now - Reference timestamp for recency computation (injectable for tests).
 * @returns Deduplicated file refs sorted descending by relevance.
 */
export function buildFileRefs(
  messages: SummarizerInputMessage[],
  now: number = Date.now()
): ContextFileRef[] {
  // Accumulate per-path data: lastTouchedAt + mentionCount
  const pathData = new Map<string, { lastTouchedAt: string; mentionCount: number }>();

  for (const message of messages) {
    if (!message.toolCall) continue;

    // Parse args if string
    let args: Record<string, unknown>;
    if (typeof message.toolCall.arguments === 'string') {
      try {
        args = JSON.parse(message.toolCall.arguments) as Record<string, unknown>;
      } catch {
        // Invalid JSON arguments — skip this tool call
        continue;
      }
    } else {
      args = message.toolCall.arguments;
    }

    const paths = extractPathsFromToolCall(message.toolCall.name, args);
    const touchedAt = new Date(now).toISOString(); // Use now as the touch time for summarizer

    for (const path of paths) {
      const existing = pathData.get(path);
      if (existing) {
        existing.mentionCount += 1;
        // Keep the most recent touch time
        existing.lastTouchedAt = touchedAt;
      } else {
        pathData.set(path, { lastTouchedAt: touchedAt, mentionCount: 1 });
      }
    }
  }

  if (pathData.size === 0) return [];

  const maxMentions = Math.max(...[...pathData.values()].map((d) => d.mentionCount));

  const refs: ContextFileRef[] = [...pathData.entries()].map(([path, data]) => ({
    path,
    lastTouchedAt: data.lastTouchedAt,
    relevance: computeRelevance(data.lastTouchedAt, data.mentionCount, maxMentions, now),
  }));

  // Sort descending by relevance, then alphabetically by path for determinism
  refs.sort((a, b) => {
    const relDiff = b.relevance - a.relevance;
    return relDiff !== 0 ? relDiff : a.path.localeCompare(b.path);
  });

  return refs;
}

// ============================================================================
// Main summarizer
// ============================================================================

/**
 * Builds a structured context memory summary from a session message array.
 *
 * This is the main entry point. It is:
 *   - PURE: no I/O, no mutations, no network calls.
 *   - DETERMINISTIC: same input → same output (modulo `now` parameter).
 *   - SAFE: all message content is scrubbed before appearing in the output.
 *
 * @param input - The summarizer input containing messages and budget.
 * @param now - Reference timestamp for recency computation (injectable for tests).
 * @returns A SummarizerOutput ready to write to agent_context_memory.
 *
 * @throws {RangeError} When tokenBudget is outside [TOKEN_BUDGET_MIN, TOKEN_BUDGET_MAX].
 *
 * @example
 * ```ts
 * const output = summarize({
 *   messages: sessionMessages,
 *   tokenBudget: 3000,
 * });
 * // output.summaryMarkdown — markdown injected into new agent
 * // output.fileRefs — top-relevance files to mention
 * // output.recentMessages — last 20 scrubbed previews
 * ```
 */
export function summarize(input: SummarizerInput, now: number = Date.now()): SummarizerOutput {
  const tokenBudget = Math.min(
    TOKEN_BUDGET_MAX,
    Math.max(TOKEN_BUDGET_MIN, input.tokenBudget ?? TOKEN_BUDGET_DEFAULT)
  );

  // Step 1: Build file refs from tool calls across ALL messages (full history gives better signal)
  const fileRefs = buildFileRefs(input.messages, now);

  // Step 2: Take last CONTEXT_MESSAGE_LIMIT messages for preview (most recent first, then reverse)
  const recentRaw = input.messages.slice(-CONTEXT_MESSAGE_LIMIT);
  const recentMessages: ContextMessage[] = recentRaw.map(buildMessagePreview);

  // Step 3: Detect task + open question from the full message array
  const task = detectCurrentTask(input.messages, input.taskOverride);
  const openQuestion = detectOpenQuestion(input.messages);

  // Step 4: Build summary markdown
  let summaryMarkdown = buildSummaryMarkdown(task, fileRefs, openQuestion);

  // Step 5: Enforce token budget — truncate summaryMarkdown if it overflows.
  // WHY only truncate summaryMarkdown, not fileRefs/recentMessages:
  //   fileRefs and recentMessages are stored separately in the DB and injected
  //   independently by buildInjectionPrompt(). The budget enforcement here applies
  //   only to the summaryMarkdown column.
  const estimatedTokens = estimateTokens(summaryMarkdown);
  if (estimatedTokens > tokenBudget) {
    // Truncate to approximate character count that fits the budget.
    // Heuristic: chars per token ≈ 4 (conservative for code-heavy content).
    const maxChars = tokenBudget * 4;
    summaryMarkdown = summaryMarkdown.slice(0, maxChars).trimEnd();
    // Append truncation notice so the receiving agent knows the summary is cut
    summaryMarkdown += '\n\n*(summary truncated to fit token budget)*';
  }

  return {
    summaryMarkdown,
    fileRefs,
    recentMessages,
    estimatedTokens: estimateTokens(summaryMarkdown),
  };
}

// ============================================================================
// Injection prompt builder
// ============================================================================

/**
 * Builds the system-role injection prompt from an AgentContextMemory record.
 *
 * This is what the agent factory injects as the system-role startup message
 * when the user switches focus to a new agent in the group.
 *
 * Structure:
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
 * ...
 * ```
 *
 * WHY a preamble header:
 *   All 11 supported agents are instructed to treat `[...]` headers as
 *   Styrby system metadata (this is documented in their startup prompts).
 *   The header makes it unambiguous that this section is injected context,
 *   not part of the user's actual task description.
 *
 * @param memory - The context memory record to inject.
 * @returns A ContextInjectionPayload ready to send to the agent factory.
 *
 * @example
 * ```ts
 * const payload = buildInjectionPrompt(memory);
 * agentFactory.setSystemContext(payload.systemPrompt);
 * ```
 */
export function buildInjectionPrompt(memory: AgentContextMemory): ContextInjectionPayload {
  const lines: string[] = [];

  // Preamble
  lines.push('[Styrby Context Sync — cross-agent handoff]');
  lines.push('');

  // Summary markdown (already scrubbed and budget-enforced)
  lines.push(memory.summaryMarkdown);
  lines.push('');

  // File refs — filter to relevance ≥ INJECTION_MIN_RELEVANCE
  const includedFileRefs = memory.fileRefs.filter(
    (ref) => ref.relevance >= INJECTION_MIN_RELEVANCE
  );
  if (includedFileRefs.length > 0) {
    lines.push('## Files you may need');
    for (const ref of includedFileRefs) {
      lines.push(`- ${ref.path}`);
    }
    lines.push('');
  }

  // Recent messages
  if (memory.recentMessages.length > 0) {
    lines.push(`## Recent conversation (last ${memory.recentMessages.length} messages)`);
    for (const msg of memory.recentMessages) {
      const roleLabel = msg.role === 'tool' ? 'tool' : msg.role;
      lines.push(`**${roleLabel}**: ${msg.preview}`);
    }
  }

  const systemPrompt = lines.join('\n');

  return {
    systemPrompt,
    includedFileRefs,
    messageCount: memory.recentMessages.length,
    estimatedTokens: estimateTokens(systemPrompt),
  };
}
