/**
 * Droid Backend - Droid CLI agent adapter (BYOK)
 *
 * This module provides a factory function for creating a Droid backend.
 * Droid is a Bring Your Own Key (BYOK) AI coding agent that supports multiple
 * LLM backends through the LiteLLM proxy protocol. Users supply their own API
 * keys for any supported provider.
 *
 * Key characteristics:
 * - Binary name: `droid` (installed via `npm install -g droid` or
 *   `curl -fsSL https://app.factory.ai/cli | sh`, or `brew install --cask droid`)
 * - Config: `~/.config/droid/config.yaml`
 * - Output: structured JSON lines via stdout
 * - Cost tracking: varies by backend model, uses LiteLLM pricing tables for estimates
 * - BYOK: users bring their own API keys for Anthropic, OpenAI, Google, Mistral, etc.
 * - Multi-backend: switches LLM backends per session without reinstallation
 *
 * WHY BYOK matters: Enterprise users often have negotiated API rates or on-prem
 * model deployments. Droid lets them use Styrby's mobile UX without being locked
 * into any single provider pricing. LiteLLM pricing is used as the fallback
 * estimator when the backend does not report token costs directly.
 *
 * @see https://docs.factory.ai/cli/getting-started/quickstart
 * @see https://github.com/Factory-AI/factory
 * @module factories/droid
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
// LiteLLM Pricing Table
// ============================================================================

/**
 * LiteLLM-compatible pricing estimates per 1000 tokens in USD.
 *
 * WHY: Droid supports many model backends, each with different pricing.
 * Rather than requiring Droid to report costs, we estimate from the model
 * name using the LiteLLM pricing database as the authoritative source.
 * These are estimates — actual billing depends on the user's provider contract.
 *
 * Prices are per 1000 tokens (input, output).
 * Source: https://docs.litellm.ai/docs/completion/token_usage#8-token-usage
 */
const LITELLM_PRICING: Record<string, { inputPer1K: number; outputPer1K: number }> = {
  // Anthropic Claude models
  'claude-opus-4': { inputPer1K: 0.015, outputPer1K: 0.075 },
  'claude-sonnet-4': { inputPer1K: 0.003, outputPer1K: 0.015 },
  'claude-haiku-3-5': { inputPer1K: 0.0008, outputPer1K: 0.004 },
  // OpenAI GPT models
  'gpt-4o': { inputPer1K: 0.0025, outputPer1K: 0.01 },
  'gpt-4o-mini': { inputPer1K: 0.00015, outputPer1K: 0.0006 },
  'gpt-4-turbo': { inputPer1K: 0.01, outputPer1K: 0.03 },
  'o1': { inputPer1K: 0.015, outputPer1K: 0.06 },
  'o3-mini': { inputPer1K: 0.0011, outputPer1K: 0.0044 },
  // Google Gemini models
  'gemini-2.0-flash': { inputPer1K: 0.0001, outputPer1K: 0.0004 },
  'gemini-2.5-pro': { inputPer1K: 0.00125, outputPer1K: 0.005 },
  // Mistral models
  'mistral-large': { inputPer1K: 0.002, outputPer1K: 0.006 },
  'mistral-small': { inputPer1K: 0.0002, outputPer1K: 0.0006 },
};

/**
 * Default pricing used when the model is unknown.
 *
 * WHY: Unknown models should not silently report $0.00 cost, which would
 * cause users to underestimate spending. Using a mid-range default errs
 * on the side of slight overestimation, which is safer for budgeting.
 */
const DEFAULT_PRICING = { inputPer1K: 0.002, outputPer1K: 0.008 };

/**
 * Estimate cost in USD from token counts using LiteLLM pricing.
 *
 * @param model - The model identifier (partial matches are supported)
 * @param inputTokens - Number of input/prompt tokens
 * @param outputTokens - Number of output/completion tokens
 * @returns Estimated cost in USD
 *
 * @example
 * estimateCostFromTokens('claude-sonnet-4', 1000, 500)
 * // Returns: 0.003 + 0.0075 = 0.0105 USD
 */
function estimateCostFromTokens(
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  // WHY: Try exact match first, then partial match for model family variants
  // (e.g., 'claude-sonnet-4-20250514' should match 'claude-sonnet-4').
  const exactPricing = LITELLM_PRICING[model];
  if (exactPricing) {
    return (
      (inputTokens / 1000) * exactPricing.inputPer1K +
      (outputTokens / 1000) * exactPricing.outputPer1K
    );
  }

  // Partial match: find the longest pricing key that is a prefix of the model name
  let bestMatch: string | null = null;
  for (const key of Object.keys(LITELLM_PRICING)) {
    if (model.includes(key) || key.includes(model)) {
      if (!bestMatch || key.length > bestMatch.length) {
        bestMatch = key;
      }
    }
  }

  const pricing = bestMatch ? LITELLM_PRICING[bestMatch] : DEFAULT_PRICING;
  return (
    (inputTokens / 1000) * pricing.inputPer1K +
    (outputTokens / 1000) * pricing.outputPer1K
  );
}

// ============================================================================
// Types
// ============================================================================

/**
 * Options for creating a Droid backend.
 */
export interface DroidBackendOptions extends AgentFactoryOptions {
  /**
   * API key for the target LLM provider.
   *
   * WHY: Droid is BYOK — users supply their own API keys. The key is injected
   * into the subprocess environment under the provider-specific variable name.
   * This is the primary API key; secondary keys can be passed via apiKeys map.
   */
  apiKey?: string;

  /**
   * Provider-specific API keys for multi-backend sessions.
   *
   * WHY: Some users run Droid with multiple backends in the same session
   * (e.g., using GPT-4o for fast responses and Claude for refactoring).
   * Each provider needs its own key.
   *
   * @example
   * apiKeys: {
   *   ANTHROPIC_API_KEY: 'sk-ant-...',
   *   OPENAI_API_KEY: 'sk-...',
   * }
   */
  apiKeys?: Record<string, string>;

  /**
   * LLM backend to use (e.g., 'anthropic', 'openai', 'google', 'mistral').
   * Passed as --backend flag. Defaults to Droid's config.yaml setting.
   */
  backend?: string;

  /**
   * Model to use (e.g., 'claude-sonnet-4', 'gpt-4o').
   * Droid uses the configured default model for the selected backend.
   */
  model?: string;

  /**
   * Whether to run in non-interactive mode (always true for Styrby).
   * Prevents Droid from prompting for user confirmation.
   * Default: true
   */
  nonInteractive?: boolean;

  /**
   * Session ID to resume (Droid supports persistent sessions).
   * When provided, Droid will resume that session's conversation context.
   */
  resumeSessionId?: string;

  /**
   * Additional Droid CLI arguments.
   * See: https://docs.factory.ai/cli
   */
  extraArgs?: string[];
}

/**
 * Result of creating a Droid backend.
 */
export interface DroidBackendResult {
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
 * Droid JSON output message types.
 *
 * WHY: Droid follows the LiteLLM output format, which is a superset of the
 * OpenAI Chat Completions streaming format. Messages include token usage data
 * that we use to compute costs via the LiteLLM pricing table.
 */
interface DroidJsonMessage {
  type:
    | 'text'
    | 'tool_call'
    | 'tool_result'
    | 'usage'
    | 'error'
    | 'done'
    | 'backend_switch';
  /** Text content for text events */
  content?: string;
  /** Tool name for tool_call and tool_result events */
  tool_name?: string;
  /** Tool input arguments */
  tool_input?: Record<string, unknown>;
  /** Tool result for tool_result events */
  tool_result?: unknown;
  /** Unique call ID correlating tool_call to tool_result */
  call_id?: string;
  /** Token usage for usage events */
  usage?: DroidUsageMetadata;
  /** Error message for error events */
  error?: string;
  /** The newly active backend for backend_switch events */
  new_backend?: string;
  /** The model within the new backend */
  new_model?: string;
  /** Session ID for persistence */
  session_id?: string;
}

/**
 * Token usage metadata from Droid LiteLLM-compatible output.
 *
 * WHY: Droid reports standard token counts but the cost depends on which
 * backend and model were used. We compute cost using our LITELLM_PRICING table
 * rather than relying on Droid to report costs, since the BYOK model means
 * users may have custom pricing through their provider contracts.
 */
interface DroidUsageMetadata {
  /** Input tokens for this request */
  prompt_tokens?: number;
  /** Output tokens for this request */
  completion_tokens?: number;
  /** Cache read tokens (provider-specific) */
  cache_read_tokens?: number;
  /** Cache write tokens (provider-specific) */
  cache_write_tokens?: number;
  /** Pre-computed cost in USD (used if available, otherwise estimated) */
  cost_usd?: number;
  /** Which backend/model generated this usage (for multi-backend sessions) */
  model?: string;
}

/**
 * Parse a single JSON line from Droid's output.
 *
 * @param line - A single line of Droid stdout (expected to be JSON)
 * @returns Parsed DroidJsonMessage or null if the line is not valid JSON
 */
function parseDroidJsonLine(line: string): DroidJsonMessage | null {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith('{')) {
    return null;
  }

  try {
    return JSON.parse(trimmed) as DroidJsonMessage;
  } catch {
    return null;
  }
}

/**
 * Extract a file path from Droid tool input arguments.
 *
 * Droid normalizes tool input across different LLM backends, but field names
 * may still vary. We check multiple common names to extract the path.
 *
 * @param toolInput - Tool input arguments from a tool_call event
 * @returns File path string or null if not found
 */
function extractDroidFilePath(toolInput?: Record<string, unknown>): string | null {
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
 * Determine if a Droid tool call modifies the file system.
 *
 * @param toolName - The Droid tool name (normalized by LiteLLM)
 * @returns true if this tool writes or modifies files
 */
function isDroidFileEditTool(toolName: string): boolean {
  const fileEditPatterns = [
    'write',
    'edit',
    'create_file',
    'patch',
    'str_replace',
    'apply_diff',
    'modify',
    'update_file',
  ];
  const lowerTool = toolName.toLowerCase();
  return fileEditPatterns.some((pattern) => lowerTool.includes(pattern));
}

// ============================================================================
// DroidBackend Class
// ============================================================================

/**
 * Droid Backend implementation.
 *
 * Spawns Droid as a subprocess with JSON output and parses LiteLLM-compatible
 * events. Handles multi-backend sessions, BYOK key injection, and cost estimation
 * from the LiteLLM pricing table for unified cost reporting.
 */
class DroidBackend extends StreamingAgentBackendBase {
  protected readonly logTag = 'DroidBackend';
  private droidSessionId: string | null = null;
  private lineBuffer = '';
  private inputTokens = 0;
  private outputTokens = 0;
  private cacheReadTokens = 0;
  private cacheWriteTokens = 0;
  private totalCostUsd = 0;
  // WHY: Track the current active backend model so we can use the correct
  // LiteLLM pricing for cost estimation after backend_switch events.
  private currentModel: string | undefined;

  constructor(private options: DroidBackendOptions) {
    super();
    this.currentModel = options.model;
  }

  /**
   * Handle a parsed Droid JSON message and emit AgentMessages.
   *
   * WHY: The backend_switch event is Droid-specific — it fires when the BYOK
   * session switches to a different LLM backend mid-conversation. We track the
   * new model so subsequent cost estimates use the correct LiteLLM pricing.
   *
   * @param msg - The parsed Droid JSON message
   */
  private handleDroidMessage(msg: DroidJsonMessage): void {
    if (msg.session_id) {
      this.droidSessionId = msg.session_id;
    }

    switch (msg.type) {
      case 'text':
        if (msg.content) {
          this.emit({ type: 'model-output', textDelta: msg.content });
        }
        break;

      case 'tool_call':
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

          // Detect file edits from tool name and emit fs-edit event
          if (isDroidFileEditTool(msg.tool_name)) {
            const filePath = extractDroidFilePath(msg.tool_input);
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

      case 'usage':
        // WHY: Droid emits usage after each model response. If cost_usd is
        // provided by the backend, prefer it. Otherwise, estimate from
        // token counts using the LiteLLM pricing table. This handles the
        // common case where the LLM provider reports tokens but not cost.
        if (msg.usage) {
          const usageModel = msg.usage.model ?? this.currentModel ?? 'unknown';
          const newInput = msg.usage.prompt_tokens ?? 0;
          const newOutput = msg.usage.completion_tokens ?? 0;

          this.inputTokens += newInput;
          this.outputTokens += newOutput;
          this.cacheReadTokens += msg.usage.cache_read_tokens ?? 0;
          this.cacheWriteTokens += msg.usage.cache_write_tokens ?? 0;

          if (msg.usage.cost_usd !== undefined) {
            this.totalCostUsd += msg.usage.cost_usd;
          } else {
            this.totalCostUsd += estimateCostFromTokens(usageModel, newInput, newOutput);
          }

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

      case 'backend_switch':
        // WHY: Droid can switch LLM backends mid-session. When this happens,
        // we update currentModel so future cost estimates use the correct pricing.
        // We also emit an event so the mobile app can show "Switched to GPT-4o".
        if (msg.new_backend || msg.new_model) {
          const switchedModel = msg.new_model ?? msg.new_backend ?? 'unknown';
          this.currentModel = switchedModel;
          this.emit({
            type: 'event',
            name: 'backend-switch',
            payload: {
              newBackend: msg.new_backend,
              newModel: msg.new_model,
            },
          });
        }
        break;

      case 'error':
        this.emit({
          type: 'status',
          status: 'error',
          detail: msg.error ?? 'Droid encountered an error',
        });
        break;

      case 'done':
        this.emit({ type: 'status', status: 'idle' });
        break;

      default:
        logger.debug('[DroidBackend] Unknown message type:', msg);
    }
  }

  /**
   * Process stdout data, buffering partial lines.
   *
   * @param data - Raw buffer chunk from process stdout
   */
  private processStdout(data: Buffer): void {
    const text = data.toString();
    // SECURITY: Cap buffer size to prevent memory exhaustion
    this.lineBuffer = safeBufferAppend(this.lineBuffer, text);

    const lines = this.lineBuffer.split('\n');
    this.lineBuffer = lines.pop() ?? '';

    for (const line of lines) {
      const msg = parseDroidJsonLine(line);
      if (msg) {
        this.handleDroidMessage(msg);
      } else if (line.trim()) {
        logger.debug('[DroidBackend] Non-JSON stdout:', line);
      }
    }
  }

  /**
   * Start a new Droid session.
   *
   * Resets all token/cost accumulators. If a resumeSessionId was provided
   * in options, Droid will resume that session's conversation context.
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
    this.droidSessionId = this.options.resumeSessionId ?? null;
    this.currentModel = this.options.model;
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.cacheReadTokens = 0;
    this.cacheWriteTokens = 0;
    this.totalCostUsd = 0;
    this.lineBuffer = '';

    this.emit({ type: 'status', status: 'starting' });

    logger.debug(`[DroidBackend] Starting session: ${this.sessionId}`);

    if (initialPrompt) {
      this.emit({ type: 'status', status: 'running' });
      await this.sendPrompt(this.sessionId, initialPrompt);
    } else {
      this.emit({ type: 'status', status: 'idle' });
    }

    return { sessionId: this.sessionId };
  }

  /**
   * Send a prompt to Droid.
   *
   * Spawns a Droid subprocess with JSON output. BYOK API keys are injected
   * via environment variables so they are never logged in process arguments.
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

    // Build Droid command arguments
    const args: string[] = [
      'chat',             // Droid subcommand for one-shot prompt
      '--message',
      prompt,
      '--format',
      'json',             // Request structured JSON output
      '--no-interactive', // Prevent blocking on stdin
    ];

    // Resume an existing session for context continuity
    if (this.droidSessionId) {
      args.push('--session', this.droidSessionId);
    }

    // Backend override
    if (this.options.backend) {
      args.push('--backend', this.options.backend);
    }

    // Model override
    if (this.options.model) {
      args.push('--model', this.options.model);
    }

    // Extra args (validated for shell safety — SEC-ARGS-001)
    if (this.options.extraArgs) {
      args.push(...validateExtraArgs(this.options.extraArgs));
    }

    logger.debug(`[DroidBackend] Spawning droid with args:`, args);

    // Build the API key environment overrides.
    // WHY: BYOK keys must be passed as environment variables, not CLI flags,
    // to prevent them from appearing in process lists (ps aux). We inject
    // the primary apiKey under all common provider variable names, plus any
    // explicitly named apiKeys from the options.
    const apiKeyEnv: Record<string, string> = {};
    if (this.options.apiKey) {
      apiKeyEnv.ANTHROPIC_API_KEY = this.options.apiKey;
      apiKeyEnv.OPENAI_API_KEY = this.options.apiKey;
      apiKeyEnv.GOOGLE_API_KEY = this.options.apiKey;
      apiKeyEnv.MISTRAL_API_KEY = this.options.apiKey;
    }
    // SECURITY: Only forward keys that look like API key env vars.
    // Without this check, a malicious caller could inject LD_PRELOAD,
    // DYLD_INSERT_LIBRARIES, or other vars that alter process behavior.
    if (this.options.apiKeys) {
      const API_KEY_PATTERN = /^[A-Z][A-Z0-9_]*_(API_KEY|KEY|TOKEN|SECRET)$/;
      for (const [key, value] of Object.entries(this.options.apiKeys)) {
        if (API_KEY_PATTERN.test(key)) {
          apiKeyEnv[key] = value;
        } else {
          logger.warn(`[DroidBackend] Ignoring non-API-key env var in apiKeys: "${key}"`);
        }
      }
    }

    return new Promise<void>((resolve, reject) => {
      try {
        // SECURITY: Use buildSafeEnv() to prevent leaking internal Styrby
        // secrets to the Droid subprocess. Only allowlisted system vars and
        // explicitly injected BYOK keys are forwarded.
        this.process = spawn('droid', args, {
          cwd: this.options.cwd,
          env: buildSafeEnv({
            ...this.options.env,
            ...apiKeyEnv,
          }),
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        if (!this.process.stdout || !this.process.stderr) {
          throw new Error('Failed to create stdio pipes');
        }

        // Handle stdout — JSON messages from Droid
        this.process.stdout.on('data', (data: Buffer) => {
          this.processStdout(data);
        });

        // Handle stderr — Droid diagnostic messages
        this.process.stderr.on('data', (data: Buffer) => {
          const text = data.toString();
          logger.debug(`[DroidBackend] stderr: ${text.trim()}`);

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
          logger.debug(`[DroidBackend] Process exited with code: ${code}`);

          // Flush remaining buffer
          if (this.lineBuffer.trim()) {
            const msg = parseDroidJsonLine(this.lineBuffer);
            if (msg) {
              this.handleDroidMessage(msg);
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
              detail: `Droid exited with code ${code}`,
            });
            reject(new Error(`Droid exited with code ${code}`));
          }

          this.process = null;
        });

        // Handle process spawn errors
        // WHY (Phase 0.3 / SOC2 CC7.2): Surface friendly install hint on
        // ENOENT instead of raw "spawn ... ENOENT" Node error.
        this.process.on('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'ENOENT') {
            const message = formatInstallHint('droid');
            logger.warn(`[DroidBackend] ${message}`);
            this.emit({ type: 'status', status: 'error', detail: message });
            reject(new Error(message));
            return;
          }
          logger.error(`[DroidBackend] Process error:`, err);
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
   * Cancel the current Droid operation.
   *
   * WHY: Droid may be mid-stream with an LLM API call when cancelled.
   * SIGTERM allows Droid to close its HTTP connection cleanly and avoid
   * billing the user for a partial response.
   *
   * @param sessionId - The active session ID to cancel
   * @throws {Error} When session ID does not match the active session
   */
  async cancel(sessionId: SessionId): Promise<void> {
    if (sessionId !== this.sessionId) {
      throw new Error(`Invalid session ID: ${sessionId}`);
    }

    if (this.process) {
      logger.debug('[DroidBackend] Cancelling Droid process');
      this.process.kill('SIGTERM');
      // WHY: Track escalation timer via base class so it is cleared on clean
      // exit / dispose / double-cancel. SOC2 CC7.2.
      this.scheduleForceKill();
    }

    this.emit({ type: 'status', status: 'idle' });
  }

  /**
   * Respond to a Droid permission request.
   *
   * In non-interactive mode (--no-interactive), Droid auto-approves most actions.
   * This method handles responses for the interactive permission flow.
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

    if (this.process?.stdin && !this.process.killed) {
      const response = approved ? 'y\n' : 'n\n';
      try {
        this.process.stdin.write(response);
      } catch {
        // Stdin may be closed — safe to ignore
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
 * Create a Droid backend.
 *
 * Droid is a BYOK AI coding agent supporting multiple LLM backends through
 * the LiteLLM proxy protocol. Users supply their own API keys for maximum
 * flexibility. Cost tracking uses LiteLLM pricing tables as fallback estimates.
 *
 * The droid binary must be installed and available in PATH.
 * Install via: `npm install -g droid` (other methods at https://docs.factory.ai/cli)
 *
 * @param options - Configuration options for the backend
 * @returns DroidBackendResult with backend instance and resolved model
 *
 * @example
 * ```ts
 * // Use with Anthropic API key
 * const { backend } = createDroidBackend({
 *   cwd: '/path/to/project',
 *   backend: 'anthropic',
 *   model: 'claude-sonnet-4',
 *   apiKey: process.env.ANTHROPIC_API_KEY,
 * });
 *
 * // Use with multiple provider keys
 * const { backend } = createDroidBackend({
 *   cwd: '/path/to/project',
 *   model: 'gpt-4o',
 *   apiKeys: {
 *     OPENAI_API_KEY: process.env.OPENAI_API_KEY,
 *     ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
 *   },
 * });
 *
 * const { sessionId } = await backend.startSession();
 * await backend.sendPrompt(sessionId, 'Review the PR diff for security issues');
 * ```
 */
export function createDroidBackend(options: DroidBackendOptions): DroidBackendResult {
  logger.debug('[Droid] Creating backend with options:', {
    cwd: options.cwd,
    model: options.model,
    backend: options.backend,
    hasApiKey: !!options.apiKey,
    hasApiKeys: !!(options.apiKeys && Object.keys(options.apiKeys).length > 0),
    resumeSessionId: options.resumeSessionId,
  });

  return {
    backend: new DroidBackend(options),
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
 * Register the Droid backend with the global agent registry.
 *
 * Call this during application initialization to make Droid available
 * as an agent type. After calling this, `agentRegistry.create('droid', opts)`
 * will return a configured DroidBackend instance.
 *
 * @example
 * ```ts
 * // In application startup (initializeAgents):
 * registerDroidAgent();
 * ```
 */
export function registerDroidAgent(): void {
  agentRegistry.register('droid', (opts) => createDroidBackend(opts).backend);
  logger.debug('[Droid] Registered with agent registry');
}
