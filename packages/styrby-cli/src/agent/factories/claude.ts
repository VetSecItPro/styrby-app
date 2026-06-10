/**
 * Claude Cost Factory — JSONL-path CostReport emitter
 *
 * This module provides helpers to parse Claude Code JSONL output lines and
 * emit unified {@link CostReport} events. It covers the structured JSONL path
 * only — the brittle regex in `cost-extractor.ts#parseClaudeOutput` is NOT
 * touched here (that is PR-D gap-fix work).
 *
 * Auth-mode detection:
 *   - Reads `~/.claude/auth.json` for a `subscriptionType` field.
 *   - If found and matches Max/Pro → `billingModel: 'subscription'`, `costUsd: 0`.
 *   - If the file is missing or the field is absent → default to `'api-key'`.
 *   - Detection failure is logged at DEBUG level, never a hard error.
 *
 * Usage:
 * ```ts
 * // Detect billing model once at session start
 * const billingModel = detectClaudeBillingModel();
 *
 * // For each JSONL line from Claude Code stdout:
 * const report = parseClaudeJsonlLine(line, sessionId, billingModel);
 * if (report) backend.emit({ type: 'cost-report', report });
 * ```
 *
 * @module factories/claude
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import { logger } from '@/ui/logger';
import type { CostReport, BillingModel } from '@styrby/shared/cost';
import type {
  SessionId,
  StartSessionResult,
  AgentFactoryOptions,
  AgentFactoryMetadata,
} from '../core';
import { agentRegistry } from '../core';
import { StreamingAgentBackendBase } from '../StreamingAgentBackendBase';
import {
  startClaudePermissionServer,
  PERMISSION_MCP_SERVER_NAME,
  PERMISSION_PROMPT_TOOL_ID,
  type RunningPermissionServer,
  type PermissionDecision,
} from './claudePermissionServer';

// ============================================================================
// Auth Mode Detection
// ============================================================================

/**
 * Subscription type strings written by Claude Code to `~/.claude/auth.json`.
 *
 * WHY: Claude Max and Claude Pro are flat-rate plans — costUsd must be 0
 * for subscription sessions. We detect the plan from the auth file so the
 * cost dashboard shows subscription users $0 instead of a phantom API cost.
 */
const CLAUDE_SUBSCRIPTION_TYPES = new Set(['max', 'pro', 'claude_max', 'claude_pro']);

/**
 * Detect the Claude Code billing model by inspecting `~/.claude/auth.json`.
 *
 * WHY: Claude Code writes auth state (including subscription tier) to a
 * local JSON file. Checking it at session start lets us classify cost events
 * without requiring an extra API call.
 *
 * Falls back to `'api-key'` if the file is missing, unreadable, or does not
 * contain a recognisable `subscriptionType` field. This is intentional:
 * missing detection is Phase 1.6.1 PR-D's problem, not PR-C's.
 *
 * @returns `'subscription'` for Claude Max/Pro users; `'api-key'` otherwise.
 */
export function detectClaudeBillingModel(): BillingModel {
  const authJsonPath = path.join(os.homedir(), '.claude', 'auth.json');
  try {
    if (!fs.existsSync(authJsonPath)) {
      logger.debug('[ClaudeFactory] ~/.claude/auth.json not found — defaulting to api-key billing');
      return 'api-key';
    }

    const raw = fs.readFileSync(authJsonPath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const subType = (parsed.subscriptionType as string | undefined)?.toLowerCase() ?? '';

    if (CLAUDE_SUBSCRIPTION_TYPES.has(subType)) {
      logger.debug(`[ClaudeFactory] Detected subscription billing model: ${subType}`);
      return 'subscription';
    }

    logger.debug(`[ClaudeFactory] subscriptionType="${subType}" not recognised — defaulting to api-key`);
    return 'api-key';
  } catch (err) {
    logger.debug('[ClaudeFactory] Could not read ~/.claude/auth.json — defaulting to api-key billing', err);
    return 'api-key';
  }
}

/**
 * Map the Claude Code stream-json `apiKeySource` to a billing model.
 *
 * This is the AUTHORITATIVE billing signal for a managed session, replacing the
 * stale {@link detectClaudeBillingModel} heuristic: modern claude (2.1.x) no
 * longer writes a `subscriptionType` to `~/.claude/auth.json` (auth moved to the
 * keychain / `.credentials.json`), so the file-read mislabeled subscription
 * users as `api-key`. The init line's `apiKeySource` reflects the actual session.
 *
 * @param apiKeySource - The `apiKeySource` field from the system/init line.
 *   `'none'` means no API key is configured — the session runs on the user's
 *   Claude subscription. Any other value (`'user'` / `'project'` / `'org'` /
 *   `'apiKey'` / …) means an API key is in use.
 * @returns `'subscription'` when `apiKeySource` is `'none'`, otherwise `'api-key'`.
 */
export function billingModelFromApiKeySource(apiKeySource: string | undefined): BillingModel {
  return apiKeySource === 'none' ? 'subscription' : 'api-key';
}

// ============================================================================
// JSONL Parser
// ============================================================================

/**
 * Parsed shape of a Claude Code JSONL assistant message.
 *
 * WHY: Claude Code emits JSONL lines where assistant messages include a
 * `message.usage` block with token counts. Typing this explicitly lets TypeScript
 * catch format regressions at compile time.
 */
interface ClaudeJsonlAssistantMessage {
  type: 'assistant';
  timestamp?: string;
  message?: {
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
}

/**
 * Parse a single Claude Code JSONL output line and return a {@link CostReport}.
 *
 * This is the structured JSONL path — it handles `{ type: "assistant", message.usage }`.
 * The brittle regex (`parseClaudeOutput` in `cost-extractor.ts`) is left untouched.
 *
 * WHY: The structured JSONL path is the preferred extraction method because it
 * directly reads the typed `usage` block rather than regex-scanning raw text.
 * This parser is called per line by the JSONL file-watcher in cost-extractor.ts.
 *
 * @param line - A single JSONL line from Claude Code's streaming output
 * @param sessionId - The Supabase session UUID to attach to the report
 * @param billingModel - Pre-detected billing model for this Claude session
 * @returns A {@link CostReport} if the line contains token usage, or `null` otherwise
 *
 * @example
 * const billing = detectClaudeBillingModel();
 * const report = parseClaudeJsonlLine(line, 'uuid-...', billing);
 * if (report) emitter.emit({ type: 'cost-report', report });
 */
export function parseClaudeJsonlLine(
  line: string,
  sessionId: string,
  billingModel: BillingModel
): CostReport | null {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith('{')) return null;

  let data: ClaudeJsonlAssistantMessage;
  try {
    data = JSON.parse(trimmed) as ClaudeJsonlAssistantMessage;
  } catch {
    return null;
  }

  // Only assistant messages carry usage data
  if (data.type !== 'assistant' || !data.message?.usage) return null;

  const usage = data.message.usage;
  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
  const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0;
  const model = data.message.model ?? 'unknown';

  // WHY: Subscription billing (Claude Max/Pro) has zero marginal cost per request.
  // We still store the token counts for usage monitoring but must not report a USD cost.
  const costUsd = billingModel === 'subscription' ? 0 : 0; // USD cost unknown from JSONL alone — set to 0; cost-reporter may enrich via pricing table

  const rawPayload: Record<string, unknown> = {
    type: data.type,
    model,
    usage: usage as unknown as Record<string, unknown>,
  };

  const report: CostReport = {
    sessionId,
    messageId: null,
    agentType: 'claude',
    model,
    timestamp: data.timestamp ?? new Date().toISOString(),
    source: 'agent-reported',
    billingModel,
    costUsd,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    ...(billingModel === 'subscription'
      ? {
          subscriptionUsage: {
            fractionUsed: null, // Claude Code does not expose quota fraction
            rawSignal: null,
          },
        }
      : {}),
    rawAgentPayload: rawPayload,
  };

  return report;
}

// ============================================================================
// Claude Backend (managed binary-spawn, stream-json)
// ============================================================================

/**
 * Permission mode passed to the `claude` CLI for a managed session.
 *
 * WHY default 'acceptEdits': a remote-controlled session runs unattended, so it
 * must not block on interactive prompts; 'acceptEdits' lets Claude apply file
 * edits while the sandbox/allowlist still governs riskier actions. Override via
 * options for a stricter ('plan') or looser ('bypassPermissions') posture.
 */
export type ClaudePermissionMode =
  | 'acceptEdits'
  | 'auto'
  | 'plan'
  | 'default'
  | 'bypassPermissions';

/**
 * Options for creating a Claude backend.
 */
export interface ClaudeBackendOptions extends AgentFactoryOptions {
  /** Model alias/id for the session (e.g. 'claude-sonnet-4-6'). */
  model?: string;
  /** Permission mode for the headless session (default 'acceptEdits'). */
  permissionMode?: ClaudePermissionMode;
  /** Claude session id to resume (preserves conversation context across prompts). */
  resumeSessionId?: string;
  /** Tool allowlist (e.g. ['Bash(git *)', 'Read']). */
  allowedTools?: string[];
  /**
   * Route every gated tool-use to the paired mobile device for an inline
   * approve/deny decision (default `true`).
   *
   * WHY default on: this is the premium behavior — claude pauses at each
   * non-allowlisted tool and asks, the same as Codex. When `true` the backend
   * spawns claude with `--permission-mode default` + a `--permission-prompt-tool`
   * pointed at an in-process MCP server (see {@link ClaudeBackend}). Set `false`
   * for unattended/automation sessions that should run on a fixed
   * {@link permissionMode} ('acceptEdits'/'bypassPermissions') without prompting.
   * Tools in {@link allowedTools} are pre-approved and never prompt.
   */
  interactivePermissions?: boolean;
  /**
   * Per-tool approval timeout in ms (default 240000 = 4 min). On timeout the
   * decision FAILS CLOSED (deny) so a tool never runs without an explicit
   * approval and claude is never left blocked indefinitely.
   */
  permissionTimeoutMs?: number;
  /**
   * Tool names routed to mobile approval when {@link interactivePermissions} is
   * on (default {@link DEFAULT_GATED_TOOLS}). Passed as claude's
   * `permissions.ask` list so they prompt even if the user's local settings
   * allow them. Read-only tools omitted here stay auto-allowed.
   */
  gatedTools?: string[];
  /** Extra `claude` CLI args (validated for shell-safety by the base class). */
  extraArgs?: string[];
}

/**
 * Result of creating a Claude backend.
 */
export interface ClaudeBackendResult {
  /** The backend instance, ready to start a session. */
  backend: ClaudeBackend;
  /** The resolved model (undefined = Claude's configured default). */
  model: string | undefined;
  /** Capability / source metadata. */
  metadata: AgentFactoryMetadata;
}

/**
 * A single Claude Code stream-json line.
 *
 * Claude emits newline-delimited JSON in `--output-format stream-json` mode: a
 * `system`/init line (carries the resumable `session_id`), one or more
 * `assistant`/`user` lines (message content + tool use/results), and a final
 * `result` line. Typed loosely because only a subset of fields is consumed.
 */
interface ClaudeStreamMessage {
  type: 'system' | 'assistant' | 'user' | 'result' | string;
  subtype?: string;
  session_id?: string;
  /** Present on the system/init line: 'none' = subscription, else api-key. */
  apiKeySource?: string;
  message?: {
    role?: string;
    content?: Array<{
      type: string;
      text?: string;
      name?: string;
      input?: Record<string, unknown>;
      id?: string;
      tool_use_id?: string;
      content?: unknown;
    }>;
  };
}

/** Claude tool names that mutate files (for fs-edit surfacing). */
const CLAUDE_EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/**
 * Tools routed to mobile approval by default in interactive sessions.
 *
 * WHY this set: these are the side-effecting / external tools (mutate the repo,
 * run shell, reach the network). Read-only tools (Read/Glob/Grep) are left
 * auto-allowed so a remote session is not death-by-a-thousand-prompts. Override
 * via {@link ClaudeBackendOptions.gatedTools}.
 *
 * WHY a `permissions.ask` list (not just --permission-prompt-tool): claude only
 * consults the permission-prompt tool for a tool-use that its rules don't
 * already allow/deny. A user's `~/.claude/settings.json` `allow` list (e.g.
 * `Bash(*)`) would otherwise auto-approve and silently bypass mobile approval.
 * Permission precedence is deny > ask > allow, so putting these tools in `ask`
 * (passed via --settings) forces the prompt -> our tool -> mobile, regardless of
 * the user's local allow list. Verified live against claude 2.1.169.
 */
const DEFAULT_GATED_TOOLS = ['Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch'];

/**
 * Claude Code backend — clean-room managed spawn of the `claude` binary.
 *
 * WHY this reimplements the spawn technique instead of wrapping Happy's
 * `src/claude/` loop: that loop (`runClaude`/`loop`/`session`) imports
 * `ApiClient`/`AgentState` symbols deleted in the Supabase relay refactor, so it
 * is stale, broken, and quarantined from typechecking. Reusing it would drag
 * ~6.8k LOC of dead code into the build (a large seam). Instead we spawn the
 * `claude` binary in headless stream-json mode and parse its JSONL — the same
 * line-based pattern {@link StreamingAgentBackendBase} already powers for
 * opencode/aider.
 *
 * WHY binary-spawn (not the official Agent SDK): spawning the user's installed
 * `claude` runs against their `~/.claude/auth.json`, preserving Max/Pro
 * SUBSCRIPTION billing (costUsd=0). The Agent SDK expects API-key auth and a
 * separate credit pool, which would be a cost regression for subscription users.
 */
export class ClaudeBackend extends StreamingAgentBackendBase {
  protected readonly logTag = 'ClaudeBackend';

  /** Claude's own session id, captured from the init line; used for --resume. */
  private claudeSessionId: string | null;
  /**
   * Billing model for cost reports. Seeded from the (stale) auth.json heuristic,
   * then corrected to the authoritative value from the stream-json `apiKeySource`
   * once the system/init line arrives (see handleLine).
   */
  private billingModel: BillingModel;

  /** Whether per-tool decisions are routed to mobile (see options). */
  private readonly interactivePermissions: boolean;
  /** Per-tool approval timeout (fail-closed deny). */
  private readonly permissionTimeoutMs: number;
  /**
   * Parked approval promises keyed by request id (claude's tool_use id, or a
   * generated id). Resolved by {@link respondToPermission} with the relayed
   * mobile decision — the same park-and-resolve pattern CodexBackend uses.
   */
  private readonly pendingApprovals = new Map<string, (d: PermissionDecision) => void>();
  /** In-process MCP server hosting the permission-prompt tool (lazy). */
  private permissionServer: RunningPermissionServer | null = null;
  /** Temp `--mcp-config` file path registering the permission server (lazy). */
  private mcpConfigPath: string | null = null;

  constructor(private readonly options: ClaudeBackendOptions) {
    super();
    // Detect subscription vs api-key once so every cost-report is classified
    // correctly (subscription => costUsd 0).
    this.billingModel = detectClaudeBillingModel();
    this.claudeSessionId = options.resumeSessionId ?? null;
    this.interactivePermissions = options.interactivePermissions ?? true;
    this.permissionTimeoutMs = options.permissionTimeoutMs ?? 240_000;
  }

  /**
   * Start a Claude session, optionally with an initial prompt.
   *
   * @param initialPrompt - First prompt; when omitted the backend idles until
   *   the first {@link sendPrompt}.
   * @returns The local session id (a UUID; Claude's own id is tracked internally
   *   for --resume continuity).
   */
  async startSession(initialPrompt?: string): Promise<StartSessionResult> {
    if (this.disposed) throw new Error('ClaudeBackend has been disposed');
    this.sessionId = randomUUID();
    this.emit({ type: 'status', status: 'starting' });

    if (initialPrompt) {
      this.emit({ type: 'status', status: 'running' });
      await this.sendPrompt(this.sessionId, initialPrompt);
    } else {
      this.emit({ type: 'status', status: 'idle' });
    }
    return { sessionId: this.sessionId };
  }

  /**
   * Send a prompt to the Claude session.
   *
   * Spawns `claude -p <prompt> --output-format stream-json --verbose`, resuming
   * the prior Claude conversation (via `--resume`) so context carries across
   * prompts. Resolves when the process exits cleanly (or was cancelled).
   *
   * @param sessionId - Must match the active session id.
   * @param prompt - The user's prompt text.
   */
  async sendPrompt(sessionId: SessionId, prompt: string): Promise<void> {
    if (this.disposed) throw new Error('ClaudeBackend has been disposed');
    if (sessionId !== this.sessionId) throw new Error(`Invalid session ID: ${sessionId}`);

    // Reset run-scoped state (clears the cancelled flag) so this run's exit is
    // classified correctly by the close handler.
    this.beginRun();
    this.emit({ type: 'status', status: 'running' });

    const args: string[] = [
      '-p',
      prompt,
      '--output-format',
      'stream-json',
      // --verbose is required for stream-json to emit the full event stream in
      // print mode (otherwise only the final result is printed).
      '--verbose',
    ];

    if (this.interactivePermissions) {
      // Interactive per-tool approval: claude runs in 'default' mode (which gates
      // tools) and routes every gated decision to our in-process permission MCP
      // server via --permission-prompt-tool. The server's handler calls
      // this.decide() -> emits permission-request -> awaits the mobile response.
      // --strict-mcp-config keeps claude from also loading the user's own MCP
      // servers (we only want ours for the prompt hook).
      await this.ensurePermissionServer();
      // WHY --settings with a permissions.ask list: forces the gated tools to
      // prompt even if the user's ~/.claude/settings.json allows them (ask >
      // allow). The prompt is delegated to our --permission-prompt-tool. Inline
      // JSON (not a file) since spawn() passes args without a shell.
      const gated = this.options.gatedTools ?? DEFAULT_GATED_TOOLS;
      const settings = JSON.stringify({
        permissions: { defaultMode: 'default', ask: gated, allow: [], deny: [] },
      });
      args.push(
        '--permission-mode',
        'default',
        '--settings',
        settings,
        '--mcp-config',
        this.mcpConfigPath as string,
        '--strict-mcp-config',
        '--permission-prompt-tool',
        PERMISSION_PROMPT_TOOL_ID,
      );
    } else {
      // Unattended/automation: fixed permission mode, no prompting.
      args.push('--permission-mode', this.options.permissionMode ?? 'acceptEdits');
    }

    if (this.options.model) args.push('--model', this.options.model);
    if (this.claudeSessionId) args.push('--resume', this.claudeSessionId);
    if (this.options.allowedTools?.length) {
      args.push('--allowedTools', this.options.allowedTools.join(','));
    }

    return new Promise<void>((resolve, reject) => {
      const child = this.spawnAgent({
        command: 'claude',
        args,
        cwd: this.options.cwd,
        extraEnv: this.options.env,
        userExtraArgs: this.options.extraArgs,
        // The prompt is passed via `-p`, not stdin. Ignore stdin so claude
        // doesn't wait ~3s for input that never comes ("no stdin data received
        // in 3s") before each turn. stdout/stderr stay piped for streamLines().
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      if (child.stdout) {
        this.streamLines(child.stdout, (line) => this.handleLine(line));
      }
      if (child.stderr) {
        child.stderr.on('data', (data: Buffer) => {
          logger.debug(`[ClaudeBackend] stderr: ${data.toString().trim()}`);
        });
      }

      child.on('close', (code) => {
        logger.debug(`[ClaudeBackend] Process exited with code: ${code}`);
        this.process = null;
        this.clearCancelTimer();
        if (code === 0 || this.wasCancelled()) {
          this.emit({ type: 'status', status: 'idle' });
          resolve();
        } else {
          const detail = `Claude exited with code ${code}`;
          this.emit({ type: 'status', status: 'error', detail });
          reject(new Error(detail));
        }
      });

      // ENOENT -> friendly install hint; other spawn errors forwarded.
      this.attachInstallHintErrorHandler(child, 'claude', reject);
    });
  }

  /**
   * Cancel the in-flight prompt (SIGTERM, then SIGKILL escalation via the base).
   *
   * @param sessionId - Must match the active session id.
   */
  async cancel(sessionId: SessionId): Promise<void> {
    if (sessionId !== this.sessionId) throw new Error(`Invalid session ID: ${sessionId}`);
    if (this.process) {
      // Mark cancelled BEFORE SIGTERM so the close handler treats the resulting
      // non-zero exit as an intentional cancel, not a crash.
      this.markCancelled();
      this.process.kill('SIGTERM');
      this.scheduleForceKill();
    }
    this.emit({ type: 'status', status: 'idle' });
  }

  /**
   * Parse one stream-json line: emit a cost-report if it carries usage, then map
   * its content to {@link AgentMessage}s.
   */
  private handleLine(line: string): void {
    if (!line.trim()) return;

    // Cost extraction (assistant lines with a usage block) reuses the shared
    // parser so subscription billing stays correct.
    const report = parseClaudeJsonlLine(line, this.sessionId ?? '', this.billingModel);
    if (report) this.emit({ type: 'cost-report', report });

    let msg: ClaudeStreamMessage;
    try {
      msg = JSON.parse(line) as ClaudeStreamMessage;
    } catch {
      logger.debug('[ClaudeBackend] Non-JSON stdout line ignored');
      return;
    }

    // Capture Claude's session id from any line that carries it so follow-up
    // prompts can --resume the same conversation.
    if (typeof msg.session_id === 'string') this.claudeSessionId = msg.session_id;

    // Authoritative billing detection: the system/init line carries `apiKeySource`.
    // 'none' means no API key — the session runs on the user's Claude subscription
    // (costUsd 0). Any other value means an API key is in use (api-key billing).
    // This corrects the constructor's detectClaudeBillingModel() seed, whose
    // ~/.claude/auth.json heuristic is stale (modern claude stores auth elsewhere,
    // so subscription users were mislabeled api-key).
    if (typeof msg.apiKeySource === 'string') {
      this.billingModel = billingModelFromApiKeySource(msg.apiKeySource);
    }

    switch (msg.type) {
      case 'assistant':
        for (const block of msg.message?.content ?? []) {
          if (block.type === 'text' && block.text) {
            this.emit({ type: 'model-output', fullText: block.text });
          } else if (block.type === 'tool_use' && block.id) {
            this.emit({
              type: 'tool-call',
              toolName: block.name ?? 'unknown',
              args: block.input ?? {},
              callId: block.id,
            });
            // Surface file mutations so the mobile UI can show a diff affordance.
            if (block.name && CLAUDE_EDIT_TOOLS.has(block.name)) {
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
        // Claude echoes tool results back as a user message.
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
   * Lazily start the in-process permission MCP server and write its
   * `--mcp-config` file. Idempotent: reused across prompts in the same session,
   * torn down in {@link dispose}.
   */
  private async ensurePermissionServer(): Promise<void> {
    if (this.permissionServer) return;
    this.permissionServer = await startClaudePermissionServer((toolName, input, toolUseId) =>
      this.decide(toolName, input, toolUseId),
    );
    // Register the in-process server as an HTTP MCP server claude connects to.
    const config = {
      mcpServers: {
        [PERMISSION_MCP_SERVER_NAME]: { type: 'http', url: this.permissionServer.url },
      },
    };
    this.mcpConfigPath = path.join(os.tmpdir(), `styrby-claude-mcp-${randomUUID()}.json`);
    fs.writeFileSync(this.mcpConfigPath, JSON.stringify(config), 'utf8');
    logger.debug(`[ClaudeBackend] permission MCP config at ${this.mcpConfigPath}`);
  }

  /**
   * Decide whether claude may use a tool. Emits a `permission-request` and parks
   * a promise resolved by {@link respondToPermission} when the mobile decision
   * arrives. Fails CLOSED (deny) after {@link permissionTimeoutMs} so a tool is
   * never auto-run and claude is never blocked indefinitely.
   *
   * @param toolName - The claude tool awaiting approval (e.g. 'Bash').
   * @param input - The tool's input arguments (surfaced to mobile).
   * @param toolUseId - Claude's tool_use id when present; the correlation key.
   * @returns The decision once relayed back (or a timeout deny).
   */
  private decide(
    toolName: string,
    input: Record<string, unknown>,
    toolUseId: string | undefined,
  ): Promise<PermissionDecision> {
    const id = toolUseId ?? randomUUID();
    return new Promise<PermissionDecision>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pendingApprovals.delete(id)) {
          this.emit({ type: 'permission-response', id, approved: false });
          resolve({ approved: false, message: 'Approval timed out' });
        }
      }, this.permissionTimeoutMs);
      // Unref so a pending approval timer never keeps the event loop alive on
      // shutdown (dispose drains pending approvals explicitly).
      timer.unref?.();

      this.pendingApprovals.set(id, (decision) => {
        clearTimeout(timer);
        resolve(decision);
      });
      this.emit({
        type: 'permission-request',
        id,
        reason: `Claude wants to run: ${toolName}`,
        payload: input,
      });
    });
  }

  /**
   * Resolve a parked per-tool approval with the relayed mobile decision.
   *
   * Mirrors CodexBackend: look up the pending request by id, resolve its promise
   * (unblocking the MCP permission-prompt handler so claude proceeds or skips the
   * tool), and emit a `permission-response` for UI/analytics. Falls back to the
   * base emit-only behavior when no request is parked (e.g. a non-interactive
   * session, or a late/duplicate response).
   *
   * @param requestId - The id from the `permission-request` message.
   * @param approved - Whether the user approved the tool.
   */
  override async respondToPermission(requestId: string, approved: boolean): Promise<void> {
    const resolve = this.pendingApprovals.get(requestId);
    if (resolve) {
      this.pendingApprovals.delete(requestId);
      resolve({ approved });
      this.emit({ type: 'permission-response', id: requestId, approved });
      return;
    }
    await super.respondToPermission(requestId, approved);
  }

  /**
   * Tear down the permission server, remove its temp config, and deny any
   * still-parked approvals so a blocked claude process can exit cleanly.
   */
  override async dispose(): Promise<void> {
    // Deny outstanding approvals first so the MCP handlers return (allowing claude
    // to finish) before we kill the server + child in super.dispose().
    for (const resolve of this.pendingApprovals.values()) {
      resolve({ approved: false, message: 'Session ended' });
    }
    this.pendingApprovals.clear();

    if (this.permissionServer) {
      try {
        await this.permissionServer.close();
      } catch {
        /* best-effort teardown */
      }
      this.permissionServer = null;
    }
    if (this.mcpConfigPath) {
      try {
        fs.rmSync(this.mcpConfigPath, { force: true });
      } catch {
        /* best-effort cleanup */
      }
      this.mcpConfigPath = null;
    }

    await super.dispose();
  }
}

/**
 * Create a Claude backend.
 *
 * @param options - Configuration options (cwd is required).
 * @returns The backend plus resolved model + capability metadata.
 *
 * @example
 * ```ts
 * const { backend } = createClaudeBackend({ cwd: '/path/to/project' });
 * const { sessionId } = await backend.startSession('Explain this repo');
 * ```
 */
export function createClaudeBackend(options: ClaudeBackendOptions): ClaudeBackendResult {
  logger.debug('[ClaudeBackend] Creating backend', {
    cwd: options.cwd,
    model: options.model,
    interactivePermissions: options.interactivePermissions ?? true,
    permissionMode: options.permissionMode ?? 'acceptEdits',
  });

  return {
    backend: new ClaudeBackend(options),
    model: options.model,
    metadata: {
      modelSource: options.model ? 'explicit' : 'default',
      supportsStreaming: true,
      supportsTools: true,
    },
  };
}

/**
 * Register the Claude backend with the global agent registry.
 *
 * Called from `initializeAgents()` so `styrby start --agent claude` resolves to
 * a managed, relay-bridged session instead of the old informational MCP stub.
 */
export function registerClaudeAgent(): void {
  agentRegistry.register('claude', (opts) => createClaudeBackend(opts).backend);
  logger.debug('[ClaudeBackend] Registered with agent registry');
}
