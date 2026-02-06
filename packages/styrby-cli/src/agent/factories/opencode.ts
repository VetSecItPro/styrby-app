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
}

/**
 * Result of creating an OpenCode backend
 */
export interface OpenCodeBackendResult {
  /** The created AgentBackend instance */
  backend: AgentBackend;
  /** The resolved model that will be used */
  model: string | undefined;
}

/**
 * OpenCode JSON output message types.
 *
 * These match the output format when using `--format json`.
 */
interface OpenCodeJsonMessage {
  type: 'assistant' | 'tool_use' | 'tool_result' | 'status' | 'error' | 'session';
  content?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_result?: unknown;
  call_id?: string;
  status?: string;
  error?: string;
  session?: OpenCodeSessionInfo;
}

/**
 * OpenCode session info from JSON output.
 */
interface OpenCodeSessionInfo {
  id?: string;
  Cost?: number;
  PromptTokens?: number;
  CompletionTokens?: number;
  TotalTokens?: number;
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
class OpenCodeBackend implements AgentBackend {
  private listeners: AgentMessageHandler[] = [];
  private process: ChildProcess | null = null;
  private disposed = false;
  private sessionId: SessionId | null = null;
  private openCodeSessionId: string | null = null;
  private inputTokens = 0;
  private outputTokens = 0;
  private totalCost = 0;
  private lineBuffer = '';

  constructor(private options: OpenCodeBackendOptions) {}

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
   * @param msg - The message to emit
   */
  private emit(msg: AgentMessage): void {
    if (this.disposed) return;
    for (const listener of this.listeners) {
      try {
        listener(msg);
      } catch (error) {
        logger.warn('[OpenCodeBackend] Error in message handler:', error);
      }
    }
  }

  /**
   * Handle a parsed OpenCode JSON message.
   *
   * Converts OpenCode's JSON format to standard AgentMessage format.
   *
   * @param msg - The parsed OpenCode message
   */
  private handleJsonMessage(msg: OpenCodeJsonMessage): void {
    switch (msg.type) {
      case 'assistant':
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

          // Check for file edits in tool results
          if (
            msg.tool_name === 'write_file' ||
            msg.tool_name === 'edit_file' ||
            msg.tool_name === 'str_replace_editor'
          ) {
            const input = msg.tool_input ?? {};
            const path = (input.path as string) ?? (input.file_path as string);
            if (path) {
              this.emit({
                type: 'fs-edit',
                description: `${msg.tool_name}: ${path}`,
                path,
              });
            }
          }
        }
        break;

      case 'status':
        if (msg.status) {
          const statusMap: Record<string, 'starting' | 'running' | 'idle' | 'stopped' | 'error'> =
            {
              starting: 'starting',
              running: 'running',
              idle: 'idle',
              complete: 'idle',
              stopped: 'stopped',
              error: 'error',
            };
          const status = statusMap[msg.status] ?? 'running';
          this.emit({ type: 'status', status });
        }
        break;

      case 'error':
        this.emit({
          type: 'status',
          status: 'error',
          detail: msg.error ?? 'Unknown error',
        });
        break;

      case 'session':
        if (msg.session) {
          const session = msg.session;
          if (session.id) {
            this.openCodeSessionId = session.id;
          }
          // Update cost tracking from session data
          if (session.Cost !== undefined) {
            this.totalCost = session.Cost;
          }
          if (session.PromptTokens !== undefined) {
            this.inputTokens = session.PromptTokens;
          }
          if (session.CompletionTokens !== undefined) {
            this.outputTokens = session.CompletionTokens;
          }

          // Emit token count update
          this.emit({
            type: 'token-count',
            inputTokens: this.inputTokens,
            outputTokens: this.outputTokens,
            totalTokens: session.TotalTokens ?? this.inputTokens + this.outputTokens,
            costUsd: this.totalCost,
          });
        }
        break;

      default:
        // Log unknown message types for debugging
        logger.debug('[OpenCodeBackend] Unknown message type:', msg);
    }
  }

  /**
   * Process stdout data, handling partial lines.
   *
   * @param data - Raw stdout data buffer
   */
  private processStdout(data: Buffer): void {
    const text = data.toString();
    this.lineBuffer += text;

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

    this.emit({ type: 'status', status: 'running' });

    // Build OpenCode command arguments
    const args: string[] = [
      '--format',
      'json', // Use JSON output format
      '--message',
      prompt,
      '--non-interactive', // Run in non-interactive mode
    ];

    // Add model if specified
    if (this.options.model) {
      args.push('--model', this.options.model);
    }

    // Add session ID for persistence
    if (this.openCodeSessionId) {
      args.push('--session', this.openCodeSessionId);
    }

    // Add extra args
    if (this.options.extraArgs) {
      args.push(...this.options.extraArgs);
    }

    logger.debug(`[OpenCodeBackend] Spawning opencode with args:`, args);

    return new Promise<void>((resolve, reject) => {
      try {
        // Spawn OpenCode process
        this.process = spawn('opencode', args, {
          cwd: this.options.cwd,
          env: {
            ...process.env,
            ...this.options.env,
            // Pass API key if provided
            ...(this.options.apiKey ? { ANTHROPIC_API_KEY: this.options.apiKey } : {}),
          },
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

          if (code === 0) {
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
        this.process.on('error', (err) => {
          logger.error(`[OpenCodeBackend] Process error:`, err);
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
      this.process.kill('SIGTERM');

      // Give it a moment to clean up, then force kill if needed
      setTimeout(() => {
        if (this.process && !this.process.killed) {
          this.process.kill('SIGKILL');
        }
      }, 3000);
    }

    this.emit({ type: 'status', status: 'idle' });
  }

  /**
   * Respond to a permission request.
   *
   * OpenCode handles permissions internally via --non-interactive mode.
   *
   * @param requestId - The ID of the permission request
   * @param approved - Whether the permission was granted
   */
  async respondToPermission?(requestId: string, approved: boolean): Promise<void> {
    // OpenCode uses non-interactive mode, so permissions are auto-handled
    this.emit({
      type: 'permission-response',
      id: requestId,
      approved,
    });
  }

  /**
   * Wait for the current response to complete.
   *
   * @param timeoutMs - Maximum time to wait in milliseconds (default: 120000)
   */
  async waitForResponseComplete(timeoutMs: number = 120000): Promise<void> {
    if (!this.process) {
      return; // No active process
    }

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timeout waiting for OpenCode response'));
      }, timeoutMs);

      const checkComplete = () => {
        if (!this.process || this.process.killed) {
          clearTimeout(timeout);
          resolve();
        } else {
          setTimeout(checkComplete, 100);
        }
      };

      checkComplete();
    });
  }

  /**
   * Clean up resources and close the backend.
   */
  async dispose(): Promise<void> {
    this.disposed = true;

    if (this.process) {
      this.process.kill('SIGTERM');
      this.process = null;
    }

    this.listeners = [];
    logger.debug('[OpenCodeBackend] Disposed');
  }
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
