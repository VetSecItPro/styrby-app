/**
 * Goose Backend - Goose CLI agent adapter (Block/Square)
 *
 * This module provides a factory function for creating a Goose backend.
 * Goose is an open-source AI coding agent by Block (formerly Square),
 * licensed under Apache 2.0. It uses the Model Context Protocol (MCP)
 * for tool interactions and outputs structured JSON event lines.
 *
 * Key characteristics (verified against the real `goose` binary v1.37.0,
 * 2026-06-10 — `goose --help` / `goose run --help`):
 * - Binary name: `goose` (a single self-contained Rust binary; NOT a pip/brew
 *   `goose-ai` package — that is a different, unrelated project). Install per
 *   https://github.com/aaif-goose/goose (download script / release artifact).
 * - Config: `~/.config/goose/config.yaml` (provider + model live here)
 * - Headless run: `goose run -t/--text <prompt>` (or `-i -` to read the prompt
 *   from stdin). `run` is non-interactive by DEFAULT; `-s/--interactive` opts
 *   *into* an interactive session afterward. There is NO `--no-interactive`
 *   flag (the old code invented one).
 * - Structured output: `--output-format <text|json|stream-json>` (default
 *   `text`). There is NO `--format jsonl` flag (the old code invented one).
 *   We request `stream-json` for incremental parsing.
 * - `--no-session` runs without writing a session file (good for automation).
 * - Model / provider overrides: `--model <M>` / `--provider <P>`.
 * - Session naming / resume: `-n/--name <NAME>` (+ `-r/--resume`).
 *
 * WHY Apache 2.0 matters: Goose's license allows us to integrate it as a
 * backend without license compatibility concerns. We must retain the Goose
 * copyright notice per the license terms.
 *
 * Repo transferred 2026-04-07 from Block to the AI Alliance / Linux Foundation
 * (`block/goose` → `aaif-goose/goose`). GitHub redirects the old URL but new
 * docs and releases land at the new home.
 *
 * SCHEMA STATUS (#30 — UNVERIFIED): the per-line event schema emitted by
 * `--output-format stream-json` could NOT be captured because the local
 * environment has no provider configured (`goose run` aborts with "No provider
 * configured. Run 'goose configure' first."). The parser below maps a BEST-
 * GUESS event shape and is explicitly flagged as needing a real keyed session
 * to confirm. Until then, NON-JSON / unknown lines fall through harmlessly to a
 * debug log — the invocation is correct even if the parser is not yet proven.
 *
 * @see https://github.com/aaif-goose/goose
 * @module factories/goose
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type {
  AgentBackend,
  SessionId,
  StartSessionResult,
  AgentFactoryOptions,
  AgentFactoryMetadata,
} from '../core';
import { agentRegistry } from '../core';
import { logger } from '@/ui/logger';
import { buildSafeEnv, safeBufferAppend, validateExtraArgs } from '@/utils/safeEnv';
import { resolveApiKeyEnv, type ApiKeyProvider } from '@/utils/apiKeyProvider';
import { StreamingAgentBackendBase, formatInstallHint } from '../StreamingAgentBackendBase';
import type { CostReport } from '@styrby/shared/cost';

// ============================================================================
// Types
// ============================================================================

/**
 * Options for creating a Goose backend.
 */
export interface GooseBackendOptions extends AgentFactoryOptions {
  /**
   * API key for the underlying LLM provider.
   * Goose auto-detects from environment based on configured provider.
   * E.g., ANTHROPIC_API_KEY for Claude, OPENAI_API_KEY for GPT models.
   */
  apiKey?: string;

  /**
   * Model to use (e.g., 'claude-sonnet-4', 'gpt-4o').
   * Defaults to Goose's configured default model from ~/.config/goose/config.yaml.
   */
  model?: string;

  /**
   * LLM provider name (e.g., 'anthropic', 'openai', 'google').
   * Passed as --provider flag. Defaults to Goose's config file setting.
   */
  provider?: string;

  /**
   * Retained for API/back-compat. `goose run` is already non-interactive by
   * default (it does NOT have a `--no-interactive` flag — the old code invented
   * one). When this is left at its default (true) we additionally pass
   * `--no-session` so automated runs do not litter the session DB. Set to
   * `false` to keep a persistent session file (e.g. to later `--resume`).
   * Default: true
   */
  nonInteractive?: boolean;

  /**
   * Goose session name for resuming existing sessions.
   * When provided, Goose will resume that session instead of starting fresh.
   */
  sessionName?: string;

  /**
   * Additional Goose CLI arguments.
   * See: https://github.com/aaif-goose/goose#cli-options
   */
  extraArgs?: string[];
}

/**
 * Result of creating a Goose backend.
 */
export interface GooseBackendResult {
  /** The created AgentBackend instance */
  backend: AgentBackend;
  /** The resolved model that will be used */
  model: string | undefined;
  /** Optional capability / source metadata (additive, backward-compatible). */
  metadata?: AgentFactoryMetadata;
}

// ============================================================================
// JSON Output Parsing
// ============================================================================

/**
 * Goose `--output-format stream-json` event types.
 *
 * SCHEMA UNVERIFIED (#30): goose emits one JSON object per line when
 * `--output-format stream-json` is set, but the exact field names + the set of
 * `type` values below are a BEST-GUESS. They could not be confirmed because the
 * local box has no provider configured, so no real authed run could be
 * captured. In particular:
 *   - The `{ type: 'cost', usage: { cost_usd } }` shape is ASSUMED. goose's
 *     internal model tracks tokens via session-DB columns
 *     (`accumulated_input_tokens` / `accumulated_output_tokens` / `total_tokens`
 *     / `accumulated_cost`) and an Anthropic-style `Usage` block
 *     (`input_tokens`, `output_tokens`, `cache_read_input_tokens`,
 *     `cache_creation_input_tokens`) — but whether a per-line `type:'cost'`
 *     event with a `cost_usd` field is actually emitted is NOT confirmed.
 *   - `message` / `tool_call` / `tool_result` / `error` / `status` / `finish`
 *     are likewise best-guess `type` discriminants.
 * TODO(#30): once a keyed `goose configure` session is available, capture real
 * `stream-json` output and replace these guesses with the verified schema.
 * Until then the parser is intentionally tolerant: unknown lines are logged and
 * dropped rather than throwing, so a wrong guess degrades gracefully.
 */
interface GooseJsonEvent {
  type: 'message' | 'tool_call' | 'tool_result' | 'cost' | 'error' | 'status' | 'finish';
  /** Text content for message events */
  content?: string;
  /** Tool name for tool_call/tool_result events */
  tool?: string;
  /** Tool input arguments */
  input?: Record<string, unknown>;
  /** Tool result data */
  result?: unknown;
  /** Unique ID for correlating tool calls to results */
  call_id?: string;
  /** MCP cost/usage metadata */
  usage?: GooseUsageMetadata;
  /** Error message for error events */
  error?: string;
  /** Status string for status events */
  status?: string;
  /** Stop reason for finish events */
  stop_reason?: string;
}

/**
 * Usage metadata from Goose MCP responses.
 *
 * WHY: Goose embeds token usage in cost events from the MCP protocol response.
 * We extract this to give Styrby users accurate cost tracking without requiring
 * them to instrument their own LLM calls.
 */
interface GooseUsageMetadata {
  /** Input/prompt tokens consumed */
  input_tokens?: number;
  /** Output/completion tokens generated */
  output_tokens?: number;
  /** Cache read tokens (Anthropic prompt caching) */
  cache_read_input_tokens?: number;
  /** Cache write tokens (Anthropic prompt caching) */
  cache_creation_input_tokens?: number;
  /** Estimated cost in USD from Goose's internal calculator */
  cost_usd?: number;
}

/**
 * Parse a single JSONL output line from Goose.
 *
 * @param line - A single line of Goose stdout output
 * @returns Parsed GooseJsonEvent or null if the line is not valid JSON
 */
function parseGooseJsonLine(line: string): GooseJsonEvent | null {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith('{')) {
    return null;
  }

  try {
    return JSON.parse(trimmed) as GooseJsonEvent;
  } catch {
    return null;
  }
}

/**
 * Detect file system edits from Goose tool names.
 *
 * WHY: Goose uses standard MCP tool naming conventions for file operations.
 * We detect these to emit fs-edit events so the mobile app can show users
 * which files were modified without requiring them to read the full output.
 *
 * @param toolName - The MCP tool name from the tool_call event
 * @returns true if this tool modifies the file system
 */
function isFileEditTool(toolName: string): boolean {
  const fileEditTools = [
    'write_file',
    'create_file',
    'edit_file',
    'patch_file',
    'str_replace_editor',
    'apply_patch',
  ];
  return fileEditTools.some((t) => toolName.toLowerCase().includes(t));
}

/**
 * Detect an ANCHORED / structured error signal in a chunk of agent stderr.
 *
 * WHY (audit 2026-06-09 fix #20): the previous gate was a case-insensitive
 * substring scan for 'error'/'exception'/'failed' anywhere in stderr. A normal
 * diagnostic such as "Tests passed, 0 errors" or "0 errors, 0 warnings" tripped
 * it and emitted a `status: 'error'` frame, flipping the session to an error
 * state mid-run even though the agent succeeded (close later resolves with code
 * 0). That produced a flickering / stuck-error session UI on completely
 * successful runs.
 *
 * We now require a STRUCTURED marker: a line that STARTS with an error label
 * (after optional leading whitespace / log-level brackets), a Python traceback
 * header, or a panic. "0 errors" no longer matches because the word is not at a
 * line start in an error-label position.
 *
 * @param text - A chunk of stderr output (may contain multiple lines).
 * @returns True if any line carries a structured error signal.
 */
export function hasStructuredErrorSignal(text: string): boolean {
  for (const rawLine of text.split(/\r?\n/)) {
    // Strip a leading log-level prefix like "[2026-06-09] " or "WARN: " noise
    // is irrelevant; we anchor on the error token itself at the start of the
    // meaningful content.
    const line = rawLine.replace(/^\s+/, '');
    if (
      /^(?:error|fatal|panic|exception|traceback)\b[:\s]/i.test(line) ||
      /^traceback \(most recent call last\)/i.test(line) ||
      /^panic:/i.test(line)
    ) {
      return true;
    }
  }
  return false;
}

// ============================================================================
// GooseBackend Class
// ============================================================================

/**
 * Goose Backend implementation.
 *
 * Spawns Goose as a subprocess with JSONL output and parses the structured
 * events. Handles session lifecycle, cost tracking, and MCP tool events.
 */
class GooseBackend extends StreamingAgentBackendBase {
  protected readonly logTag = 'GooseBackend';
  private lineBuffer = '';
  private inputTokens = 0;
  private outputTokens = 0;
  private cacheReadTokens = 0;
  private cacheWriteTokens = 0;
  private totalCostUsd = 0;

  constructor(private options: GooseBackendOptions) {
    super();
  }

  /**
   * Process a parsed Goose JSON event and emit the corresponding AgentMessage.
   *
   * WHY: Goose's JSONL format maps cleanly onto our AgentMessage union type.
   * The mapping is explicit here so future changes to Goose's output format
   * are easy to find and fix.
   *
   * @param event - The parsed Goose JSON event
   */
  private handleGooseEvent(event: GooseJsonEvent): void {
    switch (event.type) {
      case 'message':
        if (event.content) {
          this.emit({ type: 'model-output', textDelta: event.content });
        }
        break;

      case 'tool_call':
        if (event.tool && event.call_id) {
          this.emit({
            type: 'tool-call',
            toolName: event.tool,
            args: event.input ?? {},
            callId: event.call_id,
          });
        }
        break;

      case 'tool_result':
        if (event.call_id && event.tool) {
          this.emit({
            type: 'tool-result',
            toolName: event.tool,
            result: event.result,
            callId: event.call_id,
          });

          // Detect file system edits from tool name and emit fs-edit event
          if (isFileEditTool(event.tool)) {
            const filePath =
              (event.input?.path as string) ??
              (event.input?.file_path as string) ??
              (event.input?.filename as string);
            if (filePath) {
              this.emit({
                type: 'fs-edit',
                description: `${event.tool}: ${filePath}`,
                path: filePath,
              });
            }
          }
        }
        break;

      case 'cost':
        // SCHEMA UNVERIFIED (#30): this assumes goose emits a per-line
        // `{ type:'cost', usage:{...} }` event with an optional `cost_usd`.
        // That shape is NOT confirmed against a real authed run (see the
        // GooseJsonEvent doc). If goose instead surfaces usage on a different
        // event (e.g. a final `finish`/`result` line carrying accumulated
        // tokens), this branch will simply never fire and no cost is reported —
        // a graceful degradation, not a crash. Revisit once #30 captures the
        // real stream-json output.
        if (event.usage) {
          const prevCostUsd = this.totalCostUsd;
          this.inputTokens += event.usage.input_tokens ?? 0;
          this.outputTokens += event.usage.output_tokens ?? 0;
          this.cacheReadTokens += event.usage.cache_read_input_tokens ?? 0;
          this.cacheWriteTokens += event.usage.cache_creation_input_tokens ?? 0;
          this.totalCostUsd += event.usage.cost_usd ?? 0;

          // Emit legacy token-count (keep for existing consumers)
          this.emit({
            type: 'token-count',
            inputTokens: this.inputTokens,
            outputTokens: this.outputTokens,
            cacheReadTokens: this.cacheReadTokens,
            cacheWriteTokens: this.cacheWriteTokens,
            costUsd: this.totalCostUsd,
          });

          // WHY: Emit unified CostReport for the cost-reporter to persist.
          // source='agent-reported' when Goose provides cost_usd; otherwise
          // 'styrby-estimate' since we don't have a fallback estimator here.
          // rawAgentPayload=null for estimates (schema refinement 3 requirement).
          const hasAgentCost = event.usage.cost_usd !== undefined;
          const costReport: CostReport = {
            sessionId: this.sessionId ?? '',
            messageId: null,
            agentType: 'goose',
            model: this.options.model ?? 'unknown',
            timestamp: new Date().toISOString(),
            source: hasAgentCost ? 'agent-reported' : 'styrby-estimate',
            billingModel: 'api-key',
            costUsd: this.totalCostUsd - prevCostUsd, // incremental cost for this event
            inputTokens: event.usage.input_tokens ?? 0,
            outputTokens: event.usage.output_tokens ?? 0,
            cacheReadTokens: event.usage.cache_read_input_tokens ?? 0,
            cacheWriteTokens: event.usage.cache_creation_input_tokens ?? 0,
            rawAgentPayload: hasAgentCost ? (event.usage as unknown as Record<string, unknown>) : null,
          };
          this.emit({ type: 'cost-report', report: costReport });
        }
        break;

      case 'error':
        this.emit({
          type: 'status',
          status: 'error',
          detail: event.error ?? 'Goose encountered an error',
        });
        break;

      case 'status':
        if (event.status) {
          const statusMap: Record<string, 'starting' | 'running' | 'idle' | 'stopped' | 'error'> =
            {
              starting: 'starting',
              running: 'running',
              idle: 'idle',
              complete: 'idle',
              done: 'idle',
              stopped: 'stopped',
              error: 'error',
            };
          const mapped = statusMap[event.status] ?? 'running';
          this.emit({ type: 'status', status: mapped });
        }
        break;

      case 'finish':
        // WHY: Goose emits a 'finish' event when the agent's response is complete.
        // We map this to 'idle' status so the mobile app knows it can send the next prompt.
        this.emit({ type: 'status', status: 'idle' });
        break;

      default:
        logger.debug('[GooseBackend] Unknown event type:', event);
    }
  }

  /**
   * Process stdout data, accumulating partial lines in a buffer.
   *
   * WHY: Node.js streams deliver data in arbitrary chunks — a single JSON object
   * may be split across multiple 'data' events. We buffer until we see a newline
   * before attempting to parse.
   *
   * @param data - Raw buffer chunk from the process stdout
   */
  private processStdout(data: Buffer): void {
    const text = data.toString();
    // SECURITY: Cap line buffer size to prevent memory exhaustion from
    // a malicious agent sending continuous data without newlines.
    this.lineBuffer = safeBufferAppend(this.lineBuffer, text);

    const lines = this.lineBuffer.split('\n');
    // Keep the last (potentially incomplete) line in the buffer
    this.lineBuffer = lines.pop() ?? '';

    for (const line of lines) {
      const event = parseGooseJsonLine(line);
      if (event) {
        this.handleGooseEvent(event);
      } else if (line.trim()) {
        // Non-JSON output (progress messages, warnings) — log but don't crash
        logger.debug('[GooseBackend] Non-JSON stdout:', line);
      }
    }
  }

  /**
   * Start a new Goose session.
   *
   * Initializes session state and optionally sends an initial prompt.
   * Token counters are reset for each new session.
   *
   * @param initialPrompt - Optional initial prompt to send immediately
   * @returns Promise resolving to session information
   * @throws {Error} When the backend has been disposed
   */
  async startSession(initialPrompt?: string): Promise<StartSessionResult> {
    if (this.disposed) {
      throw new Error('Backend has been disposed');
    }

    this.sessionId = randomUUID();
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.cacheReadTokens = 0;
    this.cacheWriteTokens = 0;
    this.totalCostUsd = 0;
    this.lineBuffer = '';

    this.emit({ type: 'status', status: 'starting' });

    logger.debug(`[GooseBackend] Starting session: ${this.sessionId}`);

    if (initialPrompt) {
      this.emit({ type: 'status', status: 'running' });
      await this.sendPrompt(this.sessionId, initialPrompt);
    } else {
      this.emit({ type: 'status', status: 'idle' });
    }

    return { sessionId: this.sessionId };
  }

  /**
   * Send a prompt to Goose.
   *
   * Spawns `goose run -t <prompt> --output-format stream-json` (plus
   * `--no-session` for ephemeral runs). `run` is non-interactive by default, so
   * no stdin blocking occurs. See the real flags documented in the module
   * header (verified against `goose run --help`, v1.37.0).
   *
   * @param sessionId - The active session ID (must match the one from startSession)
   * @param prompt - The user's prompt text
   * @throws {Error} When the backend is disposed or session ID is invalid
   */
  async sendPrompt(sessionId: SessionId, prompt: string): Promise<void> {
    if (this.disposed) {
      throw new Error('Backend has been disposed');
    }

    if (sessionId !== this.sessionId) {
      throw new Error(`Invalid session ID: ${sessionId}`);
    }

    // Reset run-scoped state (clears the cancelled flag) so this run's exit is
    // classified correctly by the close handler (audit 2026-06-09 fix #6).
    this.beginRun();

    this.lineBuffer = '';
    this.emit({ type: 'status', status: 'running' });

    // Build Goose command arguments.
    //
    // VERIFIED against `goose run --help` (binary v1.37.0, 2026-06-10):
    //   goose run -t <prompt> --output-format stream-json [--no-session]
    //             [--model M] [--provider P] [-n NAME]
    //
    // `run` is one-shot + non-interactive by default. `--output-format` accepts
    // text | json | stream-json (default text); we request stream-json for
    // incremental line-by-line parsing. NOTE: the previously-used `--format
    // jsonl` and `--no-interactive` flags DO NOT EXIST and have been removed.
    const args: string[] = [
      'run',                      // one-shot, non-interactive headless run
      '--text',                   // pass the prompt inline (alias: -t)
      prompt,
      '--output-format',
      'stream-json',              // line-delimited JSON events (schema unverified, #30)
    ];

    // WHY: by default we also pass --no-session so automated mobile-driven runs
    // do not accumulate session files in goose's local sqlite DB. Callers that
    // want a resumable session (sessionName / --resume) set nonInteractive:false
    // to keep the session file. This replaces the invented --no-interactive
    // flag; `run` is already non-interactive regardless.
    const useEphemeralSession = this.options.nonInteractive !== false;
    if (useEphemeralSession && !this.options.sessionName) {
      args.push('--no-session');
    }

    // Override the configured provider/model for this run (real flags).
    if (this.options.model) {
      args.push('--model', this.options.model);
    }
    if (this.options.provider) {
      args.push('--provider', this.options.provider);
    }

    // Name (and implicitly enable) a persistent session for later --resume.
    if (this.options.sessionName) {
      args.push('--name', this.options.sessionName);
    }

    // Append any extra CLI args (validated for safety)
    if (this.options.extraArgs) {
      args.push(...validateExtraArgs(this.options.extraArgs));
    }

    logger.debug(`[GooseBackend] Spawning goose with args:`, args);

    return new Promise<void>((resolve, reject) => {
      // WHY (audit 2026-06-09 fix #38): the 'error' (ENOENT/spawn-failure) and
      // 'close' handlers can BOTH fire for a single failed spawn. Previously the
      // close handler then emitted a second, contradictory status frame ("Goose
      // exited with code 1") that clobbered the friendly install hint the error
      // handler had just shown. This sentinel ensures whichever handler settles
      // the promise first wins; the other becomes a no-op.
      let settled = false;
      try {
        // SECURITY: Use buildSafeEnv() instead of spreading process.env to prevent
        // leaking secrets (SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL, etc.) to the
        // Goose subprocess. Only allowlisted system vars + explicit overrides are passed.
        this.process = spawn('goose', args, {
          cwd: this.options.cwd,
          env: buildSafeEnv({
            ...this.options.env,
            // SECURITY (audit 2026-05-05 HIGH fix): inject the API key only
            // under the env-var name(s) for its detected provider. The previous
            // fan-out shipped sk-ant-* keys to OPENAI/GOOGLE during Goose's
            // startup validation, where they appeared in vendor logs as
            // rejected attempts (real key-disclosure incident class).
            //
            // resolveApiKeyEnv() prefers an explicit `provider` (the existing
            // option), falls back to prefix-sniffing the key, and only
            // multi-injects (with a deprecation warn) if both fail.
            ...resolveApiKeyEnv(
              this.options.apiKey,
              ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY'],
              this.options.provider as ApiKeyProvider | undefined,
              'GooseBackend',
            ),
          }),
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        if (!this.process.stdout || !this.process.stderr) {
          throw new Error('Failed to create stdio pipes');
        }

        // Handle stdout — JSONL events from Goose
        this.process.stdout.on('data', (data: Buffer) => {
          this.processStdout(data);
        });

        // Handle stderr — warnings, progress, and errors
        this.process.stderr.on('data', (data: Buffer) => {
          const text = data.toString();
          logger.debug(`[GooseBackend] stderr: ${text.trim()}`);

          // Emit error status only for ANCHORED/structured error signals so a
          // benign line like "0 errors" does not poison the session state
          // (audit 2026-06-09 fix #20).
          if (hasStructuredErrorSignal(text)) {
            this.emit({
              type: 'status',
              status: 'error',
              detail: text.trim(),
            });
          }
        });

        // Handle process close
        this.process.on('close', (code) => {
          logger.debug(`[GooseBackend] Process exited with code: ${code}`);

          // Flush any remaining buffered output
          if (this.lineBuffer.trim()) {
            const event = parseGooseJsonLine(this.lineBuffer);
            if (event) {
              this.handleGooseEvent(event);
            }
            this.lineBuffer = '';
          }

          this.process = null;

          // If the 'error' handler already settled this run (e.g. ENOENT), do
          // not emit a second contradictory status / reject again (fix #38).
          if (settled) {
            return;
          }
          settled = true;

          if (code === 0) {
            this.emit({ type: 'status', status: 'idle' });
            resolve();
          } else if (this.wasCancelled()) {
            // Intentional user cancel (or dispose) SIGTERM'd the process, which
            // surfaces here as a non-zero/null exit. Emit a clean idle status and
            // resolve instead of a spurious agent error (audit 2026-06-09 fix #6).
            this.emit({ type: 'status', status: 'idle' });
            resolve();
          } else {
            this.emit({
              type: 'status',
              status: 'error',
              detail: `Goose exited with code ${code}`,
            });
            reject(new Error(`Goose exited with code ${code}`));
          }
        });

        // Handle process spawn errors (e.g., binary not found)
        // WHY (Phase 0.3 / SOC2 CC7.2): Surface friendly install hint on
        // ENOENT instead of raw "spawn ... ENOENT" Node error.
        this.process.on('error', (err: NodeJS.ErrnoException) => {
          // First settler wins; a later 'close' must not re-emit (fix #38).
          if (settled) {
            return;
          }
          settled = true;

          if (err.code === 'ENOENT') {
            const message = formatInstallHint('goose');
            logger.warn(`[GooseBackend] ${message}`);
            this.emit({ type: 'status', status: 'error', detail: message });
            reject(new Error(message));
            return;
          }
          logger.error(`[GooseBackend] Process error:`, err);
          this.emit({ type: 'status', status: 'error', detail: err.message });
          reject(err);
        });
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.emit({
          type: 'status',
          status: 'error',
          detail: err.message,
        });
        reject(err);
      }
    });
  }

  /**
   * Cancel the current Goose operation.
   *
   * Sends SIGTERM to allow Goose to clean up MCP connections gracefully.
   * Falls back to SIGKILL after 3 seconds if the process hasn't exited.
   *
   * @param sessionId - The active session ID to cancel
   * @throws {Error} When session ID does not match the active session
   */
  async cancel(sessionId: SessionId): Promise<void> {
    if (sessionId !== this.sessionId) {
      throw new Error(`Invalid session ID: ${sessionId}`);
    }

    if (this.process) {
      logger.debug('[GooseBackend] Cancelling Goose process');
      // Mark cancelled BEFORE SIGTERM so the close handler treats the resulting
      // non-zero exit as an intentional cancel, not a crash (audit 2026-06-09 fix #6).
      this.markCancelled();
      this.process.kill('SIGTERM');
      // WHY: Give Goose 3 seconds to clean up MCP server connections gracefully
      // before forcing a kill. MCP servers may be running as child processes of
      // Goose and need time to receive their own termination signals. The
      // escalation timer is tracked by the base class so it is cancelled on
      // clean exit, double-cancel, or dispose (SOC2 CC7.2).
      this.scheduleForceKill();
    }

    this.emit({ type: 'status', status: 'idle' });
  }

  /**
   * Respond to a Goose permission request.
   *
   * WHY: Goose may request permission for potentially dangerous operations
   * (e.g., shell commands, file deletions). The mobile app sends permission
   * responses via the server relay. We emit the response and, in interactive
   * mode, we would write 'y\n' or 'n\n' to stdin. In non-interactive mode,
   * Goose uses --no-interactive which auto-approves everything, so this is
   * primarily an acknowledgment mechanism.
   *
   * @param requestId - The ID of the permission request from Goose
   * @param approved - Whether the user approved the permission
   */
  async respondToPermission(requestId: string, approved: boolean): Promise<void> {
    this.emit({
      type: 'permission-response',
      id: requestId,
      approved,
    });

    // WHY: If the process is still running and has an open stdin, we write
    // the user's decision. Goose listens on stdin for permission responses
    // when running in interactive mode with permission prompts enabled.
    if (this.process?.stdin && !this.process.killed) {
      const response = approved ? 'y\n' : 'n\n';
      try {
        this.process.stdin.write(response);
      } catch {
        // Stdin may already be closed — safe to ignore
      }
    }
  }

  // waitForResponseComplete and dispose inherited from
  // StreamingAgentBackendBase. Base dispose() clears the listener array, the
  // cancel timer (SOC2 CC7.2), and SIGTERMs the process.
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a Goose backend.
 *
 * Goose is an open-source AI coding agent originally from Block (Square),
 * donated to the AI Alliance / Linux Foundation as `aaif-goose/goose` on
 * 2026-04-07. Apache 2.0. Uses Model Context Protocol (MCP) for tool
 * integrations and outputs structured JSONL events.
 *
 * The goose binary must be installed and available in PATH (it is a single
 * self-contained Rust binary, NOT the unrelated `goose-ai` pip/brew package).
 * See https://github.com/aaif-goose/goose for the current install script /
 * release artifacts.
 *
 * @param options - Configuration options for the backend
 * @returns GooseBackendResult with backend instance and resolved model
 *
 * @throws {Error} If goose is not installed (deferred until sendPrompt is called)
 *
 * @example
 * ```ts
 * const { backend } = createGooseBackend({
 *   cwd: '/path/to/project',
 *   model: 'claude-sonnet-4',
 *   provider: 'anthropic',
 * });
 *
 * const { sessionId } = await backend.startSession();
 * await backend.sendPrompt(sessionId, 'Refactor the auth module');
 * ```
 */
export function createGooseBackend(options: GooseBackendOptions): GooseBackendResult {
  logger.debug('[Goose] Creating backend with options:', {
    cwd: options.cwd,
    model: options.model,
    provider: options.provider,
    hasApiKey: !!options.apiKey,
    sessionName: options.sessionName,
    nonInteractive: options.nonInteractive,
  });

  return {
    backend: new GooseBackend(options),
    model: options.model,
    metadata: {
      modelSource: options.model ? 'explicit' : 'default',
      supportsStreaming: true,
      supportsTools: true,
    },
  };
}

// ============================================================================
// Registry
// ============================================================================

/**
 * Register the Goose backend with the global agent registry.
 *
 * Call this during application initialization to make Goose available
 * as an agent type. After calling this, `agentRegistry.create('goose', opts)`
 * will return a configured GooseBackend instance.
 *
 * @example
 * ```ts
 * // In application startup (initializeAgents):
 * registerGooseAgent();
 * ```
 */
export function registerGooseAgent(): void {
  agentRegistry.register('goose', (opts) => createGooseBackend(opts).backend);
  logger.debug('[Goose] Registered with agent registry');
}
