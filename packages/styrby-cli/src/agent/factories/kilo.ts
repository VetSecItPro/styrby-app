/**
 * Kilo Backend - Kilo CLI agent adapter (OpenCode fork, 500+ models)
 *
 * This module provides a factory function for creating a Kilo backend.
 * Kilo is a fork of OpenCode (https://github.com/Kilo-Org/kilocode) with the
 * same headless CLI surface: `kilo run <message> --format json` emits
 * newline-delimited JSON events.
 *
 * Key characteristics (VERIFIED against the real `kilo` binary, v7.3.41,
 * 2026-06-11 via `kilo --help` / `kilo run --help`):
 * - Binary name: `kilo`
 * - Headless: `kilo run <message..>` — POSITIONAL message (no `--prompt` flag)
 * - `--format` accepts `default | json` (json = raw JSON events)
 * - `-m/--model` (provider/model format), `-s/--session <id>`, `-c/--continue`,
 *   `--fork`, `--auto` (auto-approve permissions for pipeline use)
 * - There is NO `--output`, NO `--no-interactive`, NO `--memory-bank`,
 *   NO `--api-base`, NO `--resume`. Those were invented by the prior adapter.
 *
 * WHY the rewrite (2026-06-11): the previous adapter spawned
 * `kilo run --prompt <p> --output json --no-interactive --memory-bank` and
 * parsed a fabricated `tokens` / `memory_bank_read` / `memory_bank_write`
 * JSON protocol. None of those flags or event types exist in the real binary,
 * so the adapter would have failed to launch headless and emitted nothing.
 * Kilo is an OpenCode fork, so the real event schema mirrors OpenCode's
 * verified `{ type, sessionID, part }` shape (see opencode.ts).
 *
 * @see https://github.com/Kilo-Org/kilocode
 * @module factories/kilo
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
import { resolveApiKeyEnv, type ApiKeyProvider } from '@/utils/apiKeyProvider';
import { StreamingAgentBackendBase, formatInstallHint } from '../StreamingAgentBackendBase';
import type { CostReport } from '@styrby/shared/cost';

// ============================================================================
// Types
// ============================================================================

/**
 * Options for creating a Kilo backend.
 */
export interface KiloBackendOptions extends AgentFactoryOptions {
  /**
   * API key for the LLM provider.
   * Kilo supports many providers; the key is injected under the env-var
   * name(s) for its detected/declared provider (see `provider`).
   */
  apiKey?: string;

  /**
   * Model identifier in Kilo's `provider/model` format (e.g. 'anthropic/claude-sonnet-4',
   * 'openai/gpt-4o', 'ollama/llama3'). Passed via `-m/--model`.
   * Defaults to Kilo's configured default.
   */
  model?: string;

  /**
   * Session ID to resume. Passed via `-s/--session <id>`.
   * VERIFIED real flag (`kilo run --help`).
   */
  resumeSessionId?: string;

  /**
   * Additional Kilo CLI arguments.
   */
  extraArgs?: string[];

  /**
   * Explicit LLM provider for the BYOK key.
   *
   * WHY (audit 2026-05-05 HIGH fix): Kilo supports many backends. Without an
   * explicit provider hint, the previous code injected the user's key into
   * OPENAI_API_KEY + ANTHROPIC_API_KEY + KILO_API_KEY simultaneously — which
   * leaked sk-ant-* keys to Anthropic-compatible providers' validation calls.
   *
   * If unset, the factory sniffs the key prefix and falls back to legacy
   * fan-out only when sniffing fails (with a deprecation warning).
   */
  provider?: ApiKeyProvider;
}

/**
 * Result of creating a Kilo backend.
 */
export interface KiloBackendResult {
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
 * Kilo `--format json` event shape.
 *
 * Kilo is an OpenCode fork, so its event envelope is `{ type, sessionID, part }`
 * — the same structure as OpenCode's VERIFIED schema (opencode.ts). The
 * top-level envelope (`type`, top-level `sessionID`, nested event payload) was
 * CONFIRMED directly against the real `kilo` binary (v7.3.41, 2026-06-11): an
 * unauthenticated `kilo run "say OK" --format json --auto` emitted
 * `{"type":"error","timestamp":...,"sessionID":"ses_...","error":{"name":...,"data":{...}}}`.
 *
 * SCHEMA UNVERIFIED — needs keyed session (#30): the success-path `text` and
 * `step_finish` `part` payloads (part.text / part.cost / part.tokens) could NOT
 * be captured because the local install has no provider credentials (the model
 * returns 401 PAID_MODEL_AUTH_REQUIRED). The `text`/`step_finish` handling below
 * mirrors OpenCode's verified shape on the well-founded assumption that the fork
 * preserves it; it must be re-verified against a real keyed Kilo session.
 */
interface KiloTokens {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
}
interface KiloPart {
  /** Part discriminator: 'step-start' | 'text' | 'step-finish' | tool parts. */
  type?: string;
  /** Assistant text (present on `text` events — UNVERIFIED for Kilo, see #30). */
  text?: string;
  /** Step cost in USD (present on `step-finish` — UNVERIFIED for Kilo, see #30). */
  cost?: number;
  /** Token usage for the step (present on `step-finish` — UNVERIFIED, see #30). */
  tokens?: KiloTokens;
  /** Stop reason (present on `step-finish`). */
  reason?: string;
}
/**
 * Error payload (VERIFIED against the real binary, 2026-06-11): error events
 * carry a nested `error: { name, data: { message, ... } }` object — NOT a flat
 * `error` string. The prior adapter assumed a flat string and would have shown
 * `undefined` as the error detail.
 */
interface KiloErrorPayload {
  name?: string;
  data?: { message?: string };
}
interface KiloJsonMessage {
  /** Event type: 'text' | 'step_finish' | 'step_start' | 'error' | …. */
  type: string;
  /** Session id, present on every event (used for `--session` resume). VERIFIED. */
  sessionID?: string;
  part?: KiloPart;
  /** Present on `error` events. VERIFIED nested shape. */
  error?: KiloErrorPayload;
}

/**
 * Parse a single JSON line from Kilo's `--format json` output.
 *
 * @param line - A single line of Kilo stdout (expected to be JSON)
 * @returns Parsed KiloJsonMessage or null if the line is not valid JSON
 */
function parseKiloJson(line: string): KiloJsonMessage | null {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith('{')) {
    return null;
  }

  try {
    return JSON.parse(trimmed) as KiloJsonMessage;
  } catch {
    return null;
  }
}

// ============================================================================
// KiloBackend Class
// ============================================================================

/**
 * Kilo Backend implementation.
 *
 * Spawns Kilo as a subprocess with `--format json` and parses the
 * newline-delimited `{ type, sessionID, part }` events emitted by the
 * OpenCode-fork CLI.
 */
class KiloBackend extends StreamingAgentBackendBase {
  protected readonly logTag = 'KiloBackend';
  private kiloSessionId: string | null = null;
  private inputTokens = 0;
  private outputTokens = 0;
  private totalCost = 0;
  private lineBuffer = '';

  constructor(private options: KiloBackendOptions) {
    super();
  }

  /**
   * Handle a parsed Kilo JSON message and emit the corresponding AgentMessages.
   *
   * @param msg - The parsed Kilo JSON message
   */
  private handleJsonMessage(msg: KiloJsonMessage): void {
    // sessionID rides on EVERY event (VERIFIED); capture it so follow-up
    // prompts resume the same Kilo session via `--session`.
    if (msg.sessionID) this.kiloSessionId = msg.sessionID;

    switch (msg.type) {
      case 'text': {
        // SCHEMA UNVERIFIED — needs keyed session (#30): assistant output is
        // assumed to ride in `part.text` as a complete part (OpenCode-fork
        // shape). Re-verify against a real keyed Kilo session.
        const text = msg.part?.text;
        if (text) this.emit({ type: 'model-output', fullText: text });
        break;
      }

      case 'step_finish': {
        // SCHEMA UNVERIFIED — needs keyed session (#30): usage is assumed to
        // ride on `part.cost` (USD) + `part.tokens.{input,output,cache.{read,write}}`
        // (OpenCode-fork shape). Kilo is BYOK so billingModel is 'api-key'.
        const part = msg.part;
        if (!part) break;
        const t = part.tokens ?? {};
        // WHY emit PER-STEP values (NOT a running total) — multi-step billing
        // correctness (mirrors opencode.ts; verified 2026-06-11 via the real
        // cost_records contract): each step_finish is one API call, we emit one
        // cost-report per event, the cost-reporter writes one summed cost_records
        // row per event, so summing per-step rows = the true turn total.
        // Accumulating into a running total here would make each row cumulative
        // and the downstream SUM would over-count. (Corrects the prior "take
        // latest" comment.) RESIDUAL RISK (kilo only): issue #26855 — the final
        // step_finish may not reach stdout. opencode.ts now reconciles against
        // session storage on close to recover it (opencodeStorage.ts); kilo can
        // adopt the same once its storage dir is confirmed (COST-OPENCODE-26855).
        //
        // WHY toNonNegativeNumber (#24): untrusted stdout; coerce per-step
        // (default 0 if absent) — never carry a prior step's value forward, which
        // would re-count it when rows are summed.
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

        // Unified CostReport — source='agent-reported' (Kilo reports real USD).
        const costReport: CostReport = {
          sessionId: this.sessionId ?? '',
          messageId: null,
          agentType: 'kilo',
          model: this.options.model ?? 'unknown',
          timestamp: new Date().toISOString(),
          source: 'agent-reported',
          billingModel: 'api-key',
          costUsd: stepCost,
          inputTokens: stepInput,
          outputTokens: stepOutput,
          cacheReadTokens: cacheRead,
          cacheWriteTokens: cacheWrite,
          rawAgentPayload: msg as unknown as Record<string, unknown>,
        };
        this.emit({ type: 'cost-report', report: costReport });
        break;
      }

      case 'step_start':
        // Turn boundary — no payload to surface.
        break;

      case 'error': {
        // VERIFIED shape: error events carry a nested `error.data.message`
        // (falling back to error.name). Captured directly from the real binary.
        const detail =
          msg.error?.data?.message ?? msg.error?.name ?? 'Kilo encountered an error';
        this.emit({ type: 'status', status: 'error', detail });
        break;
      }

      default:
        // WHY no tool-call / tool-result / fs-edit mapping: the real Kilo
        // tool-event schema has NOT been captured yet (a keyed, tool-triggering
        // session is required — #30). The prior adapter mapped an INVENTED
        // tool_use/tool_result/memory_bank_* schema Kilo never emits. Rather
        // than re-invent, we surface nothing until the real shape is verified.
        logger.debug('[KiloBackend] Unhandled kilo event type:', msg.type);
    }
  }

  /**
   * Process stdout data, buffering partial lines until a newline is received.
   *
   * @param data - Raw buffer chunk from process stdout
   */
  private processStdout(data: Buffer): void {
    const text = data.toString();
    // SECURITY: Cap line buffer size to prevent memory exhaustion
    this.lineBuffer = safeBufferAppend(this.lineBuffer, text);

    const lines = this.lineBuffer.split('\n');
    this.lineBuffer = lines.pop() ?? '';

    for (const line of lines) {
      const msg = parseKiloJson(line);
      if (msg) {
        this.handleJsonMessage(msg);
      } else if (line.trim()) {
        logger.debug('[KiloBackend] Non-JSON stdout:', line);
      }
    }
  }

  /**
   * Start a new Kilo session.
   *
   * @param initialPrompt - Optional prompt to send immediately after session start
   * @returns Promise resolving to the new session information
   * @throws {Error} When the backend has been disposed
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
    this.kiloSessionId = this.options.resumeSessionId ?? null;

    this.emit({ type: 'status', status: 'starting' });

    logger.debug(`[KiloBackend] Starting session: ${this.sessionId}`);

    if (initialPrompt) {
      this.emit({ type: 'status', status: 'running' });
      await this.sendPrompt(this.sessionId, initialPrompt);
    } else {
      this.emit({ type: 'status', status: 'idle' });
    }

    return { sessionId: this.sessionId };
  }

  /**
   * Send a prompt to Kilo.
   *
   * Spawns `kilo run <prompt> --format json` (verified CLI surface). The
   * prompt is a POSITIONAL argument — there is no `--prompt` flag.
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

    // Build Kilo command arguments.
    //
    // WHY this exact shape (VERIFIED against `kilo run --help`, kilo v7.3.41,
    // 2026-06-11): headless runs use the `run` SUBCOMMAND with a POSITIONAL
    // message (no `--prompt`, no `--output`, no `--no-interactive`, no
    // `--memory-bank` — the prior adapter invented all four). `--format json`
    // emits raw JSON events; `-m/--model` and `-s/--session` are real. `--auto`
    // auto-approves permissions so the non-interactive pipeline never blocks on
    // a permission prompt (replaces the invented stdin y/n protocol).
    const args: string[] = ['run', prompt, '--format', 'json', '--auto'];

    // Model override
    if (this.options.model) {
      args.push('--model', this.options.model);
    }

    // Resume a prior Kilo session for context continuity (real `-s/--session`).
    if (this.kiloSessionId) {
      args.push('--session', this.kiloSessionId);
    }

    // Extra args (validated for shell safety — SEC-ARGS-001)
    if (this.options.extraArgs) {
      args.push(...validateExtraArgs(this.options.extraArgs));
    }

    logger.debug(`[KiloBackend] Spawning kilo with args:`, args);

    return new Promise<void>((resolve, reject) => {
      try {
        // SECURITY: Use buildSafeEnv() instead of spreading process.env to prevent
        // leaking secrets (SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL, etc.) to Kilo.
        this.process = spawn('kilo', args, {
          cwd: this.options.cwd,
          env: buildSafeEnv({
            ...this.options.env,
            // SECURITY (audit 2026-05-05 HIGH fix): see goose.ts for full
            // rationale. Inject only the matching provider env var. KILO_API_KEY
            // is Kilo's own internal name — added to the legacy fallback list
            // only, since real provider sniffing covers all real LLM keys.
            ...resolveApiKeyEnv(
              this.options.apiKey,
              ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'KILO_API_KEY'],
              this.options.provider,
              'KiloBackend',
            ),
          }),
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        if (!this.process.stdout || !this.process.stderr) {
          throw new Error('Failed to create stdio pipes');
        }

        // Handle stdout — Kilo JSON events
        this.process.stdout.on('data', (data: Buffer) => {
          this.processStdout(data);
        });

        // Handle stderr — Kilo diagnostic messages
        this.process.stderr.on('data', (data: Buffer) => {
          const text = data.toString();
          logger.debug(`[KiloBackend] stderr: ${text.trim()}`);

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
          logger.debug(`[KiloBackend] Process exited with code: ${code}`);

          // Flush remaining buffer
          if (this.lineBuffer.trim()) {
            const msg = parseKiloJson(this.lineBuffer);
            if (msg) {
              this.handleJsonMessage(msg);
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
              detail: `Kilo exited with code ${code}`,
            });
            reject(new Error(`Kilo exited with code ${code}`));
          }

          this.process = null;
        });

        // Handle process spawn errors (e.g., kilo binary not in PATH)
        // WHY (Phase 0.3 / SOC2 CC7.2): Surface friendly install hint on
        // ENOENT instead of raw "spawn ... ENOENT" Node error.
        this.process.on('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'ENOENT') {
            const message = formatInstallHint('kilo');
            logger.warn(`[KiloBackend] ${message}`);
            this.emit({ type: 'status', status: 'error', detail: message });
            reject(new Error(message));
            return;
          }
          logger.error(`[KiloBackend] Process error:`, err);
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
   * Cancel the current Kilo operation.
   *
   * @param sessionId - The active session ID to cancel
   * @throws {Error} When session ID does not match the active session
   */
  async cancel(sessionId: SessionId): Promise<void> {
    if (sessionId !== this.sessionId) {
      throw new Error(`Invalid session ID: ${sessionId}`);
    }

    if (this.process) {
      logger.debug('[KiloBackend] Cancelling Kilo process');
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
  // from StreamingAgentBackendBase. Kilo runs headless with `--auto`, so the
  // base default (emit-only) is exactly right for permission handling — there
  // is no interactive y/n stdin protocol to relay (the prior adapter invented one).
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a Kilo backend.
 *
 * Kilo is an OpenCode fork with support for 500+ models. The kilo binary must
 * be installed and available in PATH (install per the Kilo project docs; we
 * invoke `kilo`).
 *
 * @param options - Configuration options for the backend
 * @returns KiloBackendResult with backend instance and resolved model
 *
 * @throws {Error} If kilo binary is not installed (deferred until sendPrompt is called)
 *
 * @example
 * ```ts
 * const { backend } = createKiloBackend({
 *   cwd: '/path/to/project',
 *   model: 'anthropic/claude-sonnet-4',
 * });
 *
 * const { sessionId } = await backend.startSession();
 * await backend.sendPrompt(sessionId, 'Add authentication to the user service');
 * ```
 */
export function createKiloBackend(options: KiloBackendOptions): KiloBackendResult {
  logger.debug('[Kilo] Creating backend with options:', {
    cwd: options.cwd,
    model: options.model,
    hasApiKey: !!options.apiKey,
    resumeSessionId: options.resumeSessionId,
  });

  return {
    backend: new KiloBackend(options),
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
 * Register the Kilo backend with the global agent registry.
 *
 * Call this during application initialization to make Kilo available
 * as an agent type. After calling this, `agentRegistry.create('kilo', opts)`
 * will return a configured KiloBackend instance.
 *
 * @example
 * ```ts
 * // In application startup (initializeAgents):
 * registerKiloAgent();
 * ```
 */
export function registerKiloAgent(): void {
  agentRegistry.register('kilo', (opts) => createKiloBackend(opts).backend);
  logger.debug('[Kilo] Registered with agent registry');
}
