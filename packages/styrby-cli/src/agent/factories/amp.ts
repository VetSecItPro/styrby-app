/**
 * Amp Backend - Amp CLI agent adapter (Sourcegraph)
 *
 * This module provides a factory function for creating an Amp backend.
 * Amp is an AI coding agent by Sourcegraph that supports "deep mode" with
 * sub-agents for parallelized code analysis and editing tasks.
 *
 * Key characteristics:
 * - Binary name: `amp` (installed via npm or direct download from sourcegraph.com)
 * - Config: `~/.config/amp/config.json`
 * - Output: structured JSON with sub-agent event payloads
 * - Cost tracking: token usage from response metadata per sub-agent
 * - Deep mode: spawns multiple sub-agents for parallel analysis
 * - Supports streaming output via --stream flag
 *
 * WHY Amp: Sourcegraph's Amp is differentiated by its "deep mode" which
 * parallelizes code context gathering across multiple sub-agents. This enables
 * more accurate edits on large codebases. Styrby users who work on large
 * monorepos benefit from Amp's ability to read multiple files simultaneously.
 *
 * @see https://ampcode.com
 * @module factories/amp
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type {
  AgentBackend,
  AgentMessage,
  AgentMessageHandler,
  SessionId,
  StartSessionResult,
  AgentFactoryOptions,
} from '../core';
import { agentRegistry } from '../core';
import { logger } from '@/ui/logger';
import { buildSafeEnv, safeBufferAppend, validateExtraArgs } from '@/utils/safeEnv';

// ============================================================================
// Types
// ============================================================================

/**
 * Options for creating an Amp backend.
 */
export interface AmpBackendOptions extends AgentFactoryOptions {
  /**
   * Amp API key from sourcegraph.com/amp.
   * Maps to ANTHROPIC_API_KEY or AMP_API_KEY environment variable.
   * Amp can use Anthropic models or its own Sourcegraph-hosted models.
   */
  apiKey?: string;

  /**
   * Model to use (e.g., 'claude-sonnet-4', 'claude-opus-4').
   * Amp defaults to Claude Sonnet. Override for faster/cheaper options.
   */
  model?: string;

  /**
   * Enable deep mode for parallelized sub-agent analysis.
   *
   * WHY: Deep mode spawns multiple sub-agents to gather context from different
   * parts of the codebase simultaneously. This produces better edits on large
   * codebases but uses more tokens. Disabled by default for cost predictability.
   * Default: false
   */
  deepMode?: boolean;

  /**
   * Maximum number of sub-agents to spawn in deep mode.
   * Only applies when deepMode is true. Default: 4
   */
  maxSubAgents?: number;

  /**
   * Additional Amp CLI arguments.
   * See: https://ampcode.com/docs/cli
   */
  extraArgs?: string[];

  /**
   * Session ID to resume (Amp supports persistent sessions).
   * When provided, Amp will resume the session's context and history.
   */
  resumeSessionId?: string;
}

/**
 * Result of creating an Amp backend.
 */
export interface AmpBackendResult {
  /** The created AgentBackend instance */
  backend: AgentBackend;
  /** The resolved model that will be used */
  model: string | undefined;
}

// ============================================================================
// JSON Output Parsing
// ============================================================================

/**
 * Amp JSON output message types.
 *
 * WHY: Amp outputs structured JSON with a type discriminator field.
 * Each message type has a specific payload structure that maps to
 * different AgentMessage variants in our abstraction layer.
 */
interface AmpJsonMessage {
  type:
    | 'text'
    | 'tool_use'
    | 'tool_result'
    | 'sub_agent_start'
    | 'sub_agent_complete'
    | 'usage'
    | 'error'
    | 'done';
  /** Text content for 'text' events */
  content?: string;
  /** Tool name for 'tool_use' and 'tool_result' events */
  tool_name?: string;
  /** Tool input arguments for 'tool_use' events */
  tool_input?: Record<string, unknown>;
  /** Tool result for 'tool_result' events */
  tool_result?: unknown;
  /** Unique call ID for correlating tool_use to tool_result */
  call_id?: string;
  /** Sub-agent identifier for deep mode events */
  sub_agent_id?: string;
  /** Sub-agent description for deep mode events */
  sub_agent_description?: string;
  /** Token usage metadata for 'usage' events */
  usage?: AmpUsageMetadata;
  /** Error message for 'error' events */
  error?: string;
  /** Session ID for session persistence */
  session_id?: string;
}

/**
 * Token usage metadata from Amp response metadata.
 *
 * WHY: Amp reports per-request and per-sub-agent token usage.
 * We accumulate all sub-agent usage to give users an accurate total,
 * since deep mode sub-agents each consume tokens independently.
 */
interface AmpUsageMetadata {
  /** Input/prompt tokens for this request */
  input_tokens?: number;
  /** Output/completion tokens for this request */
  output_tokens?: number;
  /** Cache read tokens (Anthropic prompt caching) */
  cache_read_tokens?: number;
  /** Cache write tokens (Anthropic prompt caching) */
  cache_write_tokens?: number;
  /** Estimated cost in USD */
  cost_usd?: number;
  /** Which sub-agent generated this usage (for deep mode) */
  sub_agent_id?: string;
}

/**
 * Parse a single JSON line from Amp's output.
 *
 * @param line - A single line of Amp stdout (expected to be JSON)
 * @returns Parsed AmpJsonMessage or null if the line is not valid JSON
 */
function parseAmpJsonLine(line: string): AmpJsonMessage | null {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith('{')) {
    return null;
  }

  try {
    return JSON.parse(trimmed) as AmpJsonMessage;
  } catch {
    return null;
  }
}

/**
 * Extract the file path from an Amp tool input.
 *
 * Amp uses different parameter names for file paths depending on the tool.
 * This function checks common field names to extract the path.
 *
 * @param toolInput - The tool input arguments
 * @returns File path string or null if not found
 */
function extractFilePath(toolInput?: Record<string, unknown>): string | null {
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
 * Determine if an Amp tool call results in a file system edit.
 *
 * @param toolName - The Amp tool name
 * @returns true if this tool writes or modifies files
 */
function isAmpFileEditTool(toolName: string): boolean {
  const fileEditPatterns = [
    'write',
    'edit',
    'create_file',
    'patch',
    'str_replace',
    'apply_diff',
    'modify',
  ];
  const lowerTool = toolName.toLowerCase();
  return fileEditPatterns.some((pattern) => lowerTool.includes(pattern));
}

// ============================================================================
// AmpBackend Class
// ============================================================================

/**
 * Amp Backend implementation.
 *
 * Spawns Amp as a subprocess with JSON output and parses the structured
 * messages. Handles deep mode sub-agent events, token accumulation across
 * sub-agents, and session persistence.
 */
class AmpBackend implements AgentBackend {
  private listeners: AgentMessageHandler[] = [];
  private process: ChildProcess | null = null;
  private disposed = false;
  private sessionId: SessionId | null = null;
  private ampSessionId: string | null = null;
  private lineBuffer = '';
  private inputTokens = 0;
  private outputTokens = 0;
  private cacheReadTokens = 0;
  private cacheWriteTokens = 0;
  private totalCostUsd = 0;
  // WHY: Track active sub-agents in deep mode so we can emit appropriate
  // status messages (e.g., "Running 3 sub-agents") on the mobile app.
  private activeSubAgents = new Set<string>();

  constructor(private options: AmpBackendOptions) {}

  /**
   * Register a handler for agent messages.
   *
   * @param handler - Function to call when messages are received
   */
  onMessage(handler: AgentMessageHandler): void {
    this.listeners.push(handler);
  }

  /**
   * Remove a previously registered message handler.
   *
   * @param handler - The handler to remove
   */
  offMessage(handler: AgentMessageHandler): void {
    const index = this.listeners.indexOf(handler);
    if (index !== -1) {
      this.listeners.splice(index, 1);
    }
  }

  /**
   * Emit a message to all registered handlers.
   *
   * Catches errors from individual handlers to prevent one bad handler
   * from breaking the event pipeline.
   *
   * @param msg - The message to emit
   */
  private emit(msg: AgentMessage): void {
    if (this.disposed) return;
    for (const listener of this.listeners) {
      try {
        listener(msg);
      } catch (error) {
        logger.warn('[AmpBackend] Error in message handler:', error);
      }
    }
  }

  /**
   * Handle a parsed Amp JSON message and emit AgentMessages.
   *
   * WHY: Amp's deep mode introduces sub_agent_start/sub_agent_complete events
   * that don't have a direct counterpart in the AgentMessage union. We map
   * them to 'event' messages so the mobile app can show deep mode activity
   * without needing to know Amp-specific internals.
   *
   * @param msg - The parsed Amp JSON message
   */
  private handleAmpMessage(msg: AmpJsonMessage): void {
    // Extract session ID if Amp provides one (for persistence)
    if (msg.session_id) {
      this.ampSessionId = msg.session_id;
    }

    switch (msg.type) {
      case 'text':
        if (msg.content) {
          this.emit({ type: 'model-output', textDelta: msg.content });
        }
        break;

      case 'tool_use':
        if (msg.tool_name && msg.call_id) {
          this.emit({
            type: 'tool-call',
            toolName: msg.tool_name,
            args: msg.tool_input ?? {},
            callId: msg.call_id,
          });
        }
        break;

      case 'tool_result':
        if (msg.call_id && msg.tool_name) {
          this.emit({
            type: 'tool-result',
            toolName: msg.tool_name,
            result: msg.tool_result,
            callId: msg.call_id,
          });

          // Detect file edits and emit fs-edit event
          if (isAmpFileEditTool(msg.tool_name)) {
            const filePath = extractFilePath(msg.tool_input);
            if (filePath) {
              this.emit({
                type: 'fs-edit',
                description: `${msg.tool_name}: ${filePath}`,
                path: filePath,
              });
            }
          }
        }
        break;

      case 'sub_agent_start':
        // WHY: Deep mode spawns sub-agents for parallel analysis. We track
        // them so the mobile app can show "Deep mode: analyzing X files..."
        // status text instead of appearing hung during long analysis phases.
        if (msg.sub_agent_id) {
          this.activeSubAgents.add(msg.sub_agent_id);
          this.emit({
            type: 'event',
            name: 'sub-agent-start',
            payload: {
              subAgentId: msg.sub_agent_id,
              description: msg.sub_agent_description ?? 'Analyzing codebase',
              activeCount: this.activeSubAgents.size,
            },
          });
        }
        break;

      case 'sub_agent_complete':
        // WHY: Remove the completed sub-agent from the active set and notify
        // the mobile app. When activeCount reaches 0, the main agent resumes.
        if (msg.sub_agent_id) {
          this.activeSubAgents.delete(msg.sub_agent_id);
          this.emit({
            type: 'event',
            name: 'sub-agent-complete',
            payload: {
              subAgentId: msg.sub_agent_id,
              activeCount: this.activeSubAgents.size,
            },
          });
        }
        break;

      case 'usage':
        // WHY: Amp emits usage events after each model response (including
        // per-sub-agent usage in deep mode). We accumulate all usage so
        // the total token count reflects the full cost of the deep analysis.
        if (msg.usage) {
          this.inputTokens += msg.usage.input_tokens ?? 0;
          this.outputTokens += msg.usage.output_tokens ?? 0;
          this.cacheReadTokens += msg.usage.cache_read_tokens ?? 0;
          this.cacheWriteTokens += msg.usage.cache_write_tokens ?? 0;
          this.totalCostUsd += msg.usage.cost_usd ?? 0;

          this.emit({
            type: 'token-count',
            inputTokens: this.inputTokens,
            outputTokens: this.outputTokens,
            cacheReadTokens: this.cacheReadTokens,
            cacheWriteTokens: this.cacheWriteTokens,
            costUsd: this.totalCostUsd,
            // Include sub-agent attribution for deep mode cost visibility
            subAgentId: msg.usage.sub_agent_id,
          });
        }
        break;

      case 'error':
        this.emit({
          type: 'status',
          status: 'error',
          detail: msg.error ?? 'Amp encountered an error',
        });
        break;

      case 'done':
        // WHY: Amp emits 'done' when the response is fully complete,
        // including after all sub-agents finish in deep mode.
        this.activeSubAgents.clear();
        this.emit({ type: 'status', status: 'idle' });
        break;

      default:
        logger.debug('[AmpBackend] Unknown message type:', msg);
    }
  }

  /**
   * Process stdout data, buffering partial lines.
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
      const msg = parseAmpJsonLine(line);
      if (msg) {
        this.handleAmpMessage(msg);
      } else if (line.trim()) {
        logger.debug('[AmpBackend] Non-JSON stdout:', line);
      }
    }
  }

  /**
   * Start a new Amp session.
   *
   * Resets all token/cost accumulators and sub-agent tracking.
   * If a resumeSessionId was provided in options, Amp will resume that session.
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
    this.ampSessionId = this.options.resumeSessionId ?? null;
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.cacheReadTokens = 0;
    this.cacheWriteTokens = 0;
    this.totalCostUsd = 0;
    this.lineBuffer = '';
    this.activeSubAgents.clear();

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

    this.lineBuffer = '';
    this.activeSubAgents.clear();
    this.emit({ type: 'status', status: 'running' });

    // Build Amp command arguments
    const args: string[] = [
      'chat',           // Amp subcommand for one-shot chat
      '--message',
      prompt,
      '--format',
      'json',           // Request structured JSON output
      '--no-interactive', // Prevent blocking on stdin for confirmations
    ];

    // Resume existing session for context continuity
    if (this.ampSessionId) {
      args.push('--session', this.ampSessionId);
    }

    // Model override
    if (this.options.model) {
      args.push('--model', this.options.model);
    }

    // Deep mode — spawns sub-agents for parallel codebase analysis
    if (this.options.deepMode) {
      args.push('--deep');
      if (this.options.maxSubAgents) {
        args.push('--max-agents', String(this.options.maxSubAgents));
      }
    }

    // Extra args (validated for shell safety — SEC-ARGS-001)
    if (this.options.extraArgs) {
      args.push(...validateExtraArgs(this.options.extraArgs));
    }

    logger.debug(`[AmpBackend] Spawning amp with args:`, args);

    return new Promise<void>((resolve, reject) => {
      try {
        // SECURITY: Use buildSafeEnv() instead of spreading process.env to prevent
        // leaking secrets (SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL, etc.) to Amp.
        this.process = spawn('amp', args, {
          cwd: this.options.cwd,
          env: buildSafeEnv({
            ...this.options.env,
            // WHY: Amp uses ANTHROPIC_API_KEY for Claude models and AMP_API_KEY
            // for Sourcegraph-hosted models. We set the provided key under both
            // names so users don't need separate keys for different model choices.
            ...(this.options.apiKey
              ? {
                  ANTHROPIC_API_KEY: this.options.apiKey,
                  AMP_API_KEY: this.options.apiKey,
                }
              : {}),
          }),
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        if (!this.process.stdout || !this.process.stderr) {
          throw new Error('Failed to create stdio pipes');
        }

        // Handle stdout — JSON messages
        this.process.stdout.on('data', (data: Buffer) => {
          this.processStdout(data);
        });

        // Handle stderr — Amp diagnostic messages
        this.process.stderr.on('data', (data: Buffer) => {
          const text = data.toString();
          logger.debug(`[AmpBackend] stderr: ${text.trim()}`);

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
          logger.debug(`[AmpBackend] Process exited with code: ${code}`);

          // Flush remaining buffer
          if (this.lineBuffer.trim()) {
            const msg = parseAmpJsonLine(this.lineBuffer);
            if (msg) {
              this.handleAmpMessage(msg);
            }
            this.lineBuffer = '';
          }

          this.activeSubAgents.clear();

          if (code === 0) {
            this.emit({ type: 'status', status: 'idle' });
            resolve();
          } else {
            this.emit({
              type: 'status',
              status: 'error',
              detail: `Amp exited with code ${code}`,
            });
            reject(new Error(`Amp exited with code ${code}`));
          }

          this.process = null;
        });

        // Handle process spawn errors
        this.process.on('error', (err) => {
          logger.error(`[AmpBackend] Process error:`, err);
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
   * Cancel the current Amp operation.
   *
   * WHY: In deep mode, Amp may have spawned multiple sub-agent processes.
   * SIGTERM propagates to Amp's child processes via the process group, so
   * all sub-agents are terminated when we kill the main Amp process.
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
      this.process.kill('SIGTERM');

      setTimeout(() => {
        if (this.process && !this.process.killed) {
          this.process.kill('SIGKILL');
        }
      }, 3000);
    }

    this.activeSubAgents.clear();
    this.emit({ type: 'status', status: 'idle' });
  }

  /**
   * Respond to an Amp permission request.
   *
   * Amp may request permission for shell execution and file system operations.
   * In non-interactive mode (--no-interactive), Amp auto-approves. This method
   * handles the response for cases where permission requests surface through
   * the MCP protocol.
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

    // Write response to stdin if process is active (for interactive permission flow)
    if (this.process?.stdin && !this.process.killed) {
      const response = approved ? 'y\n' : 'n\n';
      try {
        this.process.stdin.write(response);
      } catch {
        // Stdin may be closed — safe to ignore
      }
    }
  }

  /**
   * Wait for the current Amp response to complete.
   *
   * WHY: In deep mode, Amp may run for several minutes analyzing a large
   * codebase with multiple sub-agents. The default 120s timeout is sufficient
   * for most codebases, but callers can pass a longer timeout for large repos.
   *
   * @param timeoutMs - Maximum wait time in milliseconds (default: 120000)
   * @throws {Error} When the timeout is exceeded before completion
   */
  async waitForResponseComplete(timeoutMs: number = 120000): Promise<void> {
    if (!this.process) {
      return;
    }

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timeout waiting for Amp response'));
      }, timeoutMs);

      const poll = () => {
        if (!this.process || this.process.killed) {
          clearTimeout(timeout);
          resolve();
        } else {
          setTimeout(poll, 100);
        }
      };

      poll();
    });
  }

  /**
   * Clean up resources and close the backend.
   *
   * Terminates any active Amp process (and its sub-agents), removes all
   * message listeners, and prevents further operations.
   */
  async dispose(): Promise<void> {
    this.disposed = true;

    if (this.process) {
      this.process.kill('SIGTERM');
      this.process = null;
    }

    this.activeSubAgents.clear();
    this.listeners = [];
    logger.debug('[AmpBackend] Disposed');
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create an Amp backend.
 *
 * Amp is an AI coding agent by Sourcegraph with optional deep mode that
 * parallelizes codebase analysis using multiple sub-agents.
 *
 * The amp binary must be installed and available in PATH.
 * Install via: `npm install -g @sourcegraph/amp` or download from ampcode.com
 *
 * @param options - Configuration options for the backend
 * @returns AmpBackendResult with backend instance and resolved model
 *
 * @example
 * ```ts
 * // Standard mode
 * const { backend } = createAmpBackend({
 *   cwd: '/path/to/project',
 *   model: 'claude-sonnet-4',
 * });
 *
 * // Deep mode for large codebase analysis
 * const { backend } = createAmpBackend({
 *   cwd: '/path/to/monorepo',
 *   model: 'claude-opus-4',
 *   deepMode: true,
 *   maxSubAgents: 6,
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
    deepMode: options.deepMode,
    maxSubAgents: options.maxSubAgents,
    resumeSessionId: options.resumeSessionId,
  });

  return {
    backend: new AmpBackend(options),
    model: options.model,
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
