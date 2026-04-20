/**
 * Crush Backend - Crush CLI agent adapter (Charmbracelet)
 *
 * This module provides a factory function for creating a Crush backend.
 * Crush is an AI coding agent by Charmbracelet, designed for terminal-native
 * aesthetics with ACP-compatible communication and charm-style TUI output.
 *
 * Key characteristics:
 * - Binary name: `crush` (installed via Homebrew or direct download from charm.sh)
 * - Config: `~/.config/crush/config.yaml`
 * - Output: ACP-compatible JSON events with charm-style ANSI terminal decorations
 * - Cost tracking: token usage in `usage` events from the ACP response stream
 * - Protocol: ACP-compatible (Agent Communication Protocol), charm-style TUI
 * - Built for terminal purists — outputs rich ANSI, bold colors, box drawings
 *
 * WHY Crush: Charmbracelet has a passionate developer following (they built Bubbletea,
 * Gum, Lip Gloss). Crush captures that audience and differentiates Styrby by supporting
 * a visually rich terminal experience. The ACP compatibility means integration is clean.
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
import { StreamingAgentBackendBase } from '../StreamingAgentBackendBase';

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
   * Model to use (e.g., 'claude-sonnet-4', 'gpt-4o').
   * Defaults to Crush's configured default from ~/.config/crush/config.yaml.
   */
  model?: string;

  /**
   * LLM provider name (e.g., 'anthropic', 'openai').
   * Passed as --provider flag. Defaults to Crush's config file setting.
   */
  provider?: string;

  /**
   * Whether to disable Crush's interactive TUI mode.
   *
   * WHY: Crush renders a full-screen TUI by default (Charmbracelet style).
   * In Styrby's non-interactive mode, we suppress the TUI and get JSON output
   * so the mobile app can render its own UI. Default: true
   */
  noTui?: boolean;

  /**
   * Session name for resuming an existing Crush session.
   * Crush maintains persistent session history by name.
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
// JSON Output Parsing
// ============================================================================

/**
 * Crush ACP-compatible JSON event types.
 *
 * WHY: Crush outputs ACP-compatible JSON events to stdout when running with
 * --no-tui --format json. These map directly onto our AgentMessage union type.
 * The ACP spec guarantees stable event names so we can parse them reliably.
 */
interface CrushJsonEvent {
  /**
   * ACP-compatible event type discriminator.
   * Crush uses lower_snake_case names per the ACP spec.
   */
  type:
    | 'text_delta'
    | 'tool_call'
    | 'tool_result'
    | 'usage'
    | 'error'
    | 'status'
    | 'done';
  /** Text content delta for 'text_delta' events */
  delta?: string;
  /** Tool name for 'tool_call' / 'tool_result' events */
  tool?: string;
  /** Tool input arguments for 'tool_call' events */
  args?: Record<string, unknown>;
  /** Tool output for 'tool_result' events */
  output?: unknown;
  /** Unique call ID for correlating tool_call to tool_result */
  call_id?: string;
  /** Token usage metadata for 'usage' events */
  usage?: CrushUsageMetadata;
  /** Error message for 'error' events */
  message?: string;
  /** Status string for 'status' events */
  state?: string;
}

/**
 * Token usage metadata from Crush ACP usage events.
 *
 * WHY: Crush embeds token usage in ACP usage events after each model turn.
 * We extract this to give Styrby users accurate cost tracking.
 */
interface CrushUsageMetadata {
  /** Input/prompt tokens consumed */
  input_tokens?: number;
  /** Output/completion tokens generated */
  output_tokens?: number;
  /** Cache read tokens (Anthropic prompt caching) */
  cache_read_input_tokens?: number;
  /** Cache write tokens (Anthropic prompt caching) */
  cache_creation_input_tokens?: number;
  /** Estimated cost in USD from Crush's internal billing calculator */
  cost_usd?: number;
}

/**
 * Parse a single JSON event line from Crush's ACP output.
 *
 * @param line - A single line of Crush stdout (expected to be JSON)
 * @returns Parsed CrushJsonEvent or null if the line is not valid JSON
 */
function parseCrushJsonLine(line: string): CrushJsonEvent | null {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith('{')) {
    return null;
  }

  try {
    return JSON.parse(trimmed) as CrushJsonEvent;
  } catch {
    return null;
  }
}

/**
 * Detect file system edits from Crush tool names.
 *
 * WHY: Crush uses charm-style tool naming that may include stylistic prefixes
 * (e.g., "charm_write_file", "edit_file"). We detect the common patterns so
 * the mobile app can show file modification notifications.
 *
 * @param toolName - The ACP tool name from the tool_call event
 * @returns true if this tool modifies the file system
 */
function isCrushFileEditTool(toolName: string): boolean {
  const fileEditPatterns = [
    'write',
    'create',
    'edit',
    'patch',
    'modify',
    'str_replace',
    'apply',
    'overwrite',
  ];
  const lower = toolName.toLowerCase();
  return fileEditPatterns.some((pattern) => lower.includes(pattern));
}

/**
 * Extract file path from a Crush tool input.
 *
 * Crush uses different parameter names across tools. This function checks
 * common field names for robustness.
 *
 * @param args - Tool input arguments
 * @returns File path string or null if not found
 */
function extractCrushFilePath(args?: Record<string, unknown>): string | null {
  if (!args) return null;
  return (
    (args.path as string) ??
    (args.file_path as string) ??
    (args.filename as string) ??
    (args.target as string) ??
    null
  );
}

// ============================================================================
// CrushBackend Class
// ============================================================================

/**
 * Crush Backend implementation.
 *
 * Spawns Crush as a subprocess with ACP-compatible JSON output and parses the
 * structured events. Handles session lifecycle, cost tracking, and file edit
 * detection from charm-style tool names.
 */
class CrushBackend extends StreamingAgentBackendBase {
  protected readonly logTag = 'CrushBackend';
  private lineBuffer = '';
  private inputTokens = 0;
  private outputTokens = 0;
  private cacheReadTokens = 0;
  private cacheWriteTokens = 0;
  private totalCostUsd = 0;

  constructor(private options: CrushBackendOptions) {
    super();
  }

  /**
   * Process a parsed Crush ACP JSON event and emit the corresponding AgentMessage.
   *
   * WHY: Crush's ACP-compatible output maps cleanly onto the AgentMessage union.
   * This explicit mapping makes it easy to track API changes in Crush's output format.
   *
   * @param event - The parsed Crush JSON event
   */
  private handleCrushEvent(event: CrushJsonEvent): void {
    switch (event.type) {
      case 'text_delta':
        if (event.delta) {
          this.emit({ type: 'model-output', textDelta: event.delta });
        }
        break;

      case 'tool_call':
        if (event.tool && event.call_id) {
          this.emit({
            type: 'tool-call',
            toolName: event.tool,
            args: event.args ?? {},
            callId: event.call_id,
          });
        }
        break;

      case 'tool_result':
        if (event.call_id && event.tool) {
          this.emit({
            type: 'tool-result',
            toolName: event.tool,
            result: event.output,
            callId: event.call_id,
          });

          // Detect file system edits and emit fs-edit notification
          if (isCrushFileEditTool(event.tool)) {
            const filePath = extractCrushFilePath(event.args);
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

      case 'usage':
        // WHY: Crush emits a usage event after each model turn with ACP usage data.
        // We accumulate across the session so the mobile app shows a running total.
        if (event.usage) {
          this.inputTokens += event.usage.input_tokens ?? 0;
          this.outputTokens += event.usage.output_tokens ?? 0;
          this.cacheReadTokens += event.usage.cache_read_input_tokens ?? 0;
          this.cacheWriteTokens += event.usage.cache_creation_input_tokens ?? 0;
          this.totalCostUsd += event.usage.cost_usd ?? 0;

          this.emit({
            type: 'token-count',
            inputTokens: this.inputTokens,
            outputTokens: this.outputTokens,
            cacheReadTokens: this.cacheReadTokens,
            cacheWriteTokens: this.cacheWriteTokens,
            costUsd: this.totalCostUsd,
          });
        }
        break;

      case 'error':
        this.emit({
          type: 'status',
          status: 'error',
          detail: event.message ?? 'Crush encountered an error',
        });
        break;

      case 'status':
        // WHY: Crush emits status events to communicate phase transitions
        // (loading context, thinking, executing tools). We map them to our
        // normalized status types for the mobile app status bar.
        if (event.state) {
          const statusMap: Record<string, 'starting' | 'running' | 'idle' | 'stopped' | 'error'> =
            {
              loading: 'starting',
              thinking: 'running',
              executing: 'running',
              idle: 'idle',
              done: 'idle',
              stopped: 'stopped',
              error: 'error',
            };
          const mapped = statusMap[event.state] ?? 'running';
          this.emit({ type: 'status', status: mapped });
        }
        break;

      case 'done':
        // WHY: ACP 'done' signals the end of a complete agent response turn.
        // Map to 'idle' so the mobile app knows it can send the next message.
        this.emit({ type: 'status', status: 'idle' });
        break;

      default:
        logger.debug('[CrushBackend] Unknown event type:', event);
    }
  }

  /**
   * Process stdout data, buffering partial lines until a newline is received.
   *
   * WHY: Node.js streams deliver data in chunks that may span line boundaries.
   * We buffer until we see a newline before attempting to parse JSON.
   *
   * @param data - Raw buffer chunk from process stdout
   */
  private processStdout(data: Buffer): void {
    const text = data.toString();
    // SECURITY: Cap line buffer size to prevent memory exhaustion from
    // a misbehaving agent sending continuous data without newlines.
    this.lineBuffer = safeBufferAppend(this.lineBuffer, text);

    const lines = this.lineBuffer.split('\n');
    // The last element may be an incomplete line — keep it in the buffer
    this.lineBuffer = lines.pop() ?? '';

    for (const line of lines) {
      const event = parseCrushJsonLine(line);
      if (event) {
        this.handleCrushEvent(event);
      } else if (line.trim()) {
        // Non-JSON output (charm-style ANSI decorations, progress bars) — log only
        logger.debug('[CrushBackend] Non-JSON stdout:', line);
      }
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
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.cacheReadTokens = 0;
    this.cacheWriteTokens = 0;
    this.totalCostUsd = 0;
    this.lineBuffer = '';

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
   * Spawns a Crush subprocess with ACP JSON output mode. Uses --no-tui to
   * suppress the charm TUI and get structured JSON events on stdout.
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

    this.lineBuffer = '';
    this.emit({ type: 'status', status: 'running' });

    // Build Crush command arguments
    const args: string[] = [
      '--message',  // Pass the prompt as a message argument (non-interactive)
      prompt,
      '--format',
      'json',       // Request ACP-compatible JSON output for parsing
    ];

    // WHY: Suppress charm's full-screen TUI. In Styrby's relay mode, Crush runs
    // as a headless subprocess. The TUI would capture the terminal and prevent
    // stdout from flowing to our parser. --no-tui routes output to stdout as JSON.
    const noTui = this.options.noTui !== false;
    if (noTui) {
      args.push('--no-tui');
    }

    // Model override
    if (this.options.model) {
      args.push('--model', this.options.model);
    }

    // Provider override
    if (this.options.provider) {
      args.push('--provider', this.options.provider);
    }

    // Resume an existing named session
    if (this.options.sessionName) {
      args.push('--session', this.options.sessionName);
    }

    // Extra args (validated for shell safety — SEC-ARGS-001)
    if (this.options.extraArgs) {
      args.push(...validateExtraArgs(this.options.extraArgs));
    }

    logger.debug(`[CrushBackend] Spawning crush with args:`, args);

    return new Promise<void>((resolve, reject) => {
      try {
        // SECURITY: Use buildSafeEnv() instead of spreading process.env to prevent
        // leaking secrets (SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL, etc.) to Crush.
        this.process = spawn('crush', args, {
          cwd: this.options.cwd,
          env: buildSafeEnv({
            ...this.options.env,
            // WHY: Crush reads from the environment for LLM API keys.
            // We inject the user's key under common names so Crush auto-detects
            // the right one based on its configured provider.
            ...(this.options.apiKey
              ? {
                  ANTHROPIC_API_KEY: this.options.apiKey,
                  OPENAI_API_KEY: this.options.apiKey,
                }
              : {}),
          }),
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        if (!this.process.stdout || !this.process.stderr) {
          throw new Error('Failed to create stdio pipes');
        }

        // Handle stdout — ACP JSON events from Crush
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

          // Flush any remaining buffered output
          if (this.lineBuffer.trim()) {
            const event = parseCrushJsonLine(this.lineBuffer);
            if (event) {
              this.handleCrushEvent(event);
            }
            this.lineBuffer = '';
          }

          if (code === 0) {
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
        this.process.on('error', (err) => {
          logger.error(`[CrushBackend] Process error:`, err);
          this.emit({
            type: 'status',
            status: 'error',
            detail: err.message,
          });
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
   * Crush may request permission for shell execution or dangerous file operations.
   * In --no-tui mode with ACP protocol, we write the response to stdin.
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
  // cancel timer (SOC2 CC7.2 event-loop hygiene), and SIGTERMs the process.
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a Crush backend.
 *
 * Crush is an AI coding agent by Charmbracelet with ACP-compatible JSON output
 * and charm-style terminal aesthetics. It integrates cleanly via the --no-tui
 * flag which routes ACP events to stdout for structured parsing.
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
    noTui: options.noTui,
    sessionName: options.sessionName,
  });

  return {
    backend: new CrushBackend(options),
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
