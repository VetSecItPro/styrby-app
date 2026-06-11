/**
 * Droid Backend - Factory's `droid` CLI agent adapter.
 *
 * This module provides a factory function for creating a Droid backend.
 * Droid is Factory AI's terminal coding agent. It runs against Factory's
 * hosted models (Claude, GPT, Gemini, and Factory "Droid Core" models) and
 * authenticates via a Factory account login or a `FACTORY_API_KEY`.
 *
 * Key characteristics (all verified against the real `droid` binary v0.144.2
 * via `droid --help` / `droid exec --help`, 2026-06-10):
 * - Binary name: `droid`
 * - Headless invocation: `droid exec [prompt]` (positional prompt). There is
 *   NO `chat` subcommand, NO `--message`, NO `--no-interactive`, NO `--backend`.
 * - Output format flag: `-o, --output-format <format>` with three valid
 *   values: `text` (default), `json`, and `stream-json`. We use `stream-json`
 *   for incremental NDJSON events.
 * - Session resume: `-s, --session-id <id>` (continue) / `--fork <id>` (fork).
 * - Model override: `-m, --model <id>` (default `claude-opus-4-8`).
 * - Autonomy is OFF by default (read-only). `--auto low|medium|high` raises it.
 *   Styrby keeps the default read-only posture unless the caller opts in via
 *   `autoLevel`, mirroring how we gate write access for the other adapters.
 *
 * AUTHENTICATION NOTE: Droid is Factory-hosted, not a generic BYOK/LiteLLM
 * proxy. The single credential it reads from the environment is
 * `FACTORY_API_KEY` (or an interactive `droid` login). The earlier assumption
 * that Droid was a LiteLLM multi-provider BYOK agent (injecting
 * ANTHROPIC_API_KEY / OPENAI_API_KEY / etc.) was WRONG and has been removed.
 *
 * OUTPUT SCHEMA — verification status:
 * - VERIFIED (captured from a real unauthenticated run, 2026-06-10):
 *     {"type":"system","subtype":"init", session_id, tools:[...], model, reasoning_effort}
 *     {"type":"error", source, message, timestamp, session_id}
 *     {"type":"result", subtype:"success"|"failure", is_error, duration_ms,
 *       num_turns, result, session_id,
 *       usage:{ input_tokens, output_tokens,
 *               cache_read_input_tokens, cache_creation_input_tokens }}
 *   This is the Claude-Code stream-json schema (snake_case usage fields).
 * - UNVERIFIED (could not capture — no Factory auth on this machine, #30):
 *     assistant/text-delta events and tool_use / tool_result events. Droid's
 *     `stream-json` is Claude-Code-shaped, so we parse the Claude-Code
 *     `{"type":"assistant", message:{ content:[...] }}` envelope, but those
 *     branches are marked UNVERIFIED below and MUST be re-confirmed against a
 *     keyed session before we claim they work.
 *
 * @see https://docs.factory.ai/cli/getting-started/overview
 * @module factories/droid
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
import { StreamingAgentBackendBase, formatInstallHint } from '../StreamingAgentBackendBase';
import type { CostReport } from '@styrby/shared/cost';

// ============================================================================
// Types
// ============================================================================

/**
 * Autonomy level for `droid exec --auto <level>`.
 *
 * Droid runs read-only by default; raising autonomy lets the agent write files
 * (`low`), run dev commands (`medium`), or perform production operations
 * (`high`). Verified via `droid exec --help`.
 */
export type DroidAutoLevel = 'low' | 'medium' | 'high';

/**
 * Options for creating a Droid backend.
 */
export interface DroidBackendOptions extends AgentFactoryOptions {
  /**
   * Factory API key (`FACTORY_API_KEY`).
   *
   * WHY: Droid is Factory-hosted. Unlike the BYOK adapters, it does NOT accept
   * provider keys (Anthropic/OpenAI/etc.) — it authenticates only against
   * Factory. When omitted, Droid falls back to the interactive login stored in
   * `~/.factory`. Injected via the environment, never a CLI flag, so it never
   * appears in `ps aux`.
   */
  factoryApiKey?: string;

  /**
   * Model to use (e.g., 'claude-opus-4-8', 'gpt-5.5', 'gemini-3.1-pro-preview').
   * Passed as `-m/--model`. Defaults to Droid's own default (`claude-opus-4-8`).
   */
  model?: string;

  /**
   * Autonomy level (`--auto low|medium|high`).
   *
   * WHY: Droid defaults to read-only. Omitting this keeps the safe default;
   * the mobile/relay layer decides when to grant write access, matching how the
   * other adapters gate file mutation.
   */
  autoLevel?: DroidAutoLevel;

  /**
   * Session ID to resume (`-s/--session-id`). When set, Droid continues that
   * session's conversation context. Requires a prompt (enforced by Droid).
   */
  resumeSessionId?: string;

  /**
   * Session ID to fork (`--fork`). Copies the source session's history into a
   * new local session, then continues on the forked branch. Mutually exclusive
   * with `resumeSessionId` at the CLI level; if both are set, fork wins.
   */
  forkSessionId?: string;

  /**
   * Additional Droid CLI arguments (validated for shell safety).
   * See: https://docs.factory.ai/cli
   */
  extraArgs?: string[];
}

/**
 * Result of creating a Droid backend.
 */
export interface DroidBackendResult {
  /** The created AgentBackend instance */
  backend: AgentBackend;
  /** The resolved model that will be used */
  model: string | undefined;
  /** Optional capability / source metadata (additive, backward-compatible). */
  metadata?: AgentFactoryMetadata;
}

// ============================================================================
// stream-json Output Schema (Claude-Code-shaped)
// ============================================================================

/**
 * Usage block reported by Droid's `result` event.
 *
 * VERIFIED: captured from a real `droid exec ... -o stream-json` / `-o json`
 * run (2026-06-10). Field names are Claude-Code snake_case:
 *   { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens }
 *
 * Droid does NOT report a cost field in this block. Cost is therefore derived
 * by Styrby's central cost layer from token counts + the resolved Factory model,
 * NOT from a LiteLLM table here (the old hardcoded LITELLM_PRICING table was
 * removed — it was never part of Droid's real output and produced misleading
 * numbers for Factory-hosted models).
 */
interface DroidUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/**
 * A single content block inside a Claude-Code `assistant` message.
 *
 * UNVERIFIED (#30): the assistant/tool envelope was not captured (no auth).
 * Shape is inferred from the Claude-Code stream-json schema that Droid's
 * init event advertises (tools list + `model` mirror Claude Code exactly).
 * Treat as best-effort until a keyed session confirms it.
 */
interface DroidContentBlock {
  type?: string;
  /** text for `{type:'text'}` blocks */
  text?: string;
  /** tool name for `{type:'tool_use'}` blocks */
  name?: string;
  /** tool call id for `{type:'tool_use'}` blocks */
  id?: string;
  /** tool input for `{type:'tool_use'}` blocks */
  input?: Record<string, unknown>;
  /** correlating id for `{type:'tool_result'}` blocks */
  tool_use_id?: string;
  /** result payload for `{type:'tool_result'}` blocks */
  content?: unknown;
}

/**
 * A parsed line of Droid `stream-json` / `json` output.
 *
 * `system`/`init`, `error`, and `result` are VERIFIED. `assistant`/`user`
 * (which carry the content blocks above) are UNVERIFIED (#30).
 */
interface DroidStreamMessage {
  type?: 'system' | 'assistant' | 'user' | 'result' | 'error';
  subtype?: string;
  session_id?: string;
  /** result event: assistant's final text */
  result?: string;
  /** result event: whether the run errored */
  is_error?: boolean;
  /** result event: token usage */
  usage?: DroidUsage;
  /** error event: human-readable message */
  message?: string | { content?: DroidContentBlock[] };
  /** error event: origin (e.g. 'cli') */
  source?: string;
  /** init event: model id */
  model?: string;
}

/**
 * Parse a single JSON line from Droid's output.
 *
 * @param line - A single line of Droid stdout (expected to be JSON)
 * @returns Parsed DroidStreamMessage or null if the line is not valid JSON
 */
function parseDroidJsonLine(line: string): DroidStreamMessage | null {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith('{')) {
    return null;
  }

  try {
    return JSON.parse(trimmed) as DroidStreamMessage;
  } catch {
    return null;
  }
}

/**
 * Extract a file path from Droid tool input arguments.
 *
 * UNVERIFIED (#30): field names inferred from Claude-Code tool schemas.
 *
 * @param toolInput - Tool input arguments from a tool_use block
 * @returns File path string or null if not found
 */
function extractDroidFilePath(toolInput?: Record<string, unknown>): string | null {
  if (!toolInput) return null;
  return (
    (toolInput.path as string) ??
    (toolInput.file_path as string) ??
    (toolInput.filename as string) ??
    (toolInput.target as string) ??
    null
  );
}

/**
 * Determine if a Droid tool call modifies the file system.
 *
 * UNVERIFIED (#30): tool-name patterns inferred from Droid's advertised tool
 * list (Edit, Create, ApplyPatch) plus common Claude-Code tool names.
 *
 * @param toolName - The tool name from a tool_use block
 * @returns true if this tool writes or modifies files
 */
function isDroidFileEditTool(toolName: string): boolean {
  const fileEditPatterns = [
    'write',
    'edit',
    'create',
    'applypatch',
    'patch',
    'str_replace',
    'apply_diff',
    'modify',
    'update_file',
  ];
  const lowerTool = toolName.toLowerCase();
  return fileEditPatterns.some((pattern) => lowerTool.includes(pattern));
}

// ============================================================================
// DroidBackend Class
// ============================================================================

/**
 * Droid Backend implementation.
 *
 * Spawns `droid exec` with `--output-format stream-json` and parses the
 * Claude-Code-shaped NDJSON event stream. Token usage is taken from the
 * VERIFIED `result` event; cost is left to Styrby's central cost layer
 * (Droid does not self-report cost).
 */
class DroidBackend extends StreamingAgentBackendBase {
  protected readonly logTag = 'DroidBackend';
  private droidSessionId: string | null = null;
  private lineBuffer = '';
  private inputTokens = 0;
  private outputTokens = 0;
  private cacheReadTokens = 0;
  private cacheWriteTokens = 0;
  // WHY: Track the resolved model so the emitted CostReport carries the model
  // the central cost layer needs to price the run.
  private currentModel: string | undefined;

  constructor(private options: DroidBackendOptions) {
    super();
    this.currentModel = options.model;
  }

  /**
   * Handle a parsed Droid stream-json message and emit AgentMessages.
   *
   * @param msg - The parsed Droid stream message
   */
  private handleDroidMessage(msg: DroidStreamMessage): void {
    if (msg.session_id) {
      this.droidSessionId = msg.session_id;
    }

    switch (msg.type) {
      case 'system':
        // VERIFIED: {"type":"system","subtype":"init", model, session_id, tools}
        // WHY: the init event is the authoritative source of the model Droid
        // actually resolved (it may differ from our requested model if Droid
        // applied a default). Capture it for accurate cost attribution.
        if (msg.subtype === 'init' && msg.model) {
          this.currentModel = msg.model;
        }
        break;

      case 'assistant':
        // UNVERIFIED (#30): assistant content-block envelope not captured under
        // a keyed session. Parsed best-effort per the Claude-Code schema.
        this.handleAssistantBlocks(msg);
        break;

      case 'user':
        // UNVERIFIED (#30): `user` events carry tool_result blocks in the
        // Claude-Code schema. Parsed best-effort.
        this.handleToolResultBlocks(msg);
        break;

      case 'result':
        // VERIFIED: final event carrying usage + the assistant's full text.
        this.handleResult(msg);
        break;

      case 'error':
        // VERIFIED: {"type":"error","source","message","timestamp","session_id"}
        this.emit({
          type: 'status',
          status: 'error',
          detail: typeof msg.message === 'string' ? msg.message : 'Droid encountered an error',
        });
        break;

      default:
        logger.debug('[DroidBackend] Unhandled message type:', msg);
    }
  }

  /**
   * Emit model-output / tool-call events from a (UNVERIFIED) assistant message.
   *
   * @param msg - An `assistant` stream message
   */
  private handleAssistantBlocks(msg: DroidStreamMessage): void {
    const blocks =
      msg.message && typeof msg.message === 'object' ? msg.message.content ?? [] : [];

    for (const block of blocks) {
      if (block.type === 'text' && block.text) {
        this.emit({ type: 'model-output', textDelta: block.text });
      } else if (block.type === 'tool_use' && block.name && block.id) {
        this.emit({
          type: 'tool-call',
          toolName: block.name,
          args: block.input ?? {},
          callId: block.id,
        });
      }
    }
  }

  /**
   * Emit tool-result / fs-edit events from a (UNVERIFIED) user message.
   *
   * @param msg - A `user` stream message carrying tool_result blocks
   */
  private handleToolResultBlocks(msg: DroidStreamMessage): void {
    const blocks =
      msg.message && typeof msg.message === 'object' ? msg.message.content ?? [] : [];

    for (const block of blocks) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        this.emit({
          type: 'tool-result',
          toolName: block.name ?? 'unknown',
          result: block.content,
          callId: block.tool_use_id,
        });

        if (block.name && isDroidFileEditTool(block.name)) {
          const filePath = extractDroidFilePath(block.input);
          if (filePath) {
            this.emit({
              type: 'fs-edit',
              description: `${block.name}: ${filePath}`,
              path: filePath,
            });
          }
        }
      }
    }
  }

  /**
   * Handle the VERIFIED `result` event: emit final text, token counts, and a
   * unified CostReport.
   *
   * @param msg - A `result` stream message
   */
  private handleResult(msg: DroidStreamMessage): void {
    // Emit the assistant's final text if present (the result event carries the
    // full answer even when streaming deltas weren't captured).
    if (typeof msg.result === 'string' && msg.result) {
      this.emit({ type: 'model-output', textDelta: msg.result });
    }

    if (msg.usage) {
      // VERIFIED usage field names (Claude-Code snake_case).
      const newInput = msg.usage.input_tokens ?? 0;
      const newOutput = msg.usage.output_tokens ?? 0;
      const newCacheRead = msg.usage.cache_read_input_tokens ?? 0;
      const newCacheWrite = msg.usage.cache_creation_input_tokens ?? 0;

      this.inputTokens += newInput;
      this.outputTokens += newOutput;
      this.cacheReadTokens += newCacheRead;
      this.cacheWriteTokens += newCacheWrite;

      const usageModel = this.currentModel ?? 'unknown';

      // Emit legacy token-count (keep for existing consumers). Droid does not
      // report cost, so costUsd is left 0 here; the central cost layer prices it.
      this.emit({
        type: 'token-count',
        inputTokens: this.inputTokens,
        outputTokens: this.outputTokens,
        cacheReadTokens: this.cacheReadTokens,
        cacheWriteTokens: this.cacheWriteTokens,
        costUsd: 0,
      });

      // WHY: Emit unified CostReport with source='styrby-estimate' because
      // Droid never reports cost_usd — pricing is always derived downstream
      // from token counts + the Factory model. rawAgentPayload carries the
      // real usage block so the cost layer can re-derive if needed.
      const costReport: CostReport = {
        sessionId: this.sessionId ?? '',
        messageId: null,
        agentType: 'droid',
        model: usageModel,
        timestamp: new Date().toISOString(),
        source: 'styrby-estimate',
        billingModel: 'api-key',
        costUsd: 0,
        inputTokens: newInput,
        outputTokens: newOutput,
        cacheReadTokens: newCacheRead,
        cacheWriteTokens: newCacheWrite,
        rawAgentPayload: msg.usage as unknown as Record<string, unknown>,
      };
      this.emit({ type: 'cost-report', report: costReport });
    }

    // The result event terminates the turn.
    if (msg.is_error) {
      this.emit({
        type: 'status',
        status: 'error',
        detail: typeof msg.result === 'string' ? msg.result : 'Droid run failed',
      });
    } else {
      this.emit({ type: 'status', status: 'idle' });
    }
  }

  /**
   * Process stdout data, buffering partial lines.
   *
   * @param data - Raw buffer chunk from process stdout
   */
  private processStdout(data: Buffer): void {
    const text = data.toString();
    // SECURITY: Cap buffer size to prevent memory exhaustion
    this.lineBuffer = safeBufferAppend(this.lineBuffer, text);

    const lines = this.lineBuffer.split('\n');
    this.lineBuffer = lines.pop() ?? '';

    for (const line of lines) {
      const msg = parseDroidJsonLine(line);
      if (msg) {
        this.handleDroidMessage(msg);
      } else if (line.trim()) {
        logger.debug('[DroidBackend] Non-JSON stdout:', line);
      }
    }
  }

  /**
   * Start a new Droid session.
   *
   * Resets all token accumulators. If a resumeSessionId/forkSessionId was
   * provided in options, the first prompt will continue/fork that session.
   *
   * @param initialPrompt - Optional prompt to send immediately after session start
   * @returns Promise resolving to the session information
   * @throws {Error} When the backend has been disposed
   */
  async startSession(initialPrompt?: string): Promise<StartSessionResult> {
    if (this.disposed) {
      throw new Error('Backend has been disposed');
    }

    this.sessionId = randomUUID();
    this.droidSessionId = this.options.resumeSessionId ?? this.options.forkSessionId ?? null;
    this.currentModel = this.options.model;
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.cacheReadTokens = 0;
    this.cacheWriteTokens = 0;
    this.lineBuffer = '';

    this.emit({ type: 'status', status: 'starting' });

    logger.debug(`[DroidBackend] Starting session: ${this.sessionId}`);

    if (initialPrompt) {
      this.emit({ type: 'status', status: 'running' });
      await this.sendPrompt(this.sessionId, initialPrompt);
    } else {
      this.emit({ type: 'status', status: 'idle' });
    }

    return { sessionId: this.sessionId };
  }

  /**
   * Build the `droid exec` argument vector for a prompt.
   *
   * Real form (verified `droid exec --help`, v0.144.2):
   *   droid exec <prompt> --output-format stream-json [--fork <id> | -s <id>]
   *     [-m <model>] [--auto <level>] [...extraArgs]
   *
   * @param prompt - The user's prompt text (positional argument)
   * @returns The argv array passed to spawn (excluding the binary name)
   */
  private buildArgs(prompt: string): string[] {
    const args: string[] = [
      'exec',
      prompt, // positional prompt — NOT a --message flag
      '--output-format',
      'stream-json', // incremental NDJSON events (verified valid choice)
    ];

    // Session continuation: fork takes precedence over resume (they share the
    // same underlying session-id; both require a prompt, which we always pass).
    if (this.options.forkSessionId) {
      args.push('--fork', this.options.forkSessionId);
    } else if (this.droidSessionId) {
      args.push('-s', this.droidSessionId);
    }

    // Model override (-m/--model). Default is claude-opus-4-8 when omitted.
    if (this.options.model) {
      args.push('-m', this.options.model);
    }

    // Autonomy: omit to keep Droid's safe read-only default; only raise when
    // the caller explicitly opts in.
    if (this.options.autoLevel) {
      args.push('--auto', this.options.autoLevel);
    }

    // Extra args (validated for shell safety — SEC-ARGS-001)
    if (this.options.extraArgs) {
      args.push(...validateExtraArgs(this.options.extraArgs));
    }

    return args;
  }

  /**
   * Send a prompt to Droid.
   *
   * Spawns `droid exec`. The Factory API key (if supplied) is injected via the
   * environment so it never appears in process arguments.
   *
   * @param sessionId - The active session ID (must match startSession result)
   * @param prompt - The user's prompt text
   * @throws {Error} When disposed, session ID is invalid, or process spawn fails
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

    const args = this.buildArgs(prompt);

    logger.debug(`[DroidBackend] Spawning droid with args:`, args);

    // Build the Factory API key environment override.
    // WHY: Droid authenticates against Factory only (FACTORY_API_KEY). It is
    // NOT a multi-provider BYOK proxy, so we do NOT inject ANTHROPIC_API_KEY /
    // OPENAI_API_KEY / etc. (the prior fan-out was based on a wrong assumption
    // about Droid being a LiteLLM agent). The key goes in the environment, not
    // a CLI flag, to keep it out of `ps aux`.
    const apiKeyEnv: Record<string, string> = {};
    if (this.options.factoryApiKey) {
      apiKeyEnv.FACTORY_API_KEY = this.options.factoryApiKey;
    }

    return new Promise<void>((resolve, reject) => {
      try {
        // SECURITY: Use buildSafeEnv() to prevent leaking internal Styrby
        // secrets to the Droid subprocess. Only allowlisted system vars and the
        // explicitly injected Factory key are forwarded.
        this.process = spawn('droid', args, {
          cwd: this.options.cwd,
          env: buildSafeEnv({
            ...this.options.env,
            ...apiKeyEnv,
          }),
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        if (!this.process.stdout || !this.process.stderr) {
          throw new Error('Failed to create stdio pipes');
        }

        // Handle stdout — stream-json messages from Droid
        this.process.stdout.on('data', (data: Buffer) => {
          this.processStdout(data);
        });

        // Handle stderr — Droid diagnostic messages
        this.process.stderr.on('data', (data: Buffer) => {
          const text = data.toString();
          logger.debug(`[DroidBackend] stderr: ${text.trim()}`);

          if (
            text.includes('Error') ||
            text.includes('error') ||
            text.includes('Exception') ||
            text.includes('failed')
          ) {
            this.emit({
              type: 'status',
              status: 'error',
              detail: text.trim(),
            });
          }
        });

        // Handle process exit
        this.process.on('close', (code) => {
          logger.debug(`[DroidBackend] Process exited with code: ${code}`);

          // Flush remaining buffer
          if (this.lineBuffer.trim()) {
            const msg = parseDroidJsonLine(this.lineBuffer);
            if (msg) {
              this.handleDroidMessage(msg);
            }
            this.lineBuffer = '';
          }

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
              detail: `Droid exited with code ${code}`,
            });
            reject(new Error(`Droid exited with code ${code}`));
          }

          this.process = null;
        });

        // Handle process spawn errors
        // WHY (Phase 0.3 / SOC2 CC7.2): Surface friendly install hint on
        // ENOENT instead of raw "spawn ... ENOENT" Node error.
        this.process.on('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'ENOENT') {
            const message = formatInstallHint('droid');
            logger.warn(`[DroidBackend] ${message}`);
            this.emit({ type: 'status', status: 'error', detail: message });
            reject(new Error(message));
            return;
          }
          logger.error(`[DroidBackend] Process error:`, err);
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
   * Cancel the current Droid operation.
   *
   * WHY: Droid may be mid-stream with a model API call when cancelled.
   * SIGTERM allows Droid to close its HTTP connection cleanly and avoid
   * billing the user for a partial response.
   *
   * @param sessionId - The active session ID to cancel
   * @throws {Error} When session ID does not match the active session
   */
  async cancel(sessionId: SessionId): Promise<void> {
    if (sessionId !== this.sessionId) {
      throw new Error(`Invalid session ID: ${sessionId}`);
    }

    if (this.process) {
      logger.debug('[DroidBackend] Cancelling Droid process');
      // Mark cancelled BEFORE SIGTERM so the close handler treats the resulting
      // non-zero exit as an intentional cancel, not a crash (audit 2026-06-09 fix #6).
      this.markCancelled();
      this.process.kill('SIGTERM');
      // WHY: Track escalation timer via base class so it is cleared on clean
      // exit / dispose / double-cancel. SOC2 CC7.2.
      this.scheduleForceKill();
    }

    this.emit({ type: 'status', status: 'idle' });
  }

  /**
   * Respond to a Droid permission request.
   *
   * NOTE: `droid exec` is non-interactive — permissions are governed by the
   * `--auto` level, not an interactive y/n prompt. This handler remains for
   * interface compatibility and best-effort stdin signalling.
   *
   * @param requestId - The ID of the permission request
   * @param approved - Whether the user approved the request
   */
  async respondToPermission(requestId: string, approved: boolean): Promise<void> {
    this.emit({
      type: 'permission-response',
      id: requestId,
      approved,
    });

    if (this.process?.stdin && !this.process.killed) {
      const response = approved ? 'y\n' : 'n\n';
      try {
        this.process.stdin.write(response);
      } catch {
        // Stdin may be closed — safe to ignore
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
 * Create a Droid backend.
 *
 * Droid is Factory AI's hosted terminal coding agent. It is invoked headlessly
 * via `droid exec <prompt> --output-format stream-json` and authenticates
 * against Factory (interactive login or `FACTORY_API_KEY`). Cost is derived
 * downstream from the token counts in Droid's `result` event.
 *
 * The droid binary must be installed and available in PATH.
 * Install via: https://docs.factory.ai/cli/getting-started/overview
 *
 * @param options - Configuration options for the backend
 * @returns DroidBackendResult with backend instance and resolved model
 *
 * @example
 * ```ts
 * const { backend } = createDroidBackend({
 *   cwd: '/path/to/project',
 *   model: 'claude-opus-4-8',
 *   factoryApiKey: process.env.FACTORY_API_KEY,
 *   autoLevel: 'medium',
 * });
 *
 * const { sessionId } = await backend.startSession();
 * await backend.sendPrompt(sessionId, 'Review the PR diff for security issues');
 * ```
 */
export function createDroidBackend(options: DroidBackendOptions): DroidBackendResult {
  logger.debug('[Droid] Creating backend with options:', {
    cwd: options.cwd,
    model: options.model,
    autoLevel: options.autoLevel,
    hasFactoryApiKey: !!options.factoryApiKey,
    resumeSessionId: options.resumeSessionId,
    forkSessionId: options.forkSessionId,
  });

  return {
    backend: new DroidBackend(options),
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
 * Register the Droid backend with the global agent registry.
 *
 * Call this during application initialization to make Droid available
 * as an agent type. After calling this, `agentRegistry.create('droid', opts)`
 * will return a configured DroidBackend instance.
 *
 * @example
 * ```ts
 * // In application startup (initializeAgents):
 * registerDroidAgent();
 * ```
 */
export function registerDroidAgent(): void {
  agentRegistry.register('droid', (opts) => createDroidBackend(opts).backend);
  logger.debug('[Droid] Registered with agent registry');
}
