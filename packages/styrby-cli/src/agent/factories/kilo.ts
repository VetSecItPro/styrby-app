/**
 * Kilo Backend - Kilo CLI agent adapter (Community, 500+ models)
 *
 * This module provides a factory function for creating a Kilo backend.
 * Kilo is a community-driven AI coding agent designed for maximum model
 * flexibility (500+ supported models) and a unique Memory Bank feature
 * that persists structured knowledge across sessions.
 *
 * Key characteristics:
 * - Binary name: `kilo` (installed via npm or direct download)
 * - Config: `~/.config/kilo/config.json`
 * - Output: Custom JSON protocol with Memory Bank read/write events
 * - Cost tracking: token usage in `tokens` events from JSON stream
 * - Memory Bank: persists project knowledge (architecture, decisions, patterns)
 *   across agent restarts — users never re-explain the same context twice
 * - 500+ models: any OpenAI-compatible API endpoint can be used as a backend
 *
 * WHY Kilo: Kilo's Memory Bank feature is a significant differentiator.
 * Users who work on long-running projects can persist context that survives
 * agent restarts. Styrby surfaces Memory Bank events so mobile users can see
 * what was remembered and recalled — turning a hidden feature into a visible UX win.
 *
 * WHY 500+ models: Kilo's model agnosticism attracts users who run local models
 * (Ollama, LM Studio) or use specialized providers. This segment is underserved
 * by Claude/Codex-specific tools.
 *
 * @see https://github.com/Kilo-Org/kilocode
 * @module factories/kilo
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
import type { CostReport, BillingModel } from '@styrby/shared/cost';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Detect whether the Kilo session is using a local/free model.
 *
 * WHY: Kilo supports 500+ models including local ones via Ollama and LM Studio.
 * Local models have zero marginal cost — charging users for them would be wrong.
 * We detect local usage by matching the model name pattern or checking whether
 * the apiBaseUrl resolves to localhost/127.0.0.1.
 *
 * @param model - Model identifier (e.g., 'ollama/llama3', 'local-codellama')
 * @param apiBaseUrl - Optional API base URL (e.g., 'http://localhost:11434/v1')
 * @returns true when the model is local/free-tier
 */
function isKiloLocalModel(model: string | undefined, apiBaseUrl: string | undefined): boolean {
  if (model && /ollama|^local-/i.test(model)) return true;
  if (apiBaseUrl) {
    try {
      const url = new URL(apiBaseUrl);
      return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
    } catch {
      // Invalid URL - not local
    }
  }
  return false;
}

// ============================================================================
// Types
// ============================================================================

/**
 * Options for creating a Kilo backend.
 */
export interface KiloBackendOptions extends AgentFactoryOptions {
  /**
   * API key for the LLM provider.
   * Kilo supports any OpenAI-compatible endpoint, so this key is used
   * with whatever provider is configured in ~/.config/kilo/config.json.
   */
  apiKey?: string;

  /**
   * Model identifier (e.g., 'gpt-4o', 'claude-sonnet-4', 'ollama/llama3').
   * Kilo supports 500+ models via OpenAI-compatible APIs.
   * Defaults to Kilo's configured default from config.json.
   */
  model?: string;

  /**
   * OpenAI-compatible API base URL.
   * WHY: Kilo supports any endpoint (Ollama, LM Studio, Together, etc.).
   * Pass this to override the default OpenAI endpoint in config.
   * Example: 'http://localhost:11434/v1' for Ollama.
   */
  apiBaseUrl?: string;

  /**
   * Whether to enable Memory Bank for this session.
   *
   * WHY: Memory Bank persists project context (architecture decisions,
   * coding patterns, team conventions) across sessions in structured markdown
   * files. Enabling it means Kilo will read from and write to the Memory Bank
   * automatically, reducing repetitive context-setting for long-running projects.
   * Default: true (this is Kilo's primary differentiator)
   */
  memoryBankEnabled?: boolean;

  /**
   * Path to the Memory Bank directory.
   * WHY: Kilo stores Memory Bank files in .kilo/memory/ by default within
   * the project directory. Some teams prefer a shared location (e.g., a
   * network drive or git-tracked folder). Override with a custom path.
   * Defaults to <cwd>/.kilo/memory/
   */
  memoryBankPath?: string;

  /**
   * Session ID to resume (Kilo supports resuming sessions with Memory Bank context).
   * When provided, Kilo loads the Memory Bank for that session's project.
   */
  resumeSessionId?: string;

  /**
   * Additional Kilo CLI arguments.
   */
  extraArgs?: string[];
}

/**
 * Result of creating a Kilo backend.
 */
export interface KiloBackendResult {
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
 * Kilo JSON output message types.
 *
 * WHY: Kilo's custom JSON protocol includes Memory Bank events alongside
 * standard agent events. These are the key differentiator from other agents
 * and give Styrby unique data to surface in the mobile app.
 */
interface KiloJsonMessage {
  type:
    | 'text'
    | 'tool_use'
    | 'tool_result'
    | 'memory_bank_read'
    | 'memory_bank_write'
    | 'tokens'
    | 'error'
    | 'complete';
  /** Text content for 'text' events */
  content?: string;
  /** Tool name for 'tool_use' and 'tool_result' events */
  tool_name?: string;
  /** Tool input for 'tool_use' events */
  tool_input?: Record<string, unknown>;
  /** Tool result for 'tool_result' events */
  tool_result?: unknown;
  /** Unique call ID for correlating tool_use to tool_result */
  call_id?: string;
  /**
   * Memory Bank file that was read for 'memory_bank_read' events.
   * WHY: Kilo reads structured markdown files (e.g., projectbrief.md,
   * activeContext.md) at session start and before complex tasks.
   * Surfacing the filename tells users which memory was recalled.
   */
  memory_file?: string;
  /** Content read from or written to the Memory Bank */
  memory_content?: string;
  /** Memory Bank section being written (e.g., 'decisions', 'patterns') */
  memory_section?: string;
  /** Token usage for 'tokens' events */
  usage?: KiloUsageMetadata;
  /** Error message for 'error' events */
  error?: string;
}

/**
 * Token usage metadata from Kilo's 'tokens' events.
 *
 * WHY: Kilo reports token usage after each model request. The model-agnostic
 * design means the cost calculation depends on which provider/model is active.
 * We pass raw token counts to Styrby's cost engine for accurate billing.
 */
interface KiloUsageMetadata {
  /** Input/prompt tokens consumed */
  input_tokens?: number;
  /** Output/completion tokens generated */
  output_tokens?: number;
  /** Cache read tokens (if the underlying provider supports caching) */
  cache_read_tokens?: number;
  /** Cache write tokens (if the underlying provider supports caching) */
  cache_write_tokens?: number;
  /** Estimated cost in USD (Kilo calculates based on configured model pricing) */
  cost_usd?: number;
}

/**
 * Parse a single JSON message line from Kilo's output.
 *
 * @param line - A single line of Kilo stdout (expected to be JSON)
 * @returns Parsed KiloJsonMessage or null if the line is not valid JSON
 */
function parseKiloJsonLine(line: string): KiloJsonMessage | null {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith('{')) {
    return null;
  }

  try {
    return JSON.parse(trimmed) as KiloJsonMessage;
  } catch {
    return null;
  }
}

/**
 * Detect file system edits from Kilo tool names.
 *
 * Kilo uses standard file operation tool names consistent with OpenAI
 * function calling conventions.
 *
 * @param toolName - The Kilo tool name from the tool_use event
 * @returns true if this tool writes or modifies files
 */
function isKiloFileEditTool(toolName: string): boolean {
  const fileEditPatterns = [
    'write_file',
    'create_file',
    'edit_file',
    'patch_file',
    'str_replace',
    'apply_patch',
    'modify_file',
    'overwrite_file',
  ];
  const lower = toolName.toLowerCase();
  return fileEditPatterns.some((pattern) => lower.includes(pattern));
}

/**
 * Extract file path from Kilo tool input arguments.
 *
 * @param toolInput - Tool input arguments
 * @returns File path string or null if not found
 */
function extractKiloFilePath(toolInput?: Record<string, unknown>): string | null {
  if (!toolInput) return null;
  return (
    (toolInput.path as string) ??
    (toolInput.file_path as string) ??
    (toolInput.filename as string) ??
    (toolInput.target as string) ??
    null
  );
}

// ============================================================================
// KiloBackend Class
// ============================================================================

/**
 * Kilo Backend implementation.
 *
 * Spawns Kilo as a subprocess with JSON output and parses structured messages.
 * Handles standard agent events plus Kilo-specific Memory Bank read/write events.
 * Memory Bank events are emitted as 'event' messages with names 'memory-bank-read'
 * and 'memory-bank-write' so the mobile app can surface them as special cards.
 */
class KiloBackend extends StreamingAgentBackendBase {
  protected readonly logTag = 'KiloBackend';
  private lineBuffer = '';
  private inputTokens = 0;
  private outputTokens = 0;
  private cacheReadTokens = 0;
  private cacheWriteTokens = 0;
  private totalCostUsd = 0;
  /**
   * WHY: Track Memory Bank reads during a session so the mobile app can display
   * a "Memory recalled: N files" indicator. Power users care about which context
   * Kilo loaded — showing it builds trust in the Memory Bank feature.
   */
  private memoryBankReads: string[] = [];
  /**
   * WHY: Track Memory Bank writes so the mobile app can display a "Memory updated"
   * notification. This makes the feature visible — users know their context is
   * being persisted, which differentiates Kilo from stateless agents.
   */
  private memoryBankWrites: string[] = [];

  constructor(private options: KiloBackendOptions) {
    super();
  }

  /**
   * Handle a parsed Kilo JSON message and emit the corresponding AgentMessages.
   *
   * WHY: Kilo's Memory Bank events (memory_bank_read, memory_bank_write) are
   * unique to Kilo. We emit them as 'event' messages so the mobile app can
   * render special Memory Bank cards without needing Kilo-specific code in
   * the mobile layer — the event name is the only Kilo-specific thing that
   * leaks to the mobile app.
   *
   * @param msg - The parsed Kilo JSON message
   */
  private handleKiloMessage(msg: KiloJsonMessage): void {
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
          if (isKiloFileEditTool(msg.tool_name)) {
            const filePath = extractKiloFilePath(msg.tool_input);
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

      case 'memory_bank_read':
        // WHY: Memory Bank reads happen when Kilo loads project context at session
        // start or before a complex task. We track which files were read so the
        // mobile app can display "Recalled: projectbrief.md, activeContext.md".
        // This makes the Memory Bank feature tangible to users who don't read logs.
        if (msg.memory_file) {
          this.memoryBankReads.push(msg.memory_file);
          this.emit({
            type: 'event',
            name: 'memory-bank-read',
            payload: {
              file: msg.memory_file,
              contentPreview: msg.memory_content
                ? msg.memory_content.slice(0, 200)
                : undefined,
              totalReads: this.memoryBankReads.length,
              allFiles: [...this.memoryBankReads],
            },
          });
        }
        break;

      case 'memory_bank_write':
        // WHY: Memory Bank writes happen when Kilo discovers new architectural
        // decisions, patterns, or progress updates worth persisting. We notify
        // users so they know their context is growing — this is the core value prop
        // of Kilo. Without visibility, users don't know the feature is working.
        if (msg.memory_file) {
          this.memoryBankWrites.push(msg.memory_file);
          this.emit({
            type: 'event',
            name: 'memory-bank-write',
            payload: {
              file: msg.memory_file,
              section: msg.memory_section,
              contentPreview: msg.memory_content
                ? msg.memory_content.slice(0, 200)
                : undefined,
              totalWrites: this.memoryBankWrites.length,
              allFiles: [...new Set(this.memoryBankWrites)], // deduplicate
            },
          });
        }
        break;

      case 'tokens':
        // WHY: Kilo emits token counts after each model request. We accumulate
        // across the session so the mobile app shows a running cost total.
        if (msg.usage) {
          const incrInput = msg.usage.input_tokens ?? 0;
          const incrOutput = msg.usage.output_tokens ?? 0;
          const incrCacheRead = msg.usage.cache_read_tokens ?? 0;
          const incrCacheWrite = msg.usage.cache_write_tokens ?? 0;

          // WHY: Local/free models (Ollama, LM Studio) have zero marginal cost.
          // We detect local usage by model name or apiBaseUrl and set costUsd=0.
          const isLocal = isKiloLocalModel(this.options.model, this.options.apiBaseUrl);
          const incrCost = isLocal ? 0 : (msg.usage.cost_usd ?? 0);

          this.inputTokens += incrInput;
          this.outputTokens += incrOutput;
          this.cacheReadTokens += incrCacheRead;
          this.cacheWriteTokens += incrCacheWrite;
          this.totalCostUsd += incrCost;

          // Emit legacy token-count (keep for existing consumers)
          this.emit({
            type: 'token-count',
            inputTokens: this.inputTokens,
            outputTokens: this.outputTokens,
            cacheReadTokens: this.cacheReadTokens,
            cacheWriteTokens: this.cacheWriteTokens,
            costUsd: this.totalCostUsd,
          });

          // WHY: Emit unified CostReport. Kilo local models use billingModel='free'
          // with costUsd=0; remote models use 'api-key'. source='agent-reported'
          // when Kilo reports cost_usd; 'styrby-estimate' otherwise.
          const billingModel: BillingModel = isLocal ? 'free' : 'api-key';
          const hasAgentCost = !isLocal && msg.usage.cost_usd !== undefined;
          const costReport: CostReport = {
            sessionId: this.sessionId ?? '',
            messageId: null,
            agentType: 'kilo',
            model: this.options.model ?? 'unknown',
            timestamp: new Date().toISOString(),
            source: hasAgentCost ? 'agent-reported' : 'styrby-estimate',
            billingModel,
            costUsd: incrCost,
            inputTokens: incrInput,
            outputTokens: incrOutput,
            cacheReadTokens: incrCacheRead,
            cacheWriteTokens: incrCacheWrite,
            rawAgentPayload: hasAgentCost ? (msg.usage as unknown as Record<string, unknown>) : null,
          };
          this.emit({ type: 'cost-report', report: costReport } as any);
        }
        break;

      case 'error':
        this.emit({
          type: 'status',
          status: 'error',
          detail: msg.error ?? 'Kilo encountered an error',
        });
        break;

      case 'complete':
        // WHY: Kilo emits 'complete' when the response is fully done, including
        // any Memory Bank writes that happen at the end of a task.
        this.emit({ type: 'status', status: 'idle' });
        break;

      default:
        logger.debug('[KiloBackend] Unknown message type:', msg);
    }
  }

  /**
   * Process stdout data, buffering partial lines until a newline is received.
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
      const msg = parseKiloJsonLine(line);
      if (msg) {
        this.handleKiloMessage(msg);
      } else if (line.trim()) {
        logger.debug('[KiloBackend] Non-JSON stdout:', line);
      }
    }
  }

  /**
   * Start a new Kilo session.
   *
   * Resets all token/cost accumulators and Memory Bank tracking.
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
    this.memoryBankReads = [];
    this.memoryBankWrites = [];

    this.emit({ type: 'status', status: 'starting' });

    logger.debug(`[KiloBackend] Starting session: ${this.sessionId}`);

    if (initialPrompt) {
      this.emit({ type: 'status', status: 'running' });
      await this.sendPrompt(this.sessionId, initialPrompt);
    } else {
      this.emit({ type: 'status', status: 'idle' });
    }

    return { sessionId: this.sessionId };
  }

  /**
   * Send a prompt to Kilo.
   *
   * Spawns a Kilo subprocess with JSON output mode. Memory Bank is enabled
   * or disabled based on the memoryBankEnabled option. Kilo writes structured
   * JSON messages to stdout including Memory Bank events.
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

    // Build Kilo command arguments
    const args: string[] = [
      'run',          // Kilo subcommand for non-interactive one-shot execution
      '--prompt',
      prompt,
      '--output',
      'json',         // Request JSON output for structured parsing
      '--no-interactive', // Prevent blocking on stdin
    ];

    // Model override
    if (this.options.model) {
      args.push('--model', this.options.model);
    }

    // Custom API base URL for non-OpenAI providers (Ollama, etc.)
    // SECURITY: Validate the URL scheme to prevent SSRF via non-HTTP schemes.
    if (this.options.apiBaseUrl) {
      try {
        const parsed = new URL(this.options.apiBaseUrl);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
          throw new Error(`Invalid API base URL scheme: ${parsed.protocol}. Only http:// and https:// are allowed.`);
        }
        args.push('--api-base', this.options.apiBaseUrl);
      } catch (e) {
        if (e instanceof Error && e.message.includes('Invalid API base URL scheme')) {
          throw e;
        }
        throw new Error(`Invalid API base URL: "${this.options.apiBaseUrl}". Must be a valid http:// or https:// URL.`);
      }
    }

    // Memory Bank configuration
    // WHY: Memory Bank is enabled by default because it's Kilo's primary value prop.
    // Users who don't want it can set memoryBankEnabled: false. We explicitly pass
    // the flag so behavior is predictable regardless of Kilo's config file default.
    const memoryBankEnabled = this.options.memoryBankEnabled !== false;
    if (memoryBankEnabled) {
      args.push('--memory-bank');
      if (this.options.memoryBankPath) {
        args.push('--memory-bank-path', this.options.memoryBankPath);
      }
    } else {
      args.push('--no-memory-bank');
    }

    // Resume existing session for context continuity
    if (this.options.resumeSessionId) {
      args.push('--resume', this.options.resumeSessionId);
    }

    // Extra args (validated for shell safety — SEC-ARGS-001)
    if (this.options.extraArgs) {
      args.push(...validateExtraArgs(this.options.extraArgs));
    }

    logger.debug(`[KiloBackend] Spawning kilo with args:`, args);

    return new Promise<void>((resolve, reject) => {
      try {
        // SECURITY: Use buildSafeEnv() instead of spreading process.env to prevent
        // leaking secrets (SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL, etc.) to Kilo.
        this.process = spawn('kilo', args, {
          cwd: this.options.cwd,
          env: buildSafeEnv({
            ...this.options.env,
            // WHY: Kilo supports any OpenAI-compatible API. We inject the user's key
            // under OPENAI_API_KEY (the standard name for OpenAI-compatible APIs) and
            // ANTHROPIC_API_KEY for Claude-backed configurations. Kilo picks the right
            // one based on its model configuration.
            ...(this.options.apiKey
              ? {
                  OPENAI_API_KEY: this.options.apiKey,
                  ANTHROPIC_API_KEY: this.options.apiKey,
                  KILO_API_KEY: this.options.apiKey,
                }
              : {}),
          }),
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        if (!this.process.stdout || !this.process.stderr) {
          throw new Error('Failed to create stdio pipes');
        }

        // Handle stdout — Kilo JSON messages including Memory Bank events
        this.process.stdout.on('data', (data: Buffer) => {
          this.processStdout(data);
        });

        // Handle stderr — Kilo diagnostic messages
        this.process.stderr.on('data', (data: Buffer) => {
          const text = data.toString();
          logger.debug(`[KiloBackend] stderr: ${text.trim()}`);

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
          logger.debug(`[KiloBackend] Process exited with code: ${code}`);

          // Flush remaining buffer
          if (this.lineBuffer.trim()) {
            const msg = parseKiloJsonLine(this.lineBuffer);
            if (msg) {
              this.handleKiloMessage(msg);
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
              detail: `Kilo exited with code ${code}`,
            });
            reject(new Error(`Kilo exited with code ${code}`));
          }

          this.process = null;
        });

        // Handle process spawn errors (e.g., kilo binary not in PATH)
        // WHY (Phase 0.3 / SOC2 CC7.2): Surface friendly install hint on
        // ENOENT instead of raw "spawn ... ENOENT" Node error.
        this.process.on('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'ENOENT') {
            const message = formatInstallHint('kilo');
            logger.warn(`[KiloBackend] ${message}`);
            this.emit({ type: 'status', status: 'error', detail: message });
            reject(new Error(message));
            return;
          }
          logger.error(`[KiloBackend] Process error:`, err);
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
   * Cancel the current Kilo operation.
   *
   * WHY: When cancelling, we give Kilo 3 seconds to flush Memory Bank writes
   * before force-killing. This prevents partial Memory Bank updates that could
   * leave the project context in an inconsistent state.
   *
   * @param sessionId - The active session ID to cancel
   * @throws {Error} When session ID does not match the active session
   */
  async cancel(sessionId: SessionId): Promise<void> {
    if (sessionId !== this.sessionId) {
      throw new Error(`Invalid session ID: ${sessionId}`);
    }

    if (this.process) {
      logger.debug('[KiloBackend] Cancelling Kilo process');
      this.process.kill('SIGTERM');
      // WHY: Give Kilo 3 seconds to flush any pending Memory Bank writes to disk
      // before SIGKILL. A partial write could corrupt the project context on next
      // session start. The escalation timer is tracked by the base class so it is
      // cancelled on clean exit / dispose / double-cancel (SOC2 CC7.2).
      this.scheduleForceKill();
    }

    this.emit({ type: 'status', status: 'idle' });
  }

  /**
   * Respond to a Kilo permission request.
   *
   * Kilo may request permission for shell execution, file operations, or
   * Memory Bank writes to sensitive sections. We relay the user's decision
   * via stdin.
   *
   * @param requestId - The ID of the permission request from Kilo
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

  // waitForResponseComplete inherited from StreamingAgentBackendBase.

  /**
   * Clean up Kilo-specific state and defer the rest to the base class.
   *
   * WHY: Memory Bank read/write tracking is reset on dispose since it is
   * session-scoped state. A new backend instance starts with a clean slate.
   * Base dispose() handles the listener array, the cancel timer, and process
   * termination (SOC2 CC7.2 event-loop hygiene).
   */
  async dispose(): Promise<void> {
    this.memoryBankReads = [];
    this.memoryBankWrites = [];
    await super.dispose();
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a Kilo backend.
 *
 * Kilo is a community-driven AI coding agent with Memory Bank (persistent
 * project context) and support for 500+ models via OpenAI-compatible APIs.
 *
 * The kilo binary must be installed and available in PATH.
 * Install via: `npm install -g @kilocode/cli` (provides both `kilo` and
 * `kilocode` binaries; we invoke `kilo`).
 *
 * Memory Bank is enabled by default. Kilo stores memory files in
 * <cwd>/.kilo/memory/ (tracked in git, shared with the team).
 *
 * @param options - Configuration options for the backend
 * @returns KiloBackendResult with backend instance and resolved model
 *
 * @throws {Error} If kilo binary is not installed (deferred until sendPrompt is called)
 *
 * @example
 * ```ts
 * // Standard usage with Memory Bank enabled
 * const { backend } = createKiloBackend({
 *   cwd: '/path/to/project',
 *   model: 'gpt-4o',
 *   memoryBankEnabled: true,
 * });
 *
 * // With Ollama (local model, no API key needed)
 * const { backend } = createKiloBackend({
 *   cwd: '/path/to/project',
 *   model: 'ollama/llama3',
 *   apiBaseUrl: 'http://localhost:11434/v1',
 *   memoryBankEnabled: true,
 * });
 *
 * const { sessionId } = await backend.startSession();
 * await backend.sendPrompt(sessionId, 'Add authentication to the user service');
 * ```
 */
export function createKiloBackend(options: KiloBackendOptions): KiloBackendResult {
  logger.debug('[Kilo] Creating backend with options:', {
    cwd: options.cwd,
    model: options.model,
    hasApiKey: !!options.apiKey,
    apiBaseUrl: options.apiBaseUrl,
    memoryBankEnabled: options.memoryBankEnabled !== false,
    memoryBankPath: options.memoryBankPath,
    resumeSessionId: options.resumeSessionId,
  });

  return {
    backend: new KiloBackend(options),
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
 * Register the Kilo backend with the global agent registry.
 *
 * Call this during application initialization to make Kilo available
 * as an agent type. After calling this, `agentRegistry.create('kilo', opts)`
 * will return a configured KiloBackend instance.
 *
 * @example
 * ```ts
 * // In application startup (initializeAgents):
 * registerKiloAgent();
 * ```
 */
export function registerKiloAgent(): void {
  agentRegistry.register('kilo', (opts) => createKiloBackend(opts).backend);
  logger.debug('[Kilo] Registered with agent registry');
}
