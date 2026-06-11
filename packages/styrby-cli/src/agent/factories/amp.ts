/**
 * Amp Backend - Amp CLI agent adapter (Sourcegraph / ampcode.com)
 *
 * This module provides a factory function for creating an Amp backend. Amp is
 * an AI coding agent run headlessly via `amp -x "<message>"` (execute mode).
 *
 * Key characteristics (ALL verified against the installed `amp --help`,
 * binary 0.0.1781143784-g47b692, 2026-06-11):
 * - Binary name: `amp` (on PATH)
 * - Config: `~/.config/amp/settings.json`
 * - Auth: `AMP_API_KEY` env var (Amp's own access token from
 *   https://ampcode.com/settings) — NOT ANTHROPIC_API_KEY. `amp login` /
 *   `amp logout` manage stored credentials; `AMP_API_KEY` overrides.
 * - Headless run: `amp -x "<message>"` (positional message; alias `--execute`).
 *   There is NO `chat` subcommand.
 * - JSON output: `amp -x "<message>" --stream-json` emits, per `--help`,
 *   "Claude Code-compatible stream JSON format". i.e. the SAME newline-delimited
 *   stream-json shape the `claude` binary emits — `{type:'assistant',
 *   message:{content:[{type:'text'|'thinking',...}],usage:{input_tokens,...}}}`
 *   then a final `{type:'result'}`.
 * - Agent mode: `-m/--mode deep|rush|smart` (controls model, system prompt,
 *   tool selection). There is NO `--deep` / `--max-agents` flag.
 *
 * Because the parser mirrors claude's stream-json (the formats are documented
 * as compatible), it reuses {@link parseClaudeJsonlLine} from the claude factory
 * for cost extraction so there is a single source of truth for the schema.
 *
 * SCHEMA NOTE (#30): The exact `--stream-json` bytes could NOT be captured in
 * this session because `amp -x ... --stream-json` triggers `amp login` (no
 * AMP_API_KEY / stored credential available). The schema below is taken from
 * the `--help` contract ("Claude Code-compatible") and the claude factory's
 * verified parser. Fields beyond that contract are NOT invented. Re-verify
 * against real keyed output when an Amp credential is available.
 *
 * @see https://ampcode.com
 * @module factories/amp
 */

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
import { StreamingAgentBackendBase } from '../StreamingAgentBackendBase';
import type { CostReport } from '@styrby/shared/cost';
import { parseClaudeJsonlLine } from './claude';

// ============================================================================
// Types
// ============================================================================

/**
 * Amp agent mode, passed via `-m/--mode`.
 *
 * Verified from `amp --help`: "Set the agent mode (deep, rush, smart) — controls
 * the model, system prompt, and tool selection". `deep` is the high-reasoning
 * mode (may require `amp.experimental.modes: ["deep"]` in settings), `rush` is
 * the fast/cheap mode, `smart` is the balanced default. We do NOT default this
 * so Amp uses its own configured default unless the caller opts in.
 */
export type AmpMode = 'deep' | 'rush' | 'smart';

/**
 * Options for creating an Amp backend.
 */
export interface AmpBackendOptions extends AgentFactoryOptions {
  /**
   * Amp access token (from https://ampcode.com/settings).
   * Injected ONLY as the `AMP_API_KEY` environment variable — Amp's own
   * documented auth var. It is NOT a cross-vendor model key, so it is never
   * fanned out to ANTHROPIC_API_KEY / OPENAI_API_KEY (that would leak the token
   * to non-Amp model endpoints during startup validation).
   */
  apiKey?: string;

  /**
   * Model override. Amp does not expose a generic `--model` flag in execute
   * mode (model selection is driven by `--mode`); this field is retained for
   * metadata/reporting only and is NOT passed to the CLI. Left here so cost
   * reports can attribute a model name when the caller knows it.
   */
  model?: string;

  /**
   * Agent mode passed via `-m/--mode` (deep | rush | smart).
   *
   * WHY: This is Amp's real reasoning/cost dial (replaces the invented
   * `--deep`/`--max-agents` flags). Omitted by default so Amp uses its own
   * configured default mode.
   */
  mode?: AmpMode;

  /**
   * Additional Amp CLI arguments, appended after the validated base flags.
   */
  extraArgs?: string[];
}

/**
 * Result of creating an Amp backend.
 *
 * Extends the shared `AgentFactoryResult` contract: `{ backend, model }`
 * stay the canonical fields; `metadata` is additive and optional.
 */
export interface AmpBackendResult {
  /** The created AgentBackend instance */
  backend: AgentBackend;
  /** The resolved model that will be used */
  model: string | undefined;
  /** Optional capability / source metadata. */
  metadata?: AgentFactoryMetadata;
}

// ============================================================================
// Stream-JSON Output Parsing (Claude Code-compatible)
// ============================================================================

/**
 * A single Amp `--stream-json` line.
 *
 * SCHEMA SOURCE (#30 — needs keyed session to byte-verify): `amp --help` states
 * `--stream-json` produces "Claude Code-compatible stream JSON format". This
 * type therefore mirrors the verified claude stream-json shape (see
 * {@link ClaudeStreamMessage} in factories/claude.ts): a leading `system`/init
 * line, one or more `assistant`/`user` lines carrying message content + tool
 * use/results + a `usage` block, and a final `result` line. Typed loosely
 * because only a subset of fields is consumed. NO Amp-specific fields are
 * invented here — if Amp emits extensions (e.g. thinking blocks via
 * `--stream-json-thinking`), they surface through the same `content[]` array.
 */
interface AmpStreamMessage {
  type: 'system' | 'assistant' | 'user' | 'result' | string;
  subtype?: string;
  /** Amp's own thread/session id when present (used for continuity/debug). */
  session_id?: string;
  message?: {
    role?: string;
    model?: string;
    content?: Array<{
      type: string;
      text?: string;
      thinking?: string;
      name?: string;
      input?: Record<string, unknown>;
      id?: string;
      tool_use_id?: string;
      content?: unknown;
    }>;
  };
}

/**
 * Tool names that mutate files, for fs-edit surfacing on mobile.
 *
 * WHY this exact set: Amp's stream-json is Claude Code-compatible, so its tool
 * names match Claude Code's built-in edit tools. Mirrors the claude factory's
 * CLAUDE_EDIT_TOOLS rather than guessing snake_case names that Amp does not emit.
 */
const AMP_EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'create_file']);

// ============================================================================
// AmpBackend Class
// ============================================================================

/**
 * Amp Backend implementation.
 *
 * Spawns `amp -x "<prompt>" --stream-json` and parses the Claude Code-compatible
 * stream-json output line by line (the same line-based pattern claude/opencode/
 * aider use via {@link StreamingAgentBackendBase}). Cost extraction reuses the
 * claude factory's {@link parseClaudeJsonlLine} so the schema has one owner.
 */
class AmpBackend extends StreamingAgentBackendBase {
  protected readonly logTag = 'AmpBackend';
  /** Amp's own thread/session id, captured from any line that carries it. */
  private ampSessionId: string | null = null;

  constructor(private options: AmpBackendOptions) {
    super();
  }

  /**
   * Parse one stream-json line: emit a cost-report if it carries usage, then map
   * its content to {@link AgentMessage}s. Mirrors ClaudeBackend.handleLine since
   * Amp's `--stream-json` is documented as Claude Code-compatible.
   *
   * SCHEMA NOTE (#30): not byte-verified against real keyed Amp output (see the
   * module header). The cost path delegates to the verified claude parser; the
   * content mapping mirrors the verified claude content schema.
   *
   * @param line - A single stream-json line from amp stdout.
   */
  private handleLine(line: string): void {
    if (!line.trim()) return;

    // Cost extraction reuses the shared claude parser, then we re-stamp the
    // agentType/model/billingModel for Amp. Amp is BYOK (AMP_API_KEY) so its
    // billing model is always 'api-key' — there is no subscription pass-through.
    const claudeReport = parseClaudeJsonlLine(line, this.sessionId ?? '', 'api-key');
    if (claudeReport) {
      const report: CostReport = {
        ...claudeReport,
        agentType: 'amp',
        model: this.options.model ?? claudeReport.model,
        billingModel: 'api-key',
      };
      this.emit({ type: 'cost-report', report });
    }

    let msg: AmpStreamMessage;
    try {
      msg = JSON.parse(line) as AmpStreamMessage;
    } catch {
      logger.debug('[AmpBackend] Non-JSON stdout line ignored');
      return;
    }

    // Capture Amp's thread id from any line that carries it (debug/continuity).
    if (typeof msg.session_id === 'string') this.ampSessionId = msg.session_id;

    switch (msg.type) {
      case 'assistant':
        for (const block of msg.message?.content ?? []) {
          if (block.type === 'text' && block.text) {
            this.emit({ type: 'model-output', fullText: block.text });
          } else if (block.type === 'thinking' && block.thinking) {
            // Surfaced only when run with --stream-json-thinking; treated as
            // model output so the mobile UI can show the reasoning trace.
            this.emit({ type: 'model-output', fullText: block.thinking });
          } else if (block.type === 'tool_use' && block.id) {
            this.emit({
              type: 'tool-call',
              toolName: block.name ?? 'unknown',
              args: block.input ?? {},
              callId: block.id,
            });
            // Surface file mutations so the mobile UI can show a diff affordance.
            if (block.name && AMP_EDIT_TOOLS.has(block.name)) {
              const input = block.input ?? {};
              const filePath = (input.file_path as string) ?? (input.path as string);
              if (filePath) {
                this.emit({ type: 'fs-edit', description: `${block.name}: ${filePath}`, path: filePath });
              }
            }
          }
        }
        return;
      case 'user':
        // Amp echoes tool results back as a user message (Claude Code shape).
        for (const block of msg.message?.content ?? []) {
          if (block.type === 'tool_result' && block.tool_use_id) {
            this.emit({
              type: 'tool-result',
              toolName: 'tool',
              result: block.content,
              callId: block.tool_use_id,
            });
          }
        }
        return;
      case 'result':
        // Final line; the close handler emits idle. Nothing extra to map here.
        return;
      default:
        // system/init and any future line types: no content to surface.
        return;
    }
  }

  /**
   * Start a new Amp session.
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
    this.ampSessionId = null;

    this.emit({ type: 'status', status: 'starting' });

    logger.debug(`[AmpBackend] Starting session: ${this.sessionId}`);

    if (initialPrompt) {
      this.emit({ type: 'status', status: 'running' });
      await this.sendPrompt(this.sessionId, initialPrompt);
    } else {
      this.emit({ type: 'status', status: 'idle' });
    }

    return { sessionId: this.sessionId };
  }

  /**
   * Send a prompt to Amp.
   *
   * Spawns an Amp subprocess with JSON output format. Deep mode is enabled
   * optionally via the deepMode option. Amp writes structured JSONL events
   * to stdout that we parse in processStdout.
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
    this.emit({ type: 'status', status: 'running' });

    // Build Amp execute-mode argv. ALL flags verified against `amp --help`:
    //   -x <message>     headless execute mode (positional prompt)
    //   --stream-json    Claude Code-compatible newline-delimited JSON output
    //   -m <mode>        agent mode (deep|rush|smart) when opted in
    // There is NO `chat` subcommand and NO --deep/--max-agents/--format/
    // --no-interactive/--session flag — those were invented and are removed.
    const args: string[] = ['-x', prompt, '--stream-json'];

    // Agent mode (deep | rush | smart). Omitted -> Amp uses its configured default.
    if (this.options.mode) {
      args.push('--mode', this.options.mode);
    }

    logger.debug(`[AmpBackend] Spawning amp with args:`, args);

    return new Promise<void>((resolve, reject) => {
      const child = this.spawnAgent({
        command: 'amp',
        args,
        cwd: this.options.cwd,
        // SECURITY: Inject the Amp token ONLY as AMP_API_KEY — Amp's own
        // documented auth var (verified in `amp --help` env section). The prior
        // code also set ANTHROPIC_API_KEY, leaking the token to the Anthropic
        // endpoint during startup validation (cross-vendor key disclosure). Amp
        // is single-vendor BYOK, so resolveApiKeyEnv()'s multi-provider sniffing
        // does not apply; a single explicit var is the correct, leak-free fix.
        extraEnv: {
          ...this.options.env,
          ...(this.options.apiKey ? { AMP_API_KEY: this.options.apiKey } : {}),
        },
        // extraArgs validated for shell-safety by the base class (SEC-ARGS-001).
        userExtraArgs: this.options.extraArgs,
        // The prompt is passed via `-x`, not stdin. Ignore stdin so amp does not
        // wait on input that never comes. stdout/stderr stay piped for parsing.
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      if (child.stdout) {
        this.streamLines(child.stdout, (line) => this.handleLine(line));
      }
      if (child.stderr) {
        child.stderr.on('data', (data: Buffer) => {
          logger.debug(`[AmpBackend] stderr: ${data.toString().trim()}`);
        });
      }

      child.on('close', (code) => {
        logger.debug(`[AmpBackend] Process exited with code: ${code}`);
        this.process = null;
        this.clearCancelTimer();
        if (code === 0 || this.wasCancelled()) {
          // wasCancelled(): an intentional user cancel/dispose SIGTERM'd the
          // process; treat the resulting non-zero exit as a clean stop, not a
          // crash (audit 2026-06-09 fix #6).
          this.emit({ type: 'status', status: 'idle' });
          resolve();
        } else {
          const detail = `Amp exited with code ${code}`;
          this.emit({ type: 'status', status: 'error', detail });
          reject(new Error(detail));
        }
      });

      // ENOENT -> friendly install hint; other spawn errors forwarded.
      this.attachInstallHintErrorHandler(child, 'amp', reject);
    });
  }

  /**
   * Cancel the in-flight prompt (SIGTERM, then SIGKILL escalation via the base).
   *
   * @param sessionId - The active session ID to cancel
   * @throws {Error} When session ID does not match the active session
   */
  async cancel(sessionId: SessionId): Promise<void> {
    if (sessionId !== this.sessionId) {
      throw new Error(`Invalid session ID: ${sessionId}`);
    }

    if (this.process) {
      logger.debug('[AmpBackend] Cancelling Amp process');
      // Mark cancelled BEFORE SIGTERM so the close handler treats the resulting
      // non-zero exit as an intentional cancel, not a crash (audit 2026-06-09 fix #6).
      this.markCancelled();
      this.process.kill('SIGTERM');
      // WHY: Track the SIGKILL escalation timer via the base class so it is
      // cleared on clean exit / dispose / double-cancel. SOC2 CC7.2.
      this.scheduleForceKill();
    }

    this.emit({ type: 'status', status: 'idle' });
  }

  // respondToPermission inherited from StreamingAgentBackendBase: amp execute
  // mode (-x) runs non-interactively with no stdin permission prompt, so the
  // emit-only base behavior is correct (the prior y/n stdin write targeted a
  // --no-interactive interactive flow that does not exist).

  // waitForResponseComplete + dispose inherited from StreamingAgentBackendBase.
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create an Amp backend.
 *
 * Amp (ampcode.com) is an AI coding agent run headlessly via
 * `amp -x "<prompt>" --stream-json`. The `amp` binary must be installed and on
 * PATH, and authenticated via `amp login` or the `AMP_API_KEY` env var.
 *
 * @param options - Configuration options for the backend
 * @returns AmpBackendResult with backend instance and resolved model
 *
 * @example
 * ```ts
 * // Default mode
 * const { backend } = createAmpBackend({ cwd: '/path/to/project' });
 *
 * // Deep agent mode for harder tasks (amp --mode deep)
 * const { backend } = createAmpBackend({
 *   cwd: '/path/to/monorepo',
 *   mode: 'deep',
 * });
 *
 * const { sessionId } = await backend.startSession();
 * await backend.sendPrompt(sessionId, 'Refactor the auth module across all packages');
 * ```
 */
export function createAmpBackend(options: AmpBackendOptions): AmpBackendResult {
  logger.debug('[Amp] Creating backend with options:', {
    cwd: options.cwd,
    model: options.model,
    hasApiKey: !!options.apiKey,
    mode: options.mode,
  });

  return {
    backend: new AmpBackend(options),
    model: options.model,
    metadata: {
      modelSource: options.model ? 'explicit' : 'default',
      supportsStreaming: true,
      supportsTools: true,
      mode: options.mode ?? 'default',
    },
  };
}

// ============================================================================
// Registry
// ============================================================================

/**
 * Register the Amp backend with the global agent registry.
 *
 * Call this during application initialization to make Amp available
 * as an agent type. After calling this, `agentRegistry.create('amp', opts)`
 * will return a configured AmpBackend instance.
 *
 * @example
 * ```ts
 * // In application startup (initializeAgents):
 * registerAmpAgent();
 * ```
 */
export function registerAmpAgent(): void {
  agentRegistry.register('amp', (opts) => createAmpBackend(opts).backend);
  logger.debug('[Amp] Registered with agent registry');
}
