/**
 * Crush Backend - Crush CLI agent adapter (Charmbracelet)
 *
 * This module provides a factory function for creating a Crush backend.
 * Crush is a Bubbletea TUI coding agent by Charmbracelet.
 *
 * Key characteristics (VERIFIED against crush v0.76.0, 2026-06-10):
 * - Binary name: `crush` (installed via Homebrew or direct download from charm.sh)
 * - Headless invocation: `crush run [prompt...]` — runs a single prompt
 *   non-interactively and exits. The prompt is a POSITIONAL argument (or piped
 *   on stdin). Verified from `crush run --help`.
 * - Real `run` flags (verified): -C/--continue, -c/--cwd, -D/--data-dir,
 *   -d/--debug, -m/--model, -q/--quiet (hide spinner), -s/--session,
 *   --small-model, -v/--verbose. There is NO -h-listed --format/--no-tui/
 *   --message/--provider flag.
 * - Output: PLAIN TEXT. `crush run` writes the model's textual response to
 *   stdout (suitable for piping/redirecting per the help examples, e.g.
 *   `crush run "..." > README.md`). Status/spinner/error chrome goes to stderr
 *   as styled ANSI boxes. There is NO machine-readable (JSON/ACP) output mode.
 *
 * WHY only plain-text mapping: crush exposes no structured event stream, so we
 * cannot reliably surface per-token usage, tool calls, or cost. We treat the
 * whole stdout as assistant text (`model-output`) and rely on exit code for
 * completion. Usage/cost/tool/fs-edit events are intentionally NOT emitted
 * because crush provides no verified source for them (see #30).
 *
 * @see https://github.com/charmbracelet/crush
 * @module factories/crush
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

// ============================================================================
// Types
// ============================================================================

/**
 * Options for creating a Crush backend.
 */
export interface CrushBackendOptions extends AgentFactoryOptions {
  /**
   * API key for the underlying LLM provider.
   * Crush auto-detects from environment based on configured provider.
   * Typically ANTHROPIC_API_KEY or OPENAI_API_KEY depending on config.
   */
  apiKey?: string;

  /**
   * Model to use. Passed verbatim to `crush run --model`. Crush accepts either
   * a bare model name or `provider/model` to disambiguate (e.g.
   * 'anthropic/claude-sonnet-4'). Defaults to Crush's configured default in
   * ~/.config/crush/crush.json.
   *
   * WHY no separate `provider` option: crush v0.76.0 has no `--provider` flag.
   * The provider is selected either via the `provider/model` model string or by
   * crush's own config / detected env keys.
   */
  model?: string;

  /**
   * LLM provider hint, used ONLY to pick which API-key env var to inject
   * (ANTHROPIC_API_KEY vs OPENAI_API_KEY). It is NOT passed to crush as a flag
   * because no such flag exists. Default: sniffed from the apiKey prefix.
   */
  provider?: string;

  /**
   * Existing crush session ID to continue. Passed to `crush run --session <id>`
   * (verified flag). Crush persists sessions in its data dir.
   */
  sessionName?: string;

  /**
   * Additional Crush CLI arguments.
   * See: https://github.com/charmbracelet/crush#cli-options
   */
  extraArgs?: string[];
}

/**
 * Result of creating a Crush backend.
 */
export interface CrushBackendResult {
  /** The created AgentBackend instance */
  backend: AgentBackend;
  /** The resolved model that will be used */
  model: string | undefined;
  /** Optional capability / source metadata (additive, backward-compatible). */
  metadata?: AgentFactoryMetadata;
}

// ============================================================================
// Output Parsing
// ============================================================================
//
// SCHEMA UNVERIFIED — crush exposes NO machine-readable output mode.
//
// crush v0.76.0 `crush run` writes the model's response to stdout as PLAIN
// TEXT (verified from `crush run --help`: the examples redirect stdout straight
// into README files). There is no --format json / --no-tui / ACP event stream.
// The previous implementation parsed a fabricated `{text_delta, usage, tool_call,
// done}` ACP schema that does not exist in the real binary.
//
// Consequently this backend can only surface the assistant's text. Token usage,
// per-call cost, tool-call/tool-result, and fs-edit events have NO verified
// source in crush's output and are intentionally NOT emitted. Wiring them up
// requires a keyed crush session to capture real `--verbose`/`--debug` output
// and confirm whether any structured signal is recoverable — tracked in #30.
//
// NOTE: a future verified path could parse `crush run --verbose` logs or query
// `crush session`/`crush stats` subcommands for usage. Do NOT add such parsing
// until the real output has been captured and confirmed against the binary.

// ============================================================================
// CrushBackend Class
// ============================================================================

/**
 * Crush Backend implementation.
 *
 * Spawns `crush run <prompt>` as a one-shot subprocess and streams its stdout
 * (the model's plain-text response) to the mobile app as `model-output`. Crush
 * has no structured/JSON output mode, so this backend does NOT emit usage,
 * cost, tool, or fs-edit events (see the "Output Parsing" note above + #30).
 */
class CrushBackend extends StreamingAgentBackendBase {
  protected readonly logTag = 'CrushBackend';

  // SECURITY: bounded buffer guards against a runaway process flooding stdout
  // without newlines. We still emit incrementally (per data chunk) so the user
  // sees output as it streams; the buffer only caps unbounded growth.
  private outputBuffer = '';

  constructor(private options: CrushBackendOptions) {
    super();
  }

  /**
   * Process stdout data from `crush run`.
   *
   * Crush emits the assistant's reply as plain text (no JSON event framing).
   * We forward each chunk verbatim as a `model-output` delta so the mobile app
   * can render the response as it streams.
   *
   * @param data - Raw buffer chunk from process stdout
   */
  private processStdout(data: Buffer): void {
    const text = data.toString();

    // SECURITY: cap retained buffer size to prevent memory exhaustion from a
    // misbehaving agent that never stops writing. safeBufferAppend trims to the
    // configured ceiling; we only use the buffer for the cap, not re-parsing.
    this.outputBuffer = safeBufferAppend(this.outputBuffer, text);

    if (text) {
      // WHY plain passthrough: crush has no structured event schema, so the raw
      // text IS the model output. No per-event usage/tool data is recoverable.
      this.emit({ type: 'model-output', textDelta: text });
    }
  }

  /**
   * Start a new Crush session.
   *
   * Resets all token/cost accumulators and session state.
   * Optionally sends an initial prompt to begin work immediately.
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
    this.outputBuffer = '';

    this.emit({ type: 'status', status: 'starting' });

    logger.debug(`[CrushBackend] Starting session: ${this.sessionId}`);

    if (initialPrompt) {
      this.emit({ type: 'status', status: 'running' });
      await this.sendPrompt(this.sessionId, initialPrompt);
    } else {
      this.emit({ type: 'status', status: 'idle' });
    }

    return { sessionId: this.sessionId };
  }

  /**
   * Send a prompt to Crush.
   *
   * Spawns `crush run <prompt>` — crush's verified non-interactive mode. The
   * prompt is passed as a positional argument; crush writes the model's reply
   * as plain text to stdout, which we forward as `model-output`.
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

    this.outputBuffer = '';
    this.emit({ type: 'status', status: 'running' });

    // Build verified `crush run` command. Subcommand FIRST, then flags, then the
    // prompt as a trailing positional argument (`crush run [prompt...]`).
    const args: string[] = ['run'];

    // -q/--quiet hides crush's spinner chrome so stdout carries only the model's
    // text (verified flag). We always want this in headless relay mode.
    args.push('--quiet');

    // -m/--model: bare name or `provider/model` (verified flag).
    if (this.options.model) {
      args.push('--model', this.options.model);
    }

    // -s/--session: continue an existing crush session by ID (verified flag).
    if (this.options.sessionName) {
      args.push('--session', this.options.sessionName);
    }

    // WHY no --provider/--format/--no-tui: those flags do NOT exist on crush
    // v0.76.0 `run`. Provider selection happens via the model string and the
    // injected API-key env var below.

    // Extra args (validated for shell safety — SEC-ARGS-001). These go before
    // the positional prompt so flag-style extras parse correctly.
    if (this.options.extraArgs) {
      args.push(...validateExtraArgs(this.options.extraArgs));
    }

    // The prompt is the trailing positional argument: `crush run [flags] <prompt>`.
    // It is passed as a single argv element (no shell), so spaces/quotes in the
    // prompt are safe and need no escaping.
    args.push(prompt);

    logger.debug(`[CrushBackend] Spawning crush with args:`, args);

    return new Promise<void>((resolve, reject) => {
      try {
        // SECURITY: Use buildSafeEnv() instead of spreading process.env to prevent
        // leaking secrets (SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL, etc.) to Crush.
        this.process = spawn('crush', args, {
          cwd: this.options.cwd,
          env: buildSafeEnv({
            ...this.options.env,
            // SECURITY (audit 2026-05-05 HIGH fix): see goose.ts for full
            // rationale. Inject only the env-var matching the detected
            // provider so we don't ship sk-ant-* keys to OpenAI servers.
            ...resolveApiKeyEnv(
              this.options.apiKey,
              ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'],
              this.options.provider as ApiKeyProvider | undefined,
              'CrushBackend',
            ),
          }),
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        if (!this.process.stdout || !this.process.stderr) {
          throw new Error('Failed to create stdio pipes');
        }

        // Handle stdout — plain-text model response from `crush run`
        this.process.stdout.on('data', (data: Buffer) => {
          this.processStdout(data);
        });

        // Handle stderr — charm diagnostics, warnings, and fatal errors
        this.process.stderr.on('data', (data: Buffer) => {
          const text = data.toString();
          logger.debug(`[CrushBackend] stderr: ${text.trim()}`);

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
          logger.debug(`[CrushBackend] Process exited with code: ${code}`);

          // stdout is emitted incrementally in processStdout(); there is no
          // line-framed buffer to flush. Just clear the size-cap buffer.
          this.outputBuffer = '';

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
              detail: `Crush exited with code ${code}`,
            });
            reject(new Error(`Crush exited with code ${code}`));
          }

          this.process = null;
        });

        // Handle spawn errors (e.g., crush binary not in PATH)
        // WHY (Phase 0.3 / SOC2 CC7.2): Surface friendly install hint on
        // ENOENT instead of raw "spawn ... ENOENT" Node error.
        this.process.on('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'ENOENT') {
            const message = formatInstallHint('crush');
            logger.warn(`[CrushBackend] ${message}`);
            this.emit({ type: 'status', status: 'error', detail: message });
            reject(new Error(message));
            return;
          }
          logger.error(`[CrushBackend] Process error:`, err);
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
   * Cancel the current Crush operation.
   *
   * Sends SIGTERM to allow Crush to clean up its TUI state and any open
   * connections. Falls back to SIGKILL after 3 seconds if needed.
   *
   * @param sessionId - The active session ID to cancel
   * @throws {Error} When session ID does not match the active session
   */
  async cancel(sessionId: SessionId): Promise<void> {
    if (sessionId !== this.sessionId) {
      throw new Error(`Invalid session ID: ${sessionId}`);
    }

    if (this.process) {
      logger.debug('[CrushBackend] Cancelling Crush process');
      // Mark cancelled BEFORE SIGTERM so the close handler treats the resulting
      // non-zero exit as an intentional cancel, not a crash (audit 2026-06-09 fix #6).
      this.markCancelled();
      this.process.kill('SIGTERM');

      // WHY: Give Crush 3 seconds to clean up its TUI terminal state before
      // force-killing. If we SIGKILL immediately, the terminal may be left in
      // raw mode, which corrupts the user's shell session. The escalation
      // timer is tracked by the base class so it is cancelled on clean exit,
      // double-cancel, or dispose (SOC2 CC7.2 event-loop hygiene).
      this.scheduleForceKill();
    }

    this.emit({ type: 'status', status: 'idle' });
  }

  /**
   * Respond to a Crush permission request.
   *
   * SCHEMA UNVERIFIED — crush's headless `run` mode has no confirmed interactive
   * permission protocol. Crush governs tool permissions via its config and the
   * `--yolo` flag, not an over-stdin y/n exchange we can verify. We therefore
   * only emit the `permission-response` event for app-side bookkeeping and do
   * NOT fabricate a stdin write. If a real permission channel is discovered with
   * a keyed session (#30), wire it here against verified behavior.
   *
   * @param requestId - The ID of the permission request from Crush
   * @param approved - Whether the user approved the request
   */
  async respondToPermission(requestId: string, approved: boolean): Promise<void> {
    this.emit({
      type: 'permission-response',
      id: requestId,
      approved,
    });
  }

  // waitForResponseComplete and dispose inherited from
  // StreamingAgentBackendBase. Base dispose() clears the listener array, the
  // cancel timer (SOC2 CC7.2 event-loop hygiene), and SIGTERMs the process.
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a Crush backend.
 *
 * Crush is a Bubbletea TUI coding agent by Charmbracelet. We drive its verified
 * headless `crush run <prompt>` mode, which writes the model's plain-text reply
 * to stdout. Crush has no JSON/structured output mode, so this backend surfaces
 * model text only (no usage/cost/tool events — see #30).
 *
 * The crush binary must be installed and available in PATH.
 * Install via: `brew install charmbracelet/tap/crush`
 *
 * @param options - Configuration options for the backend
 * @returns CrushBackendResult with backend instance and resolved model
 *
 * @throws {Error} If crush binary is not installed (deferred until sendPrompt is called)
 *
 * @example
 * ```ts
 * const { backend } = createCrushBackend({
 *   cwd: '/path/to/project',
 *   model: 'claude-sonnet-4',
 *   provider: 'anthropic',
 * });
 *
 * const { sessionId } = await backend.startSession();
 * await backend.sendPrompt(sessionId, 'Refactor the auth module');
 * ```
 */
export function createCrushBackend(options: CrushBackendOptions): CrushBackendResult {
  logger.debug('[Crush] Creating backend with options:', {
    cwd: options.cwd,
    model: options.model,
    provider: options.provider,
    hasApiKey: !!options.apiKey,
    sessionName: options.sessionName,
  });

  return {
    backend: new CrushBackend(options),
    model: options.model,
    metadata: {
      modelSource: options.model ? 'explicit' : 'default',
      // WHY false: crush emits no structured tool-call/tool-result events in
      // headless `run` mode, so we surface no tool data to the app. Streaming
      // is true because stdout text arrives incrementally.
      supportsStreaming: true,
      supportsTools: false,
    },
  };
}

// ============================================================================
// Registry
// ============================================================================

/**
 * Register the Crush backend with the global agent registry.
 *
 * Call this during application initialization to make Crush available
 * as an agent type. After calling this, `agentRegistry.create('crush', opts)`
 * will return a configured CrushBackend instance.
 *
 * @example
 * ```ts
 * // In application startup (initializeAgents):
 * registerCrushAgent();
 * ```
 */
export function registerCrushAgent(): void {
  agentRegistry.register('crush', (opts) => createCrushBackend(opts).backend);
  logger.debug('[Crush] Registered with agent registry');
}
