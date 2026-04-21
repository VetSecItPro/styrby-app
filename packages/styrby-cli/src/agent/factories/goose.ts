/**
 * Goose Backend - Goose CLI agent adapter (Block/Square)
 *
 * This module provides a factory function for creating a Goose backend.
 * Goose is an open-source AI coding agent by Block (formerly Square),
 * licensed under Apache 2.0. It uses the Model Context Protocol (MCP)
 * for tool interactions and outputs structured JSON event lines.
 *
 * Key characteristics:
 * - Binary name: `goose` (installed via `pip install goose-ai` or homebrew)
 * - Config: `~/.config/goose/config.yaml`
 * - Output: JSONL (one JSON object per line) via MCP protocol
 * - Cost tracking: token usage embedded in MCP response metadata
 * - Supports MCP servers for extensible tool integrations
 * - Each run is a session with a persistent session ID
 *
 * WHY Apache 2.0 matters: Goose's license allows us to integrate it as a
 * backend without license compatibility concerns. We must retain the Goose
 * copyright notice per the license terms.
 *
 * Repo transferred 2026-04-07 from Block to the AI Alliance / Linux Foundation
 * (`block/goose` → `aaif-goose/goose`). GitHub redirects the old URL but new
 * docs and releases land at the new home.
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
import { StreamingAgentBackendBase, formatInstallHint } from '../StreamingAgentBackendBase';

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
   * Whether to disable interactive mode (always true for Styrby).
   * Goose's --non-interactive flag prevents it from prompting for user input.
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
 * Goose JSONL output event types.
 *
 * WHY: Goose outputs structured JSON lines via its MCP integration.
 * Each line represents a distinct event (message, tool call, cost data, etc.).
 * These types mirror Goose's actual output format so we can parse it reliably.
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
        // WHY: Goose emits a cost event after each model response with MCP usage data.
        // We accumulate these across the session for accurate total cost reporting.
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
   * Spawns a Goose subprocess with the prompt. Uses --format jsonl to get
   * structured output. Uses --non-interactive to prevent blocking on stdin.
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

    this.lineBuffer = '';
    this.emit({ type: 'status', status: 'running' });

    // Build Goose command arguments
    const args: string[] = [
      'run',          // Subcommand for running a one-shot prompt
      '--text',       // Pass prompt as text argument (non-interactive)
      prompt,
      '--format',
      'jsonl',        // Request structured JSONL output for parsing
    ];

    // WHY: Always run non-interactively. Goose may prompt for user input
    // in interactive mode (e.g., permission requests). Since the mobile app
    // handles permissions via the permission-request/response message flow,
    // we auto-approve at the CLI level and rely on the server-side flow.
    const nonInteractive = this.options.nonInteractive !== false;
    if (nonInteractive) {
      args.push('--no-interactive');
    }

    // Add model if specified
    if (this.options.model) {
      args.push('--model', this.options.model);
    }

    // Add provider if specified
    if (this.options.provider) {
      args.push('--provider', this.options.provider);
    }

    // Resume an existing session if session name is provided
    if (this.options.sessionName) {
      args.push('--name', this.options.sessionName);
    }

    // Append any extra CLI args (validated for safety)
    if (this.options.extraArgs) {
      args.push(...validateExtraArgs(this.options.extraArgs));
    }

    logger.debug(`[GooseBackend] Spawning goose with args:`, args);

    return new Promise<void>((resolve, reject) => {
      try {
        // SECURITY: Use buildSafeEnv() instead of spreading process.env to prevent
        // leaking secrets (SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL, etc.) to the
        // Goose subprocess. Only allowlisted system vars + explicit overrides are passed.
        this.process = spawn('goose', args, {
          cwd: this.options.cwd,
          env: buildSafeEnv({
            ...this.options.env,
            // Inject API key under appropriate environment variable names.
            // WHY: Goose reads the API key from the environment; the variable
            // name depends on the configured provider. We set both common names
            // so users don't need to re-configure just because they switched providers.
            ...(this.options.apiKey
              ? {
                  ANTHROPIC_API_KEY: this.options.apiKey,
                  OPENAI_API_KEY: this.options.apiKey,
                  GOOGLE_API_KEY: this.options.apiKey,
                }
              : {}),
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

          // Emit error status for critical errors
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

          if (code === 0) {
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

          this.process = null;
        });

        // Handle process spawn errors (e.g., binary not found)
        // WHY (Phase 0.3 / SOC2 CC7.2): Surface friendly install hint on
        // ENOENT instead of raw "spawn ... ENOENT" Node error.
        this.process.on('error', (err: NodeJS.ErrnoException) => {
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
 * The goose binary must be installed and available in PATH.
 * Install via: `pip install goose-ai` or `brew install pivotal/tap/goose-ai`
 * (See https://github.com/aaif-goose/goose for current install instructions.)
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
