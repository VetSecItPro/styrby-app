/**
 * OpenCode Backend - OpenCode CLI agent adapter
 *
 * This module provides a factory function for creating an OpenCode backend.
 * OpenCode is a terminal-based AI coding assistant with full JSON output support.
 *
 * Key characteristics:
 * - Full JSON support: `opencode --format json`
 * - HTTP API available: `opencode serve` (for real-time streaming)
 * - Built-in cost tracking: Cost, PromptTokens, CompletionTokens in session data
 * - Session persistence with IDs
 *
 * @module factories/opencode
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
import { toNonNegativeNumber } from '@/utils/coerce';
import {
  resolveOpencodeStorageDir,
  readStepFinishParts,
  findLatestAssistantMessageId,
  selectMissedStepFinishes,
} from './opencodeStorage';
import { resolveApiKeyEnv, type ApiKeyProvider } from '@/utils/apiKeyProvider';
import { StreamingAgentBackendBase, formatInstallHint } from '../StreamingAgentBackendBase';
import type { CostReport } from '@styrby/shared/cost';

/**
 * Options for creating an OpenCode backend
 */
export interface OpenCodeBackendOptions extends AgentFactoryOptions {
  /**
   * API key for the LLM provider (e.g., Anthropic, OpenAI).
   * OpenCode auto-detects from environment.
   */
  apiKey?: string;

  /**
   * Model to use (e.g., 'claude-sonnet-4-20250514').
   * Defaults to OpenCode's default model.
   */
  model?: string;

  /**
   * Use HTTP API mode instead of subprocess.
   * When true, starts `opencode serve` and communicates via HTTP.
   * Default: false (subprocess mode)
   */
  useHttpApi?: boolean;

  /**
   * Port for HTTP API mode.
   * Default: 8080
   */
  httpPort?: number;

  /**
   * Additional OpenCode CLI arguments.
   */
  extraArgs?: string[];

  /**
   * Session ID to resume (if available).
   * OpenCode supports session persistence.
   */
  resumeSessionId?: string;

  /**
   * LLM provider this BYOK key belongs to (e.g. 'anthropic', 'openai').
   *
   * WHY (audit 2026-06-09 HIGH fix #7): OpenCode is multi-provider, but the
   * factory previously hardcoded the key into ANTHROPIC_API_KEY. An OpenCode
   * user supplying an OpenAI `sk-...` key had it exported under the wrong name,
   * so it (a) was presented to Anthropic's auth endpoint during OpenCode's
   * startup provider validation — appearing in the WRONG vendor's logs as a
   * rejected credential (the cross-provider key-disclosure class the goose fix
   * already closed) and (b) silently failed to authenticate.
   *
   * If unset, the factory sniffs the key prefix and falls back to legacy
   * fan-out only when sniffing fails (with a deprecation warning).
   */
  provider?: ApiKeyProvider;
}

/**
 * Result of creating an OpenCode backend
 */
export interface OpenCodeBackendResult {
  /** The created AgentBackend instance */
  backend: AgentBackend;
  /** The resolved model that will be used */
  model: string | undefined;
  /** Optional capability / source metadata (additive, backward-compatible). */
  metadata?: AgentFactoryMetadata;
}

/**
 * OpenCode `--format json` event — VERIFIED against the real opencode binary
 * (v1.17.x, captured 2026-06-10). opencode emits newline-delimited events of the
 * shape `{ type, sessionID, part }`:
 *   - `step_start`  : turn boundary (no payload to surface)
 *   - `text`        : assistant output, carried in `part.text` (a complete part,
 *                     not a delta)
 *   - `step_finish` : authoritative usage event — `part.cost` (USD) +
 *                     `part.tokens.{input,output,reasoning,cache.{read,write}}`
 * `sessionID` is present on EVERY event and is captured for `--session` resume.
 *
 * WHY this replaced the prior interface: the old shape (`type:'session'` with
 * `Cost`/`PromptTokens`/`CompletionTokens`) does not exist in opencode's output —
 * it was an invented schema, so the parser emitted nothing against the real CLI.
 */
interface OpenCodeTokens {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
}
interface OpenCodePart {
  /** Part discriminator: 'step-start' | 'text' | 'step-finish' | tool parts. */
  type?: string;
  /** Stable part id (`prt_...`); used to dedupe stdout vs storage recovery. */
  id?: string;
  /** Owning assistant message id (`msg_...`); locates the turn in storage. */
  messageID?: string;
  /** Assistant text (present on `text` events). */
  text?: string;
  /** Step cost in USD (present on `step-finish`). */
  cost?: number;
  /** Token usage for the step (present on `step-finish`). */
  tokens?: OpenCodeTokens;
  /** Stop reason (present on `step-finish`). */
  reason?: string;
}
interface OpenCodeJsonMessage {
  /** Event type: 'step_start' | 'text' | 'step_finish' | …. */
  type: string;
  /** Session id, present on every event (used for `--session` resume). */
  sessionID?: string;
  part?: OpenCodePart;
}

/**
 * Parse OpenCode JSON output line.
 *
 * @param line - A line of JSON output from OpenCode
 * @returns Parsed message or null if invalid
 */
function parseOpenCodeJson(line: string): OpenCodeJsonMessage | null {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith('{')) {
    return null;
  }

  try {
    return JSON.parse(trimmed) as OpenCodeJsonMessage;
  } catch {
    return null;
  }
}

/**
 * OpenCode Backend implementation.
 *
 * Spawns OpenCode as a subprocess with JSON output format and parses
 * the structured responses.
 */
class OpenCodeBackend extends StreamingAgentBackendBase {
  protected readonly logTag = 'OpenCodeBackend';
  private openCodeSessionId: string | null = null;
  private inputTokens = 0;
  private outputTokens = 0;
  private totalCost = 0;
  // #26855 cost-recovery state, reset per turn (see resetTurnCostTracking):
  /** Part ids of step-finish events we emitted from stdout this turn. */
  private seenStepFinishIds = new Set<string>();
  /** Count of step-finish events seen on stdout this turn. */
  private stdoutStepFinishCount = 0;
  /** The current turn's assistant message id, learned from stdout step-finish events. */
  private currentTurnMessageId: string | null = null;
  private lineBuffer = '';

  constructor(private options: OpenCodeBackendOptions) {
    super();
  }

  /**
   * Handle a parsed OpenCode JSON message.
   *
   * Converts OpenCode's JSON format to standard AgentMessage format.
   *
   * @param msg - The parsed OpenCode message
   */
  private handleJsonMessage(msg: OpenCodeJsonMessage): void {
    // sessionID rides on EVERY event; capture it so follow-up prompts resume the
    // same opencode session via `--session`.
    if (msg.sessionID) this.openCodeSessionId = msg.sessionID;

    switch (msg.type) {
      case 'text': {
        // Assistant output. opencode delivers complete text parts (not deltas),
        // so emit fullText rather than a delta.
        const text = msg.part?.text;
        if (text) this.emit({ type: 'model-output', fullText: text });
        break;
      }

      case 'step_finish': {
        // Authoritative usage event: part.cost (USD) + part.tokens.{input,output,
        // cache.{read,write}}. opencode is BYOK so billingModel is 'api-key'.
        const part = msg.part;
        if (!part) break;
        const t = part.tokens ?? {};
        // Track this stdout step-finish so the on-close storage reconciliation
        // (opencode #26855) can tell which steps already reached us and recover
        // only the ones the stream dropped. id/messageID may be absent on older
        // opencode; the reconciler degrades to count-based recovery if so.
        this.stdoutStepFinishCount += 1;
        if (part.id) this.seenStepFinishIds.add(part.id);
        if (part.messageID) this.currentTurnMessageId = part.messageID;
        // WHY emit PER-STEP values (NOT a running total) — multi-step billing
        // correctness, verified 2026-06-11 by tracing the real cost_records
        // contract (not inferred):
        //   • opencode emits one step_finish PER API call. A tool-using turn
        //     emits several; each carries THAT call's input/output/cost (you are
        //     billed for the full input context on every call — that is real
        //     spend, not double-counting).
        //   • We emit one cost-report per step_finish. The cost-reporter writes
        //     ONE cost_records row per event (unique idempotency key,
        //     `cost-${Date.now()}-${uuid}`), and budget-monitor SUMS the rows.
        //   • Therefore summing the per-step rows already yields the true turn
        //     total. DO NOT accumulate into a running total here: that would make
        //     each emitted row cumulative, and the downstream sum would
        //     quadratically OVER-count. (This corrects the prior "take latest"
        //     comment, which misdescribed the behavior.)
        //   • Known residual risk — opencode issue #26855: `run --format json`
        //     can exit before emitting the FINAL step_finish on stdout (it is in
        //     session storage but not the stream), so we may miss the last call's
        //     cost. Tracked; a storage-read fallback is the eventual fix.
        //
        // WHY toNonNegativeNumber (#24): raw values are untrusted stdout; coerce
        // a string/negative/NaN to a finite number at the parse boundary so the
        // `number`-typed CostReport stays honest. Per-step (default 0 if a field
        // is absent) — never carry a prior step's value forward, which would
        // re-count it when the rows are summed.
        const stepInput = toNonNegativeNumber(t.input);
        const stepOutput = toNonNegativeNumber(t.output);
        const cacheRead = toNonNegativeNumber(t.cache?.read);
        const cacheWrite = toNonNegativeNumber(t.cache?.write);
        const stepCost = toNonNegativeNumber(part.cost);
        this.inputTokens = stepInput;
        this.outputTokens = stepOutput;
        this.totalCost = stepCost;

        // Legacy token-count (kept for existing consumers) — this step's tokens.
        this.emit({
          type: 'token-count',
          inputTokens: stepInput,
          outputTokens: stepOutput,
          totalTokens: stepInput + stepOutput,
          costUsd: stepCost,
        });

        // Unified CostReport — source='agent-reported' (opencode reports real USD).
        this.emitCostReport(
          { input: stepInput, output: stepOutput, cacheRead, cacheWrite, cost: stepCost },
          msg as unknown as Record<string, unknown>,
        );
        break;
      }

      case 'step_start':
        // Turn boundary — no payload to surface.
        break;

      default:
        // WHY no tool-call / tool-result / fs-edit mapping: the real opencode
        // tool-event schema has NOT been captured yet (a tool-triggering session
        // is required). The prior code mapped an INVENTED `tool_use`/`tool_result`
        // schema opencode never emits — rather than re-invent, we surface nothing
        // until the real shape is verified. Tracked in the per-agent protocol
        // verification task.
        logger.debug('[OpenCodeBackend] Unhandled opencode event type:', msg.type);
    }
  }

  /**
   * Build + emit a unified CostReport for one opencode API call (one step).
   *
   * Shared by the live stdout path and the on-close storage reconciliation so
   * both produce byte-identical cost-report shapes (the cost-reporter writes one
   * summed cost_records row per event).
   *
   * @param v - This step's usage (already coerced to finite non-negative numbers).
   * @param raw - Raw payload for audit (the stdout event, or a storage marker).
   */
  private emitCostReport(
    v: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number },
    raw: Record<string, unknown>,
  ): void {
    const report: CostReport = {
      sessionId: this.sessionId ?? '',
      messageId: null,
      agentType: 'opencode',
      model: this.options.model ?? 'unknown',
      timestamp: new Date().toISOString(),
      source: 'agent-reported',
      billingModel: 'api-key',
      costUsd: v.cost,
      inputTokens: v.input,
      outputTokens: v.output,
      cacheReadTokens: v.cacheRead,
      cacheWriteTokens: v.cacheWrite,
      rawAgentPayload: raw,
    };
    this.emit({ type: 'cost-report', report });
  }

  /** Reset the per-turn #26855 cost-recovery tracking at the start of a prompt. */
  private resetTurnCostTracking(): void {
    this.seenStepFinishIds.clear();
    this.stdoutStepFinishCount = 0;
    this.currentTurnMessageId = null;
  }

  /**
   * Recover any step-finish costs that opencode persisted to session storage but
   * never emitted on stdout (opencode issue #26855: `run --format json` can exit
   * on `session.status=idle` before flushing the final step-finish event).
   *
   * Reads the turn's step-finish parts from opencode's on-disk storage, selects
   * the ones the stdout stream missed (id-dedupe when available, else count-based
   * trailing recovery), and emits a recovered cost-report for each — so the
   * billed total is complete regardless of the user's opencode version. Wholly
   * best-effort: any failure (no storage, fork without this layout, malformed
   * files) leaves the live-streamed costs untouched and never throws.
   */
  private reconcileCostFromStorage(): void {
    try {
      const sessionId = this.openCodeSessionId;
      if (!sessionId) return;
      const storageDir = resolveOpencodeStorageDir();
      const messageId =
        this.currentTurnMessageId ?? findLatestAssistantMessageId(storageDir, sessionId);
      if (!messageId) return;
      const parts = readStepFinishParts(storageDir, messageId);
      if (parts.length === 0) return;
      const missed = selectMissedStepFinishes(
        parts,
        this.seenStepFinishIds,
        this.stdoutStepFinishCount,
      );
      for (const p of missed) {
        logger.debug(
          `[OpenCodeBackend] Recovered step-finish ${p.id} from storage (opencode #26855); cost=${p.cost}`,
        );
        this.emitCostReport(
          { input: p.inputTokens, output: p.outputTokens, cacheRead: p.cacheReadTokens, cacheWrite: p.cacheWriteTokens, cost: p.cost },
          { recovered: true, source: 'session-storage', partId: p.id, messageId },
        );
      }
    } catch (err) {
      // Recovery must never break the run; the live-streamed costs still stand.
      logger.debug('[OpenCodeBackend] storage cost reconciliation skipped:', err);
    }
  }

  /**
   * Process stdout data, handling partial lines.
   *
   * @param data - Raw stdout data buffer
   */
  private processStdout(data: Buffer): void {
    const text = data.toString();
    // SECURITY: Cap line buffer size to prevent memory exhaustion
    this.lineBuffer = safeBufferAppend(this.lineBuffer, text);

    // Process complete lines
    const lines = this.lineBuffer.split('\n');
    this.lineBuffer = lines.pop() ?? ''; // Keep incomplete line in buffer

    for (const line of lines) {
      const msg = parseOpenCodeJson(line);
      if (msg) {
        this.handleJsonMessage(msg);
      } else if (line.trim()) {
        // Non-JSON output - emit as raw text
        logger.debug('[OpenCodeBackend] Non-JSON stdout:', line);
      }
    }
  }

  /**
   * Start a new OpenCode session.
   *
   * @param initialPrompt - Optional initial prompt to send
   * @returns Promise resolving to session information
   */
  async startSession(initialPrompt?: string): Promise<StartSessionResult> {
    if (this.disposed) {
      throw new Error('Backend has been disposed');
    }

    this.sessionId = randomUUID();
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.totalCost = 0;
    this.lineBuffer = '';
    this.resetTurnCostTracking();
    this.openCodeSessionId = this.options.resumeSessionId ?? null;

    this.emit({ type: 'status', status: 'starting' });

    logger.debug(`[OpenCodeBackend] Starting session: ${this.sessionId}`);

    // If initial prompt provided, send it
    if (initialPrompt) {
      this.emit({ type: 'status', status: 'running' });
      await this.sendPrompt(this.sessionId, initialPrompt);
    } else {
      this.emit({ type: 'status', status: 'idle' });
    }

    return { sessionId: this.sessionId };
  }

  /**
   * Send a prompt to OpenCode.
   *
   * Uses subprocess mode with --format json for structured output.
   *
   * @param sessionId - The session to send the prompt to
   * @param prompt - The user's prompt text
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
    // Reset per-turn cost-recovery tracking so the on-close storage
    // reconciliation only considers THIS turn's step-finishes (#26855).
    this.resetTurnCostTracking();

    this.emit({ type: 'status', status: 'running' });

    // Build OpenCode command arguments.
    //
    // WHY this exact shape (verified against `opencode run --help`, opencode
    // v1.17.x, 2026-06-10): headless runs use the `run` SUBCOMMAND with a
    // POSITIONAL message — there is no `--message` flag and no `--non-interactive`
    // flag (the prior args invented both, which would have launched the TUI or
    // errored instead of running headless). `--format json` emits raw JSON events;
    // `-m/--model` and `-s/--session` are real. `run` is inherently non-interactive.
    const args: string[] = ['run', prompt, '--format', 'json'];

    // Add model if specified
    if (this.options.model) {
      args.push('--model', this.options.model);
    }

    // Add session ID for persistence (continue a prior session)
    if (this.openCodeSessionId) {
      args.push('--session', this.openCodeSessionId);
    }

    // Add extra args (validated for shell safety — SEC-ARGS-001)
    if (this.options.extraArgs) {
      args.push(...validateExtraArgs(this.options.extraArgs));
    }

    logger.debug(`[OpenCodeBackend] Spawning opencode with args:`, args);

    return new Promise<void>((resolve, reject) => {
      try {
        // SECURITY: Use buildSafeEnv() to prevent leaking secrets to OpenCode subprocess.
        this.process = spawn('opencode', args, {
          cwd: this.options.cwd,
          env: buildSafeEnv({
            ...this.options.env,
            // SECURITY (audit 2026-06-09 HIGH fix #7): inject the API key only
            // under the env-var name(s) for its detected provider. The previous
            // hardcoded ANTHROPIC_API_KEY shipped OpenAI/Google keys to
            // Anthropic's auth endpoint during OpenCode startup validation,
            // disclosing them to the wrong vendor (and silently failing auth).
            // resolveApiKeyEnv() prefers an explicit `provider`, falls back to
            // prefix-sniffing, and only multi-injects (with a deprecation warn)
            // when both fail. Mirrors goose.ts:503-508.
            ...resolveApiKeyEnv(
              this.options.apiKey,
              ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY'],
              this.options.provider,
              'OpenCodeBackend',
            ),
          }),
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        if (!this.process.stdout || !this.process.stderr) {
          throw new Error('Failed to create stdio pipes');
        }

        // Handle stdout - JSON messages
        this.process.stdout.on('data', (data: Buffer) => {
          this.processStdout(data);
        });

        // Handle stderr - warnings and errors
        this.process.stderr.on('data', (data: Buffer) => {
          const text = data.toString();
          logger.debug(`[OpenCodeBackend] stderr: ${text.trim()}`);

          // Check for common error patterns
          if (
            text.includes('Error') ||
            text.includes('error') ||
            text.includes('Exception')
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
          logger.debug(`[OpenCodeBackend] Process exited with code: ${code}`);

          // Process any remaining buffered output
          if (this.lineBuffer.trim()) {
            const msg = parseOpenCodeJson(this.lineBuffer);
            if (msg) {
              this.handleJsonMessage(msg);
            }
            this.lineBuffer = '';
          }

          // Recover any step-finish costs opencode persisted to storage but
          // never flushed to stdout (#26855). Best-effort + deduped against the
          // stdout-seen steps, so it is a no-op when the stream was complete.
          this.reconcileCostFromStorage();

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
              detail: `OpenCode exited with code ${code}`,
            });
            reject(new Error(`OpenCode exited with code ${code}`));
          }

          this.process = null;
        });

        // Handle process errors
        // WHY (Phase 0.3 / SOC2 CC7.2): Surface friendly install hint on
        // ENOENT instead of raw "spawn ... ENOENT" Node error.
        this.process.on('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'ENOENT') {
            const message = formatInstallHint('opencode');
            logger.warn(`[OpenCodeBackend] ${message}`);
            this.emit({ type: 'status', status: 'error', detail: message });
            reject(new Error(message));
            return;
          }
          logger.error(`[OpenCodeBackend] Process error:`, err);
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
   * Cancel the current OpenCode operation.
   *
   * Kills the OpenCode process if one is running.
   *
   * @param sessionId - The session to cancel
   */
  async cancel(sessionId: SessionId): Promise<void> {
    if (sessionId !== this.sessionId) {
      throw new Error(`Invalid session ID: ${sessionId}`);
    }

    if (this.process) {
      logger.debug('[OpenCodeBackend] Cancelling OpenCode process');
      // Mark cancelled BEFORE SIGTERM so the close handler treats the resulting
      // non-zero exit as an intentional cancel, not a crash (audit 2026-06-09 fix #6).
      this.markCancelled();
      this.process.kill('SIGTERM');
      // WHY: Track escalation timer via the base class so it is cleared on
      // clean exit / dispose / double-cancel. SOC2 CC7.2.
      this.scheduleForceKill();
    }

    this.emit({ type: 'status', status: 'idle' });
  }

  // respondToPermission, waitForResponseComplete, and dispose are inherited
  // from StreamingAgentBackendBase. OpenCode uses --non-interactive so the
  // base default (emit-only) is exactly right for permission handling.
}

/**
 * Create an OpenCode backend.
 *
 * OpenCode is a terminal-based AI coding assistant with full JSON output support.
 * This adapter spawns OpenCode as a subprocess and parses its structured output.
 *
 * @param options - Configuration options
 * @returns OpenCodeBackendResult with backend and resolved model
 *
 * @example
 * ```ts
 * const { backend } = createOpenCodeBackend({
 *   cwd: '/path/to/project',
 *   model: 'claude-sonnet-4-20250514',
 * });
 *
 * const { sessionId } = await backend.startSession();
 * await backend.sendPrompt(sessionId, 'Fix the bug in main.ts');
 * ```
 */
export function createOpenCodeBackend(
  options: OpenCodeBackendOptions
): OpenCodeBackendResult {
  logger.debug('[OpenCode] Creating backend with options:', {
    cwd: options.cwd,
    model: options.model,
    hasApiKey: !!options.apiKey,
    useHttpApi: options.useHttpApi,
    resumeSessionId: options.resumeSessionId,
  });

  return {
    backend: new OpenCodeBackend(options),
    model: options.model,
    metadata: {
      modelSource: options.model ? 'explicit' : 'default',
      supportsStreaming: true,
      supportsTools: true,
    },
  };
}

/**
 * Register OpenCode backend with the global agent registry.
 *
 * This function should be called during application initialization
 * to make the OpenCode agent available for use.
 */
export function registerOpenCodeAgent(): void {
  agentRegistry.register('opencode', (opts) => createOpenCodeBackend(opts).backend);
  logger.debug('[OpenCode] Registered with agent registry');
}
