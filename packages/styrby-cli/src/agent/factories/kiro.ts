/**
 * Kiro Backend — Kiro CLI agent adapter (AWS)
 *
 * VERIFIED against the real `kiro-cli` binary (v2.6.1, 2026-06-10).
 *
 * Kiro CLI is the rebranded **Amazon Q Developer CLI** (AWS renamed `q` →
 * `kiro-cli` on 2025-11-17). It is a self-contained native binary (NOT an
 * npm/Node package) installed via `curl -fsSL https://cli.kiro.dev/install | bash`.
 *
 * Key characteristics (all verified against the real binary, replacing the prior
 * fabricated `kiro run --output-format jsonl` + credit-billing fiction):
 * - **Binary name: `kiro-cli`** (NOT `kiro` — the old code's `spawn('kiro')` was
 *   a guaranteed ENOENT). Backward-compatible aliases `q`/`q chat` also exist.
 * - **Headless invocation: `kiro-cli chat --no-interactive "<prompt>"`** — the
 *   prompt is a trailing positional argument; `--no-interactive` prints the first
 *   response to stdout and exits.
 * - **Output: PLAIN TEXT (markdown), with ANSI/terminal control codes.** There is
 *   NO JSON/stream-json for chat responses — `--format json` exists ONLY for
 *   `--list-models`. So we strip ANSI and forward the text as `model-output`.
 * - **Auth: `KIRO_API_KEY` env var** (headless; paid tiers only). Without it the
 *   CLI tries a browser login, which is useless in a relay/headless context.
 * - **No token/credit/cost telemetry in CLI output.** Kiro bills on credits at
 *   the account level (overage ~$0.04/credit, not the previously-invented
 *   $0.01), and the CLI does not print any usage figure. So this backend emits
 *   NO cost-report — kiro sessions have no CLI-derivable cost (see #30).
 * - **Tools: `--trust-all-tools` / `--trust-tools=<names>`** auto-approve tool
 *   use (no structured permission events are emitted, so the mobile per-tool
 *   approval flow cannot gate kiro the way it gates claude/codex).
 *
 * @see https://kiro.dev/docs/cli/headless/
 * @module factories/kiro
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

// ============================================================================
// Helpers
// ============================================================================

/**
 * Strip ANSI/terminal control sequences from kiro-cli output.
 *
 * WHY: kiro-cli writes its chat response as styled markdown — it emits CSI color
 * codes, cursor show/hide (`ESC[?25l`), and spinner frames. None of that is part
 * of the model's actual text, so we remove it before forwarding `model-output`.
 * Matches CSI (`ESC[ … final`) and a couple of common single-char escapes.
 *
 * @param text - Raw stdout chunk from kiro-cli.
 * @returns The text with ANSI control sequences removed.
 */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, '').replace(/\u001b[=>]/g, '');
}

// ============================================================================
// Types
// ============================================================================

/**
 * Options for creating a Kiro backend.
 */
export interface KiroBackendOptions extends AgentFactoryOptions {
  /**
   * Kiro API key (`KIRO_API_KEY`). REQUIRED for headless use — without it the
   * CLI falls back to interactive browser login, which cannot complete in a
   * relay/daemon context. Generated from Kiro account settings (paid tiers only).
   * When omitted, an inherited `KIRO_API_KEY` from {@link AgentFactoryOptions.env}
   * (or the ambient environment) is used.
   */
  apiKey?: string;

  /**
   * Model to use (`--model`). Passed verbatim. Defaults to kiro-cli's configured
   * default model.
   */
  model?: string;

  /**
   * Reasoning effort (`--effort`): 'low' | 'medium' | 'high' | 'xhigh' | 'max'.
   * Optional; kiro-cli picks a per-model default when omitted.
   */
  effort?: string;

  /**
   * Trust posture for tool use in headless mode. Since kiro emits no structured
   * permission events we can intercept, a headless run that should DO work
   * (edit files, run commands) must pre-authorize tools:
   *  - `true` (default): `--trust-all-tools` — auto-approve everything.
   *  - a comma list (e.g. 'fs_read,fs_write'): `--trust-tools=<list>` — restrict.
   *  - `false`: pass `--trust-tools=` (trust nothing; read-only-ish).
   * WHY default true: parity with the other headless plain-text agents
   * (aider `--yes`, crush) so kiro can actually complete coding tasks unattended.
   */
  trustTools?: boolean | string;

  /** Additional kiro-cli arguments (validated for shell-safety). */
  extraArgs?: string[];
}

/**
 * Result of creating a Kiro backend.
 */
export interface KiroBackendResult {
  /** The created AgentBackend instance */
  backend: AgentBackend;
  /** The resolved model that will be used */
  model: string | undefined;
  /** Optional capability / source metadata (additive, backward-compatible). */
  metadata?: AgentFactoryMetadata;
}

// ============================================================================
// KiroBackend Class
// ============================================================================

/**
 * Kiro Backend implementation.
 *
 * Spawns `kiro-cli chat --no-interactive <prompt>` as a one-shot subprocess and
 * forwards its ANSI-stripped plain-text stdout to the mobile app as
 * `model-output`. kiro-cli has no machine-readable output mode, so this backend
 * does NOT emit usage/cost/tool/fs-edit events (see the module header + #30).
 */
class KiroBackend extends StreamingAgentBackendBase {
  protected readonly logTag = 'KiroBackend';

  // SECURITY: bounded buffer guards against a runaway process flooding stdout.
  // We emit incrementally (per chunk) so output streams; the buffer only caps growth.
  private outputBuffer = '';

  constructor(private options: KiroBackendOptions) {
    super();
  }

  /**
   * Forward a stdout chunk as `model-output` (ANSI-stripped plain text).
   *
   * @param data - Raw buffer chunk from kiro-cli stdout.
   */
  private processStdout(data: Buffer): void {
    const raw = data.toString();
    this.outputBuffer = safeBufferAppend(this.outputBuffer, raw);
    const text = stripAnsi(raw);
    if (text.trim()) {
      // WHY plain passthrough: kiro-cli has no structured event schema, so the
      // text IS the model output. No per-event usage/tool/cost data is recoverable.
      this.emit({ type: 'model-output', textDelta: text });
    }
  }

  /**
   * Start a new Kiro session.
   *
   * @param initialPrompt - Optional prompt to send immediately.
   * @returns The new session info.
   * @throws {Error} When the backend has been disposed.
   */
  async startSession(initialPrompt?: string): Promise<StartSessionResult> {
    if (this.disposed) {
      throw new Error('Backend has been disposed');
    }

    this.sessionId = randomUUID();
    this.outputBuffer = '';

    this.emit({ type: 'status', status: 'starting' });
    logger.debug(`[KiroBackend] Starting session: ${this.sessionId}`);

    if (initialPrompt) {
      this.emit({ type: 'status', status: 'running' });
      await this.sendPrompt(this.sessionId, initialPrompt);
    } else {
      this.emit({ type: 'status', status: 'idle' });
    }

    return { sessionId: this.sessionId };
  }

  /**
   * Send a prompt to kiro-cli.
   *
   * Spawns `kiro-cli chat --no-interactive [flags] <prompt>`. The prompt is the
   * trailing positional argument; kiro-cli writes its (plain-text) reply to
   * stdout, which we forward as `model-output`.
   *
   * @param sessionId - The active session ID (must match startSession result).
   * @param prompt - The user's prompt text.
   * @throws {Error} When disposed, session ID is invalid, or process spawn fails.
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
    this.outputBuffer = '';
    this.emit({ type: 'status', status: 'running' });

    // `kiro-cli chat --no-interactive [flags] <prompt>` (verified). Prompt is the
    // trailing positional argument.
    const args: string[] = ['chat', '--no-interactive'];

    // Tool trust posture (no human approval is possible in headless mode).
    const trust = this.options.trustTools ?? true;
    if (trust === true) {
      args.push('--trust-all-tools');
    } else if (typeof trust === 'string') {
      args.push(`--trust-tools=${trust}`);
    } else {
      args.push('--trust-tools=');
    }

    if (this.options.model) {
      args.push('--model', this.options.model);
    }
    if (this.options.effort) {
      args.push('--effort', this.options.effort);
    }
    if (this.options.extraArgs) {
      args.push(...validateExtraArgs(this.options.extraArgs));
    }

    // Trailing positional prompt (single argv element — no shell, no escaping).
    args.push(prompt);

    logger.debug(`[KiroBackend] Spawning kiro-cli with args:`, args);

    return new Promise<void>((resolve, reject) => {
      try {
        // SECURITY: buildSafeEnv() blocks ambient secrets. kiro auth is its own
        // single var (KIRO_API_KEY) — inject only that (no multi-vendor fan-out).
        this.process = spawn('kiro-cli', args, {
          cwd: this.options.cwd,
          env: buildSafeEnv({
            ...this.options.env,
            ...(this.options.apiKey ? { KIRO_API_KEY: this.options.apiKey } : {}),
          }),
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        if (!this.process.stdout || !this.process.stderr) {
          throw new Error('Failed to create stdio pipes');
        }

        this.process.stdout.on('data', (data: Buffer) => {
          this.processStdout(data);
        });

        this.process.stderr.on('data', (data: Buffer) => {
          const text = data.toString();
          logger.debug(`[KiroBackend] stderr: ${text.trim()}`);
          if (/error|exception|failed/i.test(text)) {
            this.emit({ type: 'status', status: 'error', detail: stripAnsi(text).trim() });
          }
        });

        this.process.on('close', (code) => {
          logger.debug(`[KiroBackend] Process exited with code: ${code}`);
          this.outputBuffer = '';

          if (code === 0) {
            this.emit({ type: 'status', status: 'idle' });
            resolve();
          } else if (this.wasCancelled()) {
            // Intentional cancel/dispose SIGTERM'd the process → non-zero/null exit.
            this.emit({ type: 'status', status: 'idle' });
            resolve();
          } else {
            this.emit({ type: 'status', status: 'error', detail: `kiro-cli exited with code ${code}` });
            reject(new Error(`kiro-cli exited with code ${code}`));
          }
          this.process = null;
        });

        // ENOENT → friendly install hint (Phase 0.3 / SOC2 CC7.2).
        this.process.on('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'ENOENT') {
            const message = formatInstallHint('kiro');
            logger.warn(`[KiroBackend] ${message}`);
            this.emit({ type: 'status', status: 'error', detail: message });
            reject(new Error(message));
            return;
          }
          logger.error(`[KiroBackend] Process error:`, err);
          this.emit({ type: 'status', status: 'error', detail: err.message });
          reject(err);
        });
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.emit({ type: 'status', status: 'error', detail: err.message });
        reject(err);
      }
    });
  }

  /**
   * Cancel the current kiro-cli operation (SIGTERM + 3s SIGKILL escalation).
   *
   * @param sessionId - The active session ID to cancel.
   * @throws {Error} When session ID does not match the active session.
   */
  async cancel(sessionId: SessionId): Promise<void> {
    if (sessionId !== this.sessionId) {
      throw new Error(`Invalid session ID: ${sessionId}`);
    }
    if (this.process) {
      logger.debug('[KiroBackend] Cancelling kiro-cli process');
      // Mark cancelled BEFORE SIGTERM so the close handler treats the non-zero
      // exit as an intentional cancel, not a crash (audit 2026-06-09 fix #6).
      this.markCancelled();
      this.process.kill('SIGTERM');
      this.scheduleForceKill();
    }
    this.emit({ type: 'status', status: 'idle' });
  }

  /**
   * Respond to a Kiro permission request.
   *
   * SCHEMA UNVERIFIED — kiro-cli headless mode emits NO structured permission
   * events and tool use is pre-authorized at spawn via `--trust-all-tools` /
   * `--trust-tools`. There is no verified over-stdin y/n channel, so we only emit
   * the `permission-response` for app-side bookkeeping and do NOT write to stdin.
   *
   * @param requestId - The permission request id.
   * @param approved - Whether the user approved.
   */
  async respondToPermission(requestId: string, approved: boolean): Promise<void> {
    this.emit({ type: 'permission-response', id: requestId, approved });
  }

  // waitForResponseComplete and dispose inherited from StreamingAgentBackendBase.
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a Kiro backend.
 *
 * Drives the verified headless `kiro-cli chat --no-interactive <prompt>` mode,
 * which writes the model's plain-text reply to stdout. kiro-cli has no
 * JSON/structured output mode, so this backend surfaces model text only (no
 * usage/cost/tool events — see the module header + #30).
 *
 * The `kiro-cli` binary must be installed and on PATH:
 *   curl -fsSL https://cli.kiro.dev/install | bash
 * Headless use requires `KIRO_API_KEY` (paid tiers).
 *
 * @param options - Configuration options for the backend.
 * @returns KiroBackendResult with backend instance and resolved model.
 *
 * @example
 * ```ts
 * const { backend } = createKiroBackend({
 *   cwd: '/path/to/project',
 *   apiKey: process.env.KIRO_API_KEY,
 *   model: 'claude-sonnet-4-5',
 * });
 * const { sessionId } = await backend.startSession();
 * await backend.sendPrompt(sessionId, 'Optimize the Lambda functions');
 * ```
 */
export function createKiroBackend(options: KiroBackendOptions): KiroBackendResult {
  logger.debug('[Kiro] Creating backend with options:', {
    cwd: options.cwd,
    model: options.model,
    effort: options.effort,
    hasApiKey: !!options.apiKey,
  });

  return {
    backend: new KiroBackend(options),
    model: options.model,
    metadata: {
      modelSource: options.model ? 'explicit' : 'default',
      // Streaming true (text arrives incrementally); tools false (kiro-cli emits
      // no structured tool-call/tool-result events in headless mode).
      supportsStreaming: true,
      supportsTools: false,
    },
  };
}

// ============================================================================
// Registry
// ============================================================================

/**
 * Register the Kiro backend with the global agent registry.
 */
export function registerKiroAgent(): void {
  agentRegistry.register('kiro', (opts) => createKiroBackend(opts).backend);
  logger.debug('[Kiro] Registered with agent registry');
}
