/**
 * Kiro Backend - Kiro CLI agent adapter (AWS)
 *
 * This module provides a factory function for creating a Kiro backend.
 * Kiro is an AWS-based AI coding agent that uses a per-prompt credit system
 * instead of traditional token-based billing.
 *
 * Key characteristics:
 * - Binary name: `kiro` (installed via AWS CLI or direct download)
 * - Config: `~/.config/kiro/config.json`
 * - Output: structured JSON lines via stdout
 * - Cost tracking: credit-based (credits converted to USD equivalent at a fixed rate)
 * - AWS-native: integrates with IAM, CodeWhisperer, and Amazon Q Developer
 * - Per-prompt credits: each prompt consumes a fixed number of credits regardless of
 *   response length; expensive operations (deep analysis) cost more credits
 *
 * WHY per-prompt credits: Kiro's AWS credit model differs from token-based pricing.
 * One credit equals approximately $0.01 USD (1 credit = $0.01). We convert credits
 * to USD for unified cost tracking in the Styrby dashboard.
 *
 * @see https://kiro.dev
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
import { StreamingAgentBackendBase } from '../StreamingAgentBackendBase';

// ============================================================================
// Constants
// ============================================================================

/**
 * USD cost per single Kiro credit.
 *
 * WHY: Kiro bills in credits rather than tokens. As of the current pricing
 * schedule, 1 credit = $0.01 USD. This constant lets us emit costUsd values
 * in our unified token-count events without requiring callers to know the
 * credit pricing model.
 */
const KIRO_CREDIT_TO_USD = 0.01;

// ============================================================================
// Types
// ============================================================================

/**
 * Options for creating a Kiro backend.
 */
export interface KiroBackendOptions extends AgentFactoryOptions {
  /**
   * AWS profile to use for Kiro authentication.
   * Maps to the AWS_PROFILE environment variable and the --profile flag.
   * Defaults to Kiro's configured default profile from ~/.config/kiro/config.json.
   */
  awsProfile?: string;

  /**
   * AWS region override.
   * Kiro defaults to the region in config.json or AWS_DEFAULT_REGION.
   */
  awsRegion?: string;

  /**
   * Model to use (e.g., 'claude-sonnet-4', 'amazon-nova-pro').
   * Kiro supports AWS Bedrock models and Amazon Q Developer models.
   * Defaults to Kiro's configured default model.
   */
  model?: string;

  /**
   * Whether to run in non-interactive mode (always true for Styrby).
   * Prevents Kiro from prompting for user input on permission requests.
   * Default: true
   */
  nonInteractive?: boolean;

  /**
   * Kiro session name for resuming existing sessions.
   * When provided, Kiro will resume that session's conversation context.
   */
  sessionName?: string;

  /**
   * Additional Kiro CLI arguments.
   * See: https://kiro.dev/docs/cli
   */
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
// JSON Output Parsing
// ============================================================================

/**
 * Kiro JSON output event types.
 *
 * WHY: Kiro outputs structured JSON lines where each line represents a distinct
 * event in the agent's execution flow. The credit-based billing is reported
 * through 'usage' events that include credits_consumed rather than token counts.
 */
interface KiroJsonEvent {
  type:
    | 'message'
    | 'tool_call'
    | 'tool_result'
    | 'usage'
    | 'error'
    | 'status'
    | 'finish';
  /** Text content for message events */
  content?: string;
  /** Tool name for tool_call and tool_result events */
  tool?: string;
  /** Tool input arguments */
  input?: Record<string, unknown>;
  /** Tool result output */
  result?: unknown;
  /** Unique ID correlating tool calls to results */
  call_id?: string;
  /** Usage/billing metadata for usage events */
  usage?: KiroUsageMetadata;
  /** Error message for error events */
  error?: string;
  /** Status string for status events */
  status?: string;
  /** Finish reason for finish events */
  finish_reason?: string;
}

/**
 * Usage metadata from Kiro per-prompt credit billing.
 *
 * WHY: Kiro uses a credit-based system rather than per-token billing.
 * Credits are consumed per prompt based on operation type:
 * - Simple completions: 1-5 credits
 * - Code analysis: 5-20 credits
 * - Deep refactors: 20-100 credits
 *
 * We store both raw credits and the USD equivalent so cost dashboards
 * show comparable numbers across all agent types.
 */
interface KiroUsageMetadata {
  /** Credits consumed for this prompt */
  credits_consumed?: number;
  /** Approximate input tokens (for informational display, not billing) */
  input_tokens?: number;
  /** Approximate output tokens (for informational display, not billing) */
  output_tokens?: number;
  /** Estimated USD cost computed from credits_consumed */
  cost_usd?: number;
}

/**
 * Parse a single JSONL output line from Kiro.
 *
 * @param line - A single line of Kiro stdout output
 * @returns Parsed KiroJsonEvent or null if the line is not valid JSON
 */
function parseKiroJsonLine(line: string): KiroJsonEvent | null {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith('{')) {
    return null;
  }

  try {
    return JSON.parse(trimmed) as KiroJsonEvent;
  } catch {
    return null;
  }
}

/**
 * Detect file system edits from Kiro tool names.
 *
 * WHY: Kiro uses AWS CodeWhisperer-style tool naming for file operations.
 * We detect file-editing tools to emit fs-edit events so the mobile app
 * shows users which files were modified.
 *
 * @param toolName - The tool name from the tool_call event
 * @returns true if this tool modifies the file system
 */
function isKiroFileEditTool(toolName: string): boolean {
  const fileEditTools = [
    'write_file',
    'create_file',
    'edit_file',
    'patch_file',
    'str_replace',
    'apply_patch',
    'modify_file',
    'update_file',
  ];
  return fileEditTools.some((t) => toolName.toLowerCase().includes(t));
}

// ============================================================================
// KiroBackend Class
// ============================================================================

/**
 * Kiro Backend implementation.
 *
 * Spawns Kiro as a subprocess with JSONL output and parses structured events.
 * Handles the credit-based cost model by converting credits to USD for unified
 * cost reporting across all agent types in the Styrby dashboard.
 */
class KiroBackend extends StreamingAgentBackendBase {
  protected readonly logTag = 'KiroBackend';
  private lineBuffer = '';
  // WHY: Kiro uses credits, not tokens. We track credits separately and convert
  // to USD for unified cost display. Token counts are approximate estimates
  // that Kiro provides for informational purposes only.
  private creditsConsumed = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private totalCostUsd = 0;

  constructor(private options: KiroBackendOptions) {
    super();
  }

  /**
   * Process a parsed Kiro JSON event and emit the corresponding AgentMessage.
   *
   * WHY: Kiro's credit-based usage model maps onto our token-count message type
   * by expressing credits as USD cost. We include approximate token counts from
   * Kiro's informational fields so cost breakdown charts have data to display.
   *
   * @param event - The parsed Kiro JSON event
   */
  private handleKiroEvent(event: KiroJsonEvent): void {
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

          // Detect file system edits and emit fs-edit event
          if (isKiroFileEditTool(event.tool)) {
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

      case 'usage':
        // WHY: Kiro emits a usage event after each prompt with credit consumption data.
        // We accumulate credits and convert to USD so the Styrby cost dashboard shows
        // Kiro sessions alongside token-billed agents on a unified dollar basis.
        if (event.usage) {
          const credits = event.usage.credits_consumed ?? 0;
          this.creditsConsumed += credits;
          this.inputTokens += event.usage.input_tokens ?? 0;
          this.outputTokens += event.usage.output_tokens ?? 0;

          // WHY: If Kiro provides a pre-computed cost_usd, prefer it over our
          // conversion. Otherwise compute from credits * KIRO_CREDIT_TO_USD.
          if (event.usage.cost_usd !== undefined) {
            this.totalCostUsd += event.usage.cost_usd;
          } else {
            this.totalCostUsd += credits * KIRO_CREDIT_TO_USD;
          }

          this.emit({
            type: 'token-count',
            inputTokens: this.inputTokens,
            outputTokens: this.outputTokens,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            costUsd: this.totalCostUsd,
            // Include credit count for Kiro-specific display in the dashboard
            creditsConsumed: this.creditsConsumed,
          });
        }
        break;

      case 'error':
        this.emit({
          type: 'status',
          status: 'error',
          detail: event.error ?? 'Kiro encountered an error',
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
        // WHY: Kiro emits 'finish' when the agent's response is fully complete.
        // We transition to 'idle' so the mobile app knows the next prompt can be sent.
        this.emit({ type: 'status', status: 'idle' });
        break;

      default:
        logger.debug('[KiroBackend] Unknown event type:', event);
    }
  }

  /**
   * Process stdout data, buffering partial lines before parsing.
   *
   * WHY: Node.js streams deliver data in arbitrary chunks — a single JSON object
   * may arrive across multiple 'data' events. We buffer until we see a newline
   * before attempting to parse.
   *
   * @param data - Raw buffer chunk from the process stdout
   */
  private processStdout(data: Buffer): void {
    const text = data.toString();
    // SECURITY: Cap buffer size to prevent memory exhaustion from a buggy or
    // malicious agent emitting continuous data without newlines.
    this.lineBuffer = safeBufferAppend(this.lineBuffer, text);

    const lines = this.lineBuffer.split('\n');
    // Keep the last (potentially incomplete) line in the buffer
    this.lineBuffer = lines.pop() ?? '';

    for (const line of lines) {
      const event = parseKiroJsonLine(line);
      if (event) {
        this.handleKiroEvent(event);
      } else if (line.trim()) {
        logger.debug('[KiroBackend] Non-JSON stdout:', line);
      }
    }
  }

  /**
   * Start a new Kiro session.
   *
   * Resets credit/cost/token accumulators and optionally sends an initial prompt.
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
    this.creditsConsumed = 0;
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.totalCostUsd = 0;
    this.lineBuffer = '';

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
   * Send a prompt to Kiro.
   *
   * Spawns a Kiro subprocess with the prompt text. Uses --output-format jsonl
   * for structured output and --no-interactive to prevent blocking on stdin.
   *
   * @param sessionId - The active session ID (must match the one from startSession)
   * @param prompt - The user's prompt text
   * @throws {Error} When the backend is disposed, session ID is invalid, or spawn fails
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

    // Build Kiro command arguments
    const args: string[] = [
      'run',              // Subcommand for one-shot prompt execution
      '--prompt',         // Pass the prompt as an argument
      prompt,
      '--output-format',
      'jsonl',            // Request structured JSONL output for parsing
    ];

    // WHY: Always use non-interactive mode. Kiro may prompt for AWS credential
    // confirmation in interactive mode. The mobile app handles permissions via
    // the permission-request/response message flow at the server relay level.
    const nonInteractive = this.options.nonInteractive !== false;
    if (nonInteractive) {
      args.push('--no-interactive');
    }

    // Model override
    if (this.options.model) {
      args.push('--model', this.options.model);
    }

    // Resume an existing session if session name is provided
    if (this.options.sessionName) {
      args.push('--session', this.options.sessionName);
    }

    // Extra args (validated for shell safety)
    if (this.options.extraArgs) {
      args.push(...validateExtraArgs(this.options.extraArgs));
    }

    logger.debug(`[KiroBackend] Spawning kiro with args:`, args);

    return new Promise<void>((resolve, reject) => {
      try {
        // SECURITY: Use buildSafeEnv() to prevent leaking internal secrets to Kiro.
        // AWS credentials are injected explicitly; all other AWS_* vars are blocked.
        this.process = spawn('kiro', args, {
          cwd: this.options.cwd,
          env: buildSafeEnv({
            ...this.options.env,
            // WHY: Inject AWS profile and region as environment variables so Kiro
            // can authenticate with the correct AWS credentials without requiring
            // users to switch their global AWS_PROFILE for each session.
            ...(this.options.awsProfile
              ? { AWS_PROFILE: this.options.awsProfile }
              : {}),
            ...(this.options.awsRegion
              ? { AWS_DEFAULT_REGION: this.options.awsRegion }
              : {}),
          }),
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        if (!this.process.stdout || !this.process.stderr) {
          throw new Error('Failed to create stdio pipes');
        }

        // Handle stdout — JSONL events from Kiro
        this.process.stdout.on('data', (data: Buffer) => {
          this.processStdout(data);
        });

        // Handle stderr — warnings and diagnostic messages
        this.process.stderr.on('data', (data: Buffer) => {
          const text = data.toString();
          logger.debug(`[KiroBackend] stderr: ${text.trim()}`);

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
          logger.debug(`[KiroBackend] Process exited with code: ${code}`);

          // Flush any remaining buffered output
          if (this.lineBuffer.trim()) {
            const event = parseKiroJsonLine(this.lineBuffer);
            if (event) {
              this.handleKiroEvent(event);
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
              detail: `Kiro exited with code ${code}`,
            });
            reject(new Error(`Kiro exited with code ${code}`));
          }

          this.process = null;
        });

        // Handle process spawn errors (e.g., binary not found in PATH)
        this.process.on('error', (err) => {
          logger.error(`[KiroBackend] Process error:`, err);
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
   * Cancel the current Kiro operation.
   *
   * Sends SIGTERM to allow Kiro to clean up AWS API connections gracefully,
   * then falls back to SIGKILL after 3 seconds if the process hasn't exited.
   *
   * @param sessionId - The active session ID to cancel
   * @throws {Error} When session ID does not match the active session
   */
  async cancel(sessionId: SessionId): Promise<void> {
    if (sessionId !== this.sessionId) {
      throw new Error(`Invalid session ID: ${sessionId}`);
    }

    if (this.process) {
      logger.debug('[KiroBackend] Cancelling Kiro process');
      this.process.kill('SIGTERM');
      // WHY: Give Kiro 3 seconds to cleanly close its AWS API connections
      // before forcing a kill. This prevents resource leaks in the Kiro
      // process manager. The escalation timer is tracked by the base class
      // so it is cancelled on clean exit / dispose / double-cancel
      // (SOC2 CC7.2 event-loop hygiene).
      this.scheduleForceKill();
    }

    this.emit({ type: 'status', status: 'idle' });
  }

  /**
   * Respond to a Kiro permission request.
   *
   * WHY: Kiro may request permission for shell execution and file system operations
   * that could affect the AWS environment. In non-interactive mode, Kiro auto-approves.
   * This method handles the response for interactive permission flows.
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
 * Create a Kiro backend.
 *
 * Kiro is an AWS-based AI coding agent that uses a per-prompt credit system
 * for billing. Credits are converted to USD at a rate of $0.01 per credit for
 * unified cost tracking across all Styrby-supported agents.
 *
 * The kiro binary must be installed and available in PATH.
 * Install via: `curl -sSL https://kiro.dev/install.sh | sh` or
 * `brew install kiro` (if the Homebrew tap is configured).
 *
 * @param options - Configuration options for the backend
 * @returns KiroBackendResult with backend instance and resolved model
 *
 * @throws {Error} If kiro binary is not installed (deferred until sendPrompt is called)
 *
 * @example
 * ```ts
 * const { backend } = createKiroBackend({
 *   cwd: '/path/to/project',
 *   awsProfile: 'dev',
 *   awsRegion: 'us-east-1',
 *   model: 'claude-sonnet-4',
 * });
 *
 * const { sessionId } = await backend.startSession();
 * await backend.sendPrompt(sessionId, 'Optimize the Lambda functions');
 * ```
 */
export function createKiroBackend(options: KiroBackendOptions): KiroBackendResult {
  logger.debug('[Kiro] Creating backend with options:', {
    cwd: options.cwd,
    model: options.model,
    awsProfile: options.awsProfile,
    awsRegion: options.awsRegion,
    sessionName: options.sessionName,
    nonInteractive: options.nonInteractive,
  });

  return {
    backend: new KiroBackend(options),
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
 * Register the Kiro backend with the global agent registry.
 *
 * Call this during application initialization to make Kiro available
 * as an agent type. After calling this, `agentRegistry.create('kiro', opts)`
 * will return a configured KiroBackend instance.
 *
 * @example
 * ```ts
 * // In application startup (initializeAgents):
 * registerKiroAgent();
 * ```
 */
export function registerKiroAgent(): void {
  agentRegistry.register('kiro', (opts) => createKiroBackend(opts).backend);
  logger.debug('[Kiro] Registered with agent registry');
}
