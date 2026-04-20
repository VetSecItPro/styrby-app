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
 * - Token estimation via simple heuristic (words * 1.3)
 *
 * @module factories/aider
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type {
  AgentBackend,
  SessionId,
  StartSessionResult,
  AgentFactoryOptions,
} from '../core';
import { agentRegistry } from '../core';
import { logger } from '@/ui/logger';
import { buildSafeEnv, validateExtraArgs } from '@/utils/safeEnv';
import { StreamingAgentBackendBase } from '../StreamingAgentBackendBase';

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
 * Estimate token count from text using simple heuristic.
 *
 * Uses the approximation that 1 token ~= 0.75 words (or words * 1.3 tokens).
 * This is a rough estimate; actual token counts vary by model and text content.
 *
 * @param text - The text to estimate tokens for
 * @returns Estimated token count
 */
function estimateTokens(text: string): number {
  const wordCount = text.split(/\s+/).filter((w) => w.length > 0).length;
  return Math.ceil(wordCount * 1.3);
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
class AiderBackend extends StreamingAgentBackendBase {
  protected readonly logTag = 'AiderBackend';
  private outputBuffer = '';
  private inputTokens = 0;
  private outputTokens = 0;

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
    this.outputBuffer = '';

    this.emit({ type: 'status', status: 'running' });

    // Build Aider command arguments
    const args: string[] = [
      '--message',
      prompt,
      '--no-stream', // Disable streaming for easier parsing
      '--yes', // Auto-confirm all prompts
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

        // Handle stdout - this is where Aider's responses come from
        this.process.stdout.on('data', (data: Buffer) => {
          const text = data.toString();
          this.outputBuffer += text;

          // Emit text as model output
          if (text.trim()) {
            this.emit({ type: 'model-output', textDelta: text });

            // Check for file edits
            const lines = text.split('\n');
            for (const line of lines) {
              const edit = parseFileEdit(line.trim());
              if (edit) {
                this.emit({
                  type: 'fs-edit',
                  description: `${edit.action} ${edit.path}`,
                  path: edit.path,
                });
              }
            }
          }
        });

        // Handle stderr - warnings and errors
        this.process.stderr.on('data', (data: Buffer) => {
          const text = data.toString();
          logger.debug(`[AiderBackend] stderr: ${text.trim()}`);

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
          logger.debug(`[AiderBackend] Process exited with code: ${code}`);

          // Update output token estimate
          this.outputTokens += estimateTokens(this.outputBuffer);

          // Emit token count
          this.emit({
            type: 'token-count',
            inputTokens: this.inputTokens,
            outputTokens: this.outputTokens,
            estimatedCostUsd: 0, // Aider doesn't provide cost directly
          });

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

        // Handle process errors
        this.process.on('error', (err) => {
          logger.error(`[AiderBackend] Process error:`, err);
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
