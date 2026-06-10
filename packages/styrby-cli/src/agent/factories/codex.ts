/**
 * Codex Backend - OpenAI Codex CLI agent adapter
 *
 * Bridges the OpenAI Codex CLI to Styrby's universal {@link AgentBackend}
 * interface so `styrby start --agent codex` behaves identically to every other
 * managed agent (gemini, opencode, aider, ...): Styrby spawns Codex, streams its
 * output to the relay, and forwards mobile input back to it.
 *
 * WHY this wraps {@link CodexMcpClient} instead of extending
 * {@link StreamingAgentBackendBase}: Codex does NOT emit line-based stdout like
 * opencode/aider — it speaks MCP (JSON-RPC over stdio) via `codex mcp-server`.
 * `CodexMcpClient` already encapsulates that transport (version-aware subcommand
 * selection, `buildSafeEnv` so only OPENAI_API_KEY reaches the subprocess, full
 * session lifecycle). This backend is therefore a thin, seam-free ADAPTER: it
 * maps Codex's `codex/event` notifications onto our {@link AgentMessage} union
 * and translates Codex's elicitation-based tool approvals into our
 * `permission-request` / `respondToPermission` contract, which
 * {@link ApiSessionManager} relays to the mobile app exactly like other agents.
 *
 * The Codex event vocabulary handled here mirrors the standalone `runCodex.ts`
 * runner (the same `msg.type` values + field names), so behaviour is consistent
 * across both entry points.
 *
 * @module factories/codex
 */

import { randomUUID } from 'node:crypto';
import type {
  AgentBackend,
  SessionId,
  StartSessionResult,
  AgentFactoryOptions,
  AgentFactoryMetadata,
} from '../core';
import type { AgentMessage, AgentMessageHandler } from '../core/AgentBackend';
import { agentRegistry } from '../core';
import { CodexMcpClient } from '@/codex/codexMcpClient';
import type { CodexSessionConfig } from '@/codex/types';
import type { CodexPermissionResult } from '@/codex/permissionBridge';
import { logger } from '@/ui/logger';

/**
 * Options for creating a Codex backend.
 */
export interface CodexBackendOptions extends AgentFactoryOptions {
  /**
   * Model override (e.g. 'gpt-5-codex'). Defaults to Codex's configured model.
   */
  model?: string;

  /**
   * Filesystem sandbox Codex runs commands under.
   *
   * WHY default 'workspace-write': matches the safe-but-useful default the
   * `runCodex` permission mapping uses for normal mode — Codex may edit files
   * in the project but not touch the wider system. Override to 'read-only' for
   * a non-mutating session or 'danger-full-access' for unrestricted access.
   */
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';

  /**
   * When Codex asks before running a command.
   *
   * WHY default 'on-request': Codex decides which commands need approval and
   * surfaces those as elicitation requests, which this backend turns into
   * `permission-request` AgentMessages the user approves from mobile. 'never'
   * auto-runs everything (relies on the sandbox for safety); 'untrusted' asks
   * for every non-trusted command.
   */
  approvalPolicy?: 'untrusted' | 'on-failure' | 'on-request' | 'never';

  /** Extra base instructions prepended to the system prompt. */
  baseInstructions?: string;

  /** Whether to expose Codex's plan tool. */
  includePlanTool?: boolean;

  /** Named Codex profile from the user's config. */
  profile?: string;
}

/**
 * Result of creating a Codex backend.
 */
export interface CodexBackendResult {
  /** The backend instance, ready to start a session. */
  backend: AgentBackend;
  /** The resolved model (undefined = Codex default). */
  model: string | undefined;
  /** Capability / source metadata. */
  metadata: AgentFactoryMetadata;
}

/**
 * A pending tool-approval awaiting the user's decision.
 *
 * WHY: Codex requests command approval synchronously via an MCP elicitation
 * that `CodexMcpClient` awaits. We park that promise's resolver here, emit a
 * `permission-request` AgentMessage, and resolve it when `respondToPermission`
 * is later called with the relayed mobile decision.
 */
interface PendingApproval {
  resolve: (result: CodexPermissionResult) => void;
}

/**
 * Codex backend implementation.
 *
 * Implements {@link AgentBackend} directly (rather than via
 * {@link StreamingAgentBackendBase}) because the MCP transport is owned by
 * {@link CodexMcpClient}, not by a line-streamed subprocess.
 */
class CodexBackend implements AgentBackend {
  private readonly client = new CodexMcpClient();
  private readonly listeners: AgentMessageHandler[] = [];
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private sessionId: SessionId | null = null;
  private abortController: AbortController | null = null;
  private disposed = false;

  constructor(private readonly options: CodexBackendOptions) {
    // Bridge Codex's elicitation-based approvals into our permission contract.
    // CodexMcpClient calls handleToolCall(callId, toolName, input) and awaits a
    // PermissionResult; we surface the request as a `permission-request`
    // AgentMessage and defer resolution to respondToPermission().
    this.client.setPermissionHandler({
      handleToolCall: (toolCallId, toolName, input) =>
        new Promise<CodexPermissionResult>((resolve) => {
          this.pendingApprovals.set(toolCallId, { resolve });
          this.emit({
            type: 'permission-request',
            id: toolCallId,
            reason: `Codex wants to run: ${toolName}`,
            payload: input,
          });
        }),
    });

    // Map every Codex MCP event onto an AgentMessage.
    this.client.setHandler((raw) => this.handleCodexEvent(raw));
  }

  /**
   * Start a Codex session, optionally with an initial prompt.
   *
   * @param initialPrompt - First prompt for the session (Codex requires a
   *   prompt to create a conversation; we send a no-op space if none is given
   *   so the session id is established before the first real prompt).
   * @returns The session id (Codex's own id once known, else a local UUID).
   */
  async startSession(initialPrompt?: string): Promise<StartSessionResult> {
    this.abortController = new AbortController();
    this.emit({ type: 'status', status: 'starting' });

    const config: CodexSessionConfig = {
      prompt: initialPrompt ?? '',
      cwd: this.options.cwd,
      sandbox: this.options.sandbox ?? 'workspace-write',
      'approval-policy': this.options.approvalPolicy ?? 'on-request',
      ...(this.options.model ? { model: this.options.model } : {}),
      ...(this.options.profile ? { profile: this.options.profile } : {}),
      ...(this.options.baseInstructions
        ? { 'base-instructions': this.options.baseInstructions }
        : {}),
      ...(this.options.includePlanTool ? { 'include-plan-tool': true } : {}),
    };

    await this.client.startSession(config, { signal: this.abortController.signal });

    // Codex's session id is discovered from the response/events; fall back to a
    // local UUID so the caller always has a stable handle for this session.
    this.sessionId = this.client.getSessionId() ?? randomUUID();
    this.emit({ type: 'status', status: 'running' });
    return { sessionId: this.sessionId };
  }

  /**
   * Send a follow-up prompt to the active Codex session.
   *
   * @param _sessionId - Accepted for interface parity; Codex tracks the active
   *   conversation internally via {@link CodexMcpClient}.
   * @param prompt - The user's prompt text.
   */
  async sendPrompt(_sessionId: SessionId, prompt: string): Promise<void> {
    if (this.disposed) throw new Error('CodexBackend is disposed');
    this.abortController = new AbortController();
    await this.client.continueSession(prompt, { signal: this.abortController.signal });
  }

  /**
   * Cancel the in-flight Codex turn while keeping the session resumable.
   *
   * @param _sessionId - Accepted for interface parity.
   */
  async cancel(_sessionId: SessionId): Promise<void> {
    this.abortController?.abort();
    this.client.storeSessionForResume();
    this.emit({ type: 'status', status: 'idle', detail: 'cancelled' });
  }

  /**
   * Respond to a pending tool-approval request.
   *
   * @param requestId - The Codex call id from the `permission-request` message.
   * @param approved - Whether the user approved the command.
   */
  async respondToPermission(requestId: string, approved: boolean): Promise<void> {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) {
      logger.debug('[CodexBackend] respondToPermission: no pending request', { requestId });
      return;
    }
    this.pendingApprovals.delete(requestId);
    pending.resolve({ decision: approved ? 'approved' : 'denied' });
    this.emit({ type: 'permission-response', id: requestId, approved });
  }

  /**
   * Register a handler for agent messages.
   *
   * @param handler - Called for each {@link AgentMessage} the backend emits.
   */
  onMessage(handler: AgentMessageHandler): void {
    this.listeners.push(handler);
  }

  /**
   * Remove a previously registered message handler.
   *
   * @param handler - The handler to remove.
   */
  offMessage(handler: AgentMessageHandler): void {
    const i = this.listeners.indexOf(handler);
    if (i !== -1) this.listeners.splice(i, 1);
  }

  /**
   * Tear down the Codex subprocess and reject any unresolved approvals.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.abortController?.abort();
    // Deny any outstanding approvals so awaited promises never hang.
    for (const [, pending] of this.pendingApprovals) {
      pending.resolve({ decision: 'denied' });
    }
    this.pendingApprovals.clear();
    await this.client.forceCloseSession();
    this.emit({ type: 'status', status: 'stopped' });
    this.listeners.length = 0;
  }

  /**
   * Emit an {@link AgentMessage} to every registered listener.
   *
   * A throwing listener must not stop delivery to the others, so each call is
   * isolated.
   */
  private emit(msg: AgentMessage): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(msg);
      } catch (error) {
        logger.debug('[CodexBackend] message handler threw', { error });
      }
    }
  }

  /**
   * Translate one Codex `codex/event` payload into an {@link AgentMessage}.
   *
   * Field names mirror `runCodex.ts` so the two entry points stay consistent.
   */
  private handleCodexEvent(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    const msg = raw as Record<string, any>;

    switch (msg.type) {
      case 'agent_message':
        this.emit({ type: 'model-output', fullText: String(msg.message ?? '') });
        return;
      case 'agent_message_delta':
        this.emit({ type: 'model-output', textDelta: String(msg.delta ?? '') });
        return;
      case 'agent_reasoning_delta':
        this.emit({ type: 'event', name: 'reasoning-delta', payload: { delta: msg.delta } });
        return;
      case 'agent_reasoning':
        this.emit({ type: 'event', name: 'reasoning', payload: { text: msg.text } });
        return;
      case 'exec_command_begin': {
        const { call_id, type: _t, ...rest } = msg;
        this.emit({
          type: 'tool-call',
          toolName: 'shell',
          args: { command: msg.command, ...rest },
          callId: String(call_id),
        });
        return;
      }
      case 'exec_approval_request': {
        // Strip codex's own `type` from the rest-spread so it can't clobber our
        // AgentMessage discriminant.
        const { call_id, type: _t, ...rest } = msg;
        this.emit({ type: 'exec-approval-request', call_id: String(call_id), ...rest });
        return;
      }
      case 'exec_command_end': {
        const { call_id, type: _t, ...output } = msg;
        this.emit({
          type: 'tool-result',
          toolName: 'shell',
          result: output,
          callId: String(call_id),
        });
        return;
      }
      case 'patch_apply_begin':
        this.emit({
          type: 'patch-apply-begin',
          call_id: String(msg.call_id),
          auto_approved: Boolean(msg.auto_approved),
          changes: (msg.changes ?? {}) as Record<string, unknown>,
        });
        return;
      case 'patch_apply_end':
        this.emit({
          type: 'patch-apply-end',
          call_id: String(msg.call_id),
          stdout: msg.stdout,
          stderr: msg.stderr,
          success: Boolean(msg.success),
        });
        return;
      case 'turn_diff':
        if (msg.unified_diff) {
          this.emit({ type: 'fs-edit', description: 'Codex applied changes', diff: msg.unified_diff });
        }
        return;
      case 'token_count':
        // Spread first, then pin our discriminant so codex's `type:'token_count'`
        // cannot overwrite it.
        this.emit({ ...msg, type: 'token-count' });
        return;
      case 'task_started':
        this.emit({ type: 'status', status: 'running' });
        return;
      case 'task_complete':
        this.emit({ type: 'status', status: 'idle' });
        return;
      case 'turn_aborted':
        this.emit({ type: 'status', status: 'idle', detail: 'turn_aborted' });
        return;
      default:
        // Unknown event types are forwarded as generic events rather than
        // dropped, so new Codex event kinds remain visible without a code change.
        this.emit({ type: 'event', name: String(msg.type ?? 'codex-event'), payload: msg });
    }
  }
}

/**
 * Create a Codex backend.
 *
 * @param options - Configuration options (cwd is required).
 * @returns The backend plus resolved model + capability metadata.
 *
 * @example
 * ```ts
 * const { backend } = createCodexBackend({ cwd: '/path/to/project' });
 * const { sessionId } = await backend.startSession('Fix the failing test');
 * ```
 */
export function createCodexBackend(options: CodexBackendOptions): CodexBackendResult {
  logger.debug('[CodexBackend] Creating backend', {
    cwd: options.cwd,
    model: options.model,
    sandbox: options.sandbox ?? 'workspace-write',
  });

  return {
    backend: new CodexBackend(options),
    model: options.model,
    metadata: {
      modelSource: options.model ? 'explicit' : 'default',
      supportsStreaming: true,
      supportsTools: true,
    },
  };
}

/**
 * Register the Codex backend with the global agent registry.
 *
 * Called from `initializeAgents()` so `styrby start --agent codex` resolves to
 * a real, managed backend.
 */
export function registerCodexAgent(): void {
  agentRegistry.register('codex', (opts) => createCodexBackend(opts).backend);
  logger.debug('[CodexBackend] Registered with agent registry');
}
