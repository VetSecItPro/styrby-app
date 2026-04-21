/**
 * Aider Backend - Aider CLI agent adapter
 *
 * This module provides a factory function for creating an Aider backend.
 * Aider is a command-line AI pair programming tool that works with various
 * LLM providers.
 *
 * Key characteristics:
 * - No native JSON output - must parse stdout
 * - Each run is ephemeral (no persistent sessions)
 * - Run with: `aider --message <msg> --no-stream --yes`
 * - Token estimation via simple heuristic (words * 1.3) — Phase 1.1 will
 *   migrate this to anthropic/openai-tokenizer for honest cost reporting.
 * - Streaming: line-based via `streamLines()` (Phase 0.3) — bounded memory,
 *   no UI freeze on long runs.
 *
 * @module factories/aider
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { estimateTokensSync } from 'styrby-shared';
import type {
  AgentBackend,
  SessionId,
  StartSessionResult,
  AgentFactoryOptions,
} from '../core';
import { agentRegistry } from '../core';
import { logger } from '@/ui/logger';
import { buildSafeEnv, validateExtraArgs } from '@/utils/safeEnv';
import { StreamingAgentBackendBase, formatInstallHint } from '../StreamingAgentBackendBase';
import type { CostReport } from '@styrby/shared/cost';

/**
 * Options for creating an Aider backend
 */
export interface AiderBackendOptions extends AgentFactoryOptions {
  /**
   * API key for the LLM provider (e.g., OpenAI, Anthropic).
   * Aider auto-detects from environment: OPENAI_API_KEY, ANTHROPIC_API_KEY, etc.
   */
  apiKey?: string;

  /**
   * Model to use (e.g., 'gpt-4', 'claude-3-opus-20240229').
   * Defaults to Aider's default model.
   */
  model?: string;

  /**
   * Additional Aider CLI arguments.
   * See: https://aider.chat/docs/config/options.html
   */
  extraArgs?: string[];

  /**
   * Files to add to the chat context.
   * These files will be available for Aider to read and edit.
   */
  files?: string[];
}

/**
 * Result of creating an Aider backend.
 *
 * Extends the shared `AgentFactoryResult` contract: existing callers that
 * destructure only `{ backend, model }` continue to work; new callers may
 * read the optional `metadata` field.
 */
export interface AiderBackendResult {
  /** The created AgentBackend instance */
  backend: AgentBackend;
  /** The resolved model that will be used */
  model: string | undefined;
  /** Optional capability/source metadata (additive, backward-compatible). */
  metadata?: import('../core').AgentFactoryMetadata;
}

/**
 * Estimate token count from text.
 *
 * Phase 1.1: Routes through the shared `estimateTokensSync()` so the rest
 * of the system has one tokenizer dispatch point. This function is the
 * synchronous hot-path estimator (per-line streaming) — the cost calculator
 * reconciles to exact anthropic/openai counts via async `countTokens()` on
 * session close, so any drift in this estimate is corrected before the
 * record lands in the cost dashboard (SOC2 CC4.1 honest monitoring).
 *
 * @param text - The text to estimate tokens for
 * @returns Estimated token count
 */
function estimateTokens(text: string): number {
  return estimateTokensSync(text);
}

/**
 * Parse Aider output to detect file edits.
 *
 * Aider outputs file changes in a diff-like format. This function attempts
 * to extract structured information from that output.
 *
 * @param line - A line of Aider output
 * @returns Parsed edit info or null if not a file edit
 */
function parseFileEdit(line: string): { path: string; action: string } | null {
  // Aider shows file edits with patterns like:
  // "Wrote path/to/file.ts"
  // "Updated path/to/file.ts"
  // "Created path/to/file.ts"
  const writeMatch = line.match(/^(Wrote|Updated|Created)\s+(.+)$/);
  if (writeMatch) {
    return { action: writeMatch[1].toLowerCase(), path: writeMatch[2] };
  }
  return null;
}

/**
 * Aider Backend implementation.
 *
 * Spawns Aider as a subprocess and parses its stdout output.
 * Each prompt creates a new Aider process (ephemeral sessions).
 */
/**
 * Regex that matches Aider's `--show-tokens` summary line emitted at session close.
 *
 * Example line:
 *   > Tokens: 1,234 sent, 567 received, cost: $0.012
 *
 * WHY: Aider uses --show-tokens to print one summary line after the main response.
 * We capture the last 20 lines of stdout and scan for this pattern. The regex
 * tolerates comma-formatted numbers and slight phrasing variations Aider has
 * shipped across minor releases.
 *
 * Named capture groups:
 *   - sent    — input tokens (may contain commas)
 *   - received — output tokens (may contain commas)
 *   - cost    — USD cost string (digits + optional decimal point)
 */
const AIDER_TOKEN_SUMMARY_RE =
  /tokens?:\s*(?<sent>[\d,]+)\s*sent[,\s]+(?<received>[\d,]+)\s*received(?:.*?cost:\s*\$(?<cost>[\d.]+))?/i;

/**
 * Parse Aider's `--show-tokens` summary line.
 *
 * @param lines - The last N lines of stdout captured from the Aider process.
 * @returns Parsed token counts and cost, or null if no summary line matched.
 */
export function parseAiderTokenSummary(
  lines: string[]
): { inputTokens: number; outputTokens: number; costUsd: number; summaryLine: string } | null {
  // Scan from newest to oldest — the summary is the last matching line.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const match = AIDER_TOKEN_SUMMARY_RE.exec(line);
    if (match?.groups) {
      const inputTokens = parseInt((match.groups['sent'] ?? '0').replace(/,/g, ''), 10);
      const outputTokens = parseInt((match.groups['received'] ?? '0').replace(/,/g, ''), 10);
      const costUsd = match.groups['cost'] ? parseFloat(match.groups['cost']) : 0;
      return { inputTokens, outputTokens, costUsd, summaryLine: line.trim() };
    }
  }
  return null;
}

class AiderBackend extends StreamingAgentBackendBase {
  protected readonly logTag = 'AiderBackend';
  private inputTokens = 0;
  private outputTokens = 0;
  /**
   * Running tally of output token estimate for the in-flight Aider run.
   *
   * WHY (Phase 0.3): Replaces the prior `outputBuffer += text` pattern that
   * accumulated the entire transcript in memory. We now estimate tokens
   * per-line as it streams in, then emit the cumulative count on close.
   * Bounds memory at ~one line instead of the whole transcript and removes
   * the 5-10s mobile UI freeze on long Aider runs (SOC2 CC7.2).
   */
  private streamingOutputTokens = 0;

  /**
   * Circular buffer holding the last 20 stdout lines for `--show-tokens` parsing.
   *
   * WHY: We only need the tail of stdout to find the token summary line.
   * Keeping a small fixed-size ring prevents unbounded memory growth on
   * long Aider sessions (SOC2 CC7.2).
   */
  private readonly stdoutTail: string[] = [];
  private static readonly TAIL_SIZE = 20;

  constructor(private options: AiderBackendOptions) {
    super();
  }

  /**
   * Start a new Aider session.
   *
   * Since Aider is ephemeral, this just initializes the session state.
   * The actual Aider process is spawned when sendPrompt is called.
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
    this.emit({ type: 'status', status: 'starting' });

    logger.debug(`[AiderBackend] Starting session: ${this.sessionId}`);

    // If initial prompt provided, send it
    if (initialPrompt) {
      // Emit running status then send prompt
      this.emit({ type: 'status', status: 'running' });
      await this.sendPrompt(this.sessionId, initialPrompt);
    } else {
      // No initial prompt, go straight to idle
      this.emit({ type: 'status', status: 'idle' });
    }

    return { sessionId: this.sessionId };
  }

  /**
   * Send a prompt to Aider.
   *
   * Spawns a new Aider process with the given prompt.
   * Uses --message flag for non-interactive mode.
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

    // Update input token estimate
    this.inputTokens += estimateTokens(prompt);
    this.streamingOutputTokens = 0;

    this.emit({ type: 'status', status: 'running' });

    // Reset the per-prompt stdout tail buffer.
    this.stdoutTail.length = 0;

    // Build Aider command arguments
    const args: string[] = [
      '--message',
      prompt,
      '--no-stream',    // Disable streaming for easier parsing
      '--show-tokens',  // WHY: Instructs Aider to print a token/cost summary line at
                        // session close ("Tokens: N sent, N received, cost: $X").
                        // We parse this in the 'close' handler to emit an accurate
                        // CostReport (source='agent-reported') rather than a heuristic.
      '--yes',          // Auto-confirm all prompts
    ];

    // Add model if specified
    if (this.options.model) {
      args.push('--model', this.options.model);
    }

    // Add extra args (validated for shell safety — SEC-ARGS-001)
    if (this.options.extraArgs) {
      args.push(...validateExtraArgs(this.options.extraArgs));
    }

    // Add files to context (validated: must not contain path traversal)
    if (this.options.files && this.options.files.length > 0) {
      for (const file of this.options.files) {
        // SECURITY: Block path traversal attempts and absolute paths outside cwd
        if (file.includes('..') || (file.startsWith('/') && this.options.cwd && !file.startsWith(this.options.cwd))) {
          throw new Error(`Unsafe file path: "${file}". Path traversal is not allowed.`);
        }
      }
      args.push(...this.options.files);
    }

    logger.debug(`[AiderBackend] Spawning aider with args:`, args);

    return new Promise<void>((resolve, reject) => {
      try {
        // SECURITY: Use buildSafeEnv() to prevent leaking secrets to Aider subprocess.
        this.process = spawn('aider', args, {
          cwd: this.options.cwd,
          env: buildSafeEnv({
            ...this.options.env,
            // Pass API key if provided
            ...(this.options.apiKey ? { OPENAI_API_KEY: this.options.apiKey } : {}),
          }),
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        if (!this.process.stdout || !this.process.stderr) {
          throw new Error('Failed to create stdio pipes');
        }

        // WHY (Phase 0.3 / SOC2 CC7.2): Stream stdout line-by-line via
        // readline instead of the prior `outputBuffer += text` accumulator.
        // The old pattern held the entire transcript in memory and serialised
        // it in a single emit on process close, freezing the mobile UI for
        // 5-10s on long runs. streamLines() yields per-line so the WS relay
        // can flush deltas as they arrive and memory stays O(line length).
        this.streamLines(this.process.stdout, (line) => {
          // WHY: Preserve pre-Phase-0.3 behavior of skipping whitespace-only
          // lines so model-output is not emitted for blank progress padding.
          if (!line.trim()) return;

          // Maintain a fixed-size tail buffer for the --show-tokens summary line.
          this.stdoutTail.push(line);
          if (this.stdoutTail.length > AiderBackend.TAIL_SIZE) {
            this.stdoutTail.shift();
          }

          this.streamingOutputTokens += estimateTokens(line);
          // Re-append the newline for downstream consumers that expect it.
          this.emit({ type: 'model-output', textDelta: `${line}\n` });
          const edit = parseFileEdit(line.trim());
          if (edit) {
            this.emit({
              type: 'fs-edit',
              description: `${edit.action} ${edit.path}`,
              path: edit.path,
            });
          }
        });

        // Handle stderr - warnings and errors (also line-based to stay consistent).
        this.streamLines(this.process.stderr, (line) => {
          if (!line) return;
          logger.debug(`[AiderBackend] stderr: ${line}`);
          if (
            line.includes('Error') ||
            line.includes('error') ||
            line.includes('Exception')
          ) {
            this.emit({
              type: 'status',
              status: 'error',
              detail: line,
            });
          }
        });

        // Handle process exit
        this.process.on('close', (code) => {
          logger.debug(`[AiderBackend] Process exited with code: ${code}`);
          // Cancel any in-flight SIGKILL escalation timer (clean exit).
          this.clearCancelTimer();

          // Use streamed token estimate (constant memory) instead of the
          // removed outputBuffer accumulator.
          this.outputTokens += this.streamingOutputTokens;

          // WHY: Attempt to parse the --show-tokens summary line from the captured
          // stdout tail. When found, we emit source='agent-reported' with exact
          // token counts and costUsd from Aider. When missing (e.g. parse failure,
          // Aider version without --show-tokens), we fall back to the heuristic
          // estimate so downstream consumers always receive a CostReport.
          const parsed = parseAiderTokenSummary(this.stdoutTail);
          const costReport: CostReport = parsed
            ? {
                sessionId: this.sessionId ?? '',
                messageId: null,
                agentType: 'aider',
                model: this.options.model ?? 'unknown',
                timestamp: new Date().toISOString(),
                source: 'agent-reported',
                billingModel: 'api-key',
                costUsd: parsed.costUsd,
                inputTokens: parsed.inputTokens,
                outputTokens: parsed.outputTokens,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                rawAgentPayload: { summaryLine: parsed.summaryLine },
              }
            : {
                sessionId: this.sessionId ?? '',
                messageId: null,
                agentType: 'aider',
                model: this.options.model ?? 'unknown',
                timestamp: new Date().toISOString(),
                source: 'styrby-estimate',
                billingModel: 'api-key',
                costUsd: 0,
                inputTokens: this.inputTokens,
                outputTokens: this.outputTokens,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                rawAgentPayload: null,
              };

          // Emit legacy token-count (keep for existing consumers).
          this.emit({
            type: 'token-count',
            inputTokens: costReport.inputTokens,
            outputTokens: costReport.outputTokens,
            estimatedCostUsd: costReport.costUsd,
          });

          // Emit unified CostReport for the cost-reporter to persist.
          this.emit({ type: 'cost-report', report: costReport } as any);

          if (code === 0) {
            this.emit({ type: 'status', status: 'idle' });
            resolve();
          } else {
            this.emit({
              type: 'status',
              status: 'error',
              detail: `Aider exited with code ${code}`,
            });
            reject(new Error(`Aider exited with code ${code}`));
          }

          this.process = null;
        });

        // Handle process errors. WHY (Phase 0.3): Surface a friendly install
        // hint on ENOENT so mobile users see "Aider is not installed. Install
        // via: pip install aider-chat" instead of "spawn aider ENOENT".
        this.attachInstallHintErrorHandler(this.process, 'aider', reject);
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
   * Cancel the current Aider operation.
   *
   * Kills the Aider process if one is running.
   *
   * @param sessionId - The session to cancel
   */
  async cancel(sessionId: SessionId): Promise<void> {
    if (sessionId !== this.sessionId) {
      throw new Error(`Invalid session ID: ${sessionId}`);
    }

    if (this.process) {
      logger.debug('[AiderBackend] Cancelling Aider process');
      this.process.kill('SIGTERM');

      // WHY: Track the escalation timer via base class so it is cleared on
      // clean process exit, double-cancel, or dispose. Prevents the 3-second
      // SIGKILL timer from keeping the event loop alive after the process
      // already exited. (SOC2 CC7.2 reliability.)
      this.scheduleForceKill();
    }

    this.emit({ type: 'status', status: 'idle' });
  }

  // respondToPermission, waitForResponseComplete, and dispose are inherited
  // from StreamingAgentBackendBase. The base class dispose() clears listeners,
  // clears the cancel timer, and kills the process (SOC2 CC7.2).
}

/**
 * Create an Aider backend.
 *
 * Aider is a command-line AI pair programming tool. This adapter spawns
 * Aider as a subprocess and parses its output.
 *
 * @param options - Configuration options
 * @returns AiderBackendResult with backend and resolved model
 *
 * @example
 * ```ts
 * const { backend } = createAiderBackend({
 *   cwd: '/path/to/project',
 *   model: 'gpt-4',
 *   files: ['src/main.ts', 'src/utils.ts'],
 * });
 *
 * await backend.startSession('Fix the bug in main.ts');
 * ```
 */
export function createAiderBackend(options: AiderBackendOptions): AiderBackendResult {
  logger.debug('[Aider] Creating backend with options:', {
    cwd: options.cwd,
    model: options.model,
    hasApiKey: !!options.apiKey,
    fileCount: options.files?.length ?? 0,
  });

  return {
    backend: new AiderBackend(options),
    model: options.model,
    metadata: {
      modelSource: options.model ? 'explicit' : 'default',
      supportsStreaming: true,
      supportsTools: true,
    },
  };
}

/**
 * Register Aider backend with the global agent registry.
 *
 * This function should be called during application initialization
 * to make the Aider agent available for use.
 */
export function registerAiderAgent(): void {
  agentRegistry.register('aider', (opts) => createAiderBackend(opts).backend);
  logger.debug('[Aider] Registered with agent registry');
}
