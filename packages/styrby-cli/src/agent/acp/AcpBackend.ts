/**
 * AcpBackend - Agent Client Protocol backend (thin coordinator).
 *
 * Concerns are split into sibling modules: acpTypes, streamBridge, retryHelper,
 * errorFormatting, permissionHandling, processLifecycle, sessionUpdateDispatcher,
 * sessionUpdateHandlers. This class only owns subprocess + connection state and
 * routes work to those modules.
 */

import { type ChildProcess } from 'node:child_process';
import {
  ClientSideConnection,
  ndJsonStream,
  type Client,
  type Agent,
  type SessionNotification,
  type RequestPermissionResponse,
  type PromptRequest,
  type ContentBlock,
} from '@agentclientprotocol/sdk';
import { randomUUID } from 'node:crypto';
import type {
  AgentBackend,
  AgentMessage,
  AgentMessageHandler,
  SessionId,
  StartSessionResult,
} from '../core';
import { logger } from '@/ui/logger';
import { type TransportHandler, DefaultTransport } from '../transport';
import { type HandlerContext } from './sessionUpdateHandlers';
import { dispatchSessionUpdate } from './sessionUpdateDispatcher';
import { type AcpPermissionHandler, type AcpBackendOptions } from './acpTypes';
import { nodeToWebStreams, createFilteredStdoutStream } from './streamBridge';
import { extractSendPromptErrorDetail } from './errorFormatting';
import { createPermissionHandler } from './permissionHandling';
import { spawnAgentProcess, attachProcessListeners, initializeAcpConnection, createAcpSession } from './processLifecycle';

// Re-export public types so existing callers (`import { AcpBackendOptions } from '../acp/AcpBackend'`)
// continue to compile unchanged.
export type { AcpPermissionHandler, AcpBackendOptions } from './acpTypes';

/**
 * ACP backend using the official `@agentclientprotocol/sdk`.
 */
export class AcpBackend implements AgentBackend {
  private listeners: AgentMessageHandler[] = [];
  private process: ChildProcess | null = null;
  private connection: ClientSideConnection | null = null;
  private acpSessionId: string | null = null;
  private disposed = false;

  /** Track active tool calls to prevent duplicate events. */
  private activeToolCalls = new Set<string>();
  private toolCallTimeouts = new Map<string, NodeJS.Timeout>();
  /** Track tool call start times for performance monitoring. */
  private toolCallStartTimes = new Map<string, number>();
  /** Pending permission requests that need response. */
  private pendingPermissions = new Map<string, (response: RequestPermissionResponse) => void>();
  /** Map from real tool call ID to tool name for auto-approval. */
  private toolCallIdToNameMap = new Map<string, string>();

  /** Track if we just sent a prompt with change_title instruction. */
  private recentPromptHadChangeTitle = false;
  /** Track tool calls count since last prompt (to identify first tool call). */
  private toolCallCountSincePrompt = 0;
  /** Timeout for emitting 'idle' status after last message chunk. */
  private idleTimeout: NodeJS.Timeout | null = null;

  /** Promise resolver for waitForResponseComplete — set when waiting for response. */
  private idleResolver: (() => void) | null = null;
  private waitingForResponse = false;

  /** Transport handler for agent-specific behavior. */
  private readonly transport: TransportHandler;

  constructor(private options: AcpBackendOptions) {
    this.transport = options.transportHandler ?? new DefaultTransport(options.agentName);
  }

  onMessage(handler: AgentMessageHandler): void {
    this.listeners.push(handler);
  }

  offMessage(handler: AgentMessageHandler): void {
    const index = this.listeners.indexOf(handler);
    if (index !== -1) {
      this.listeners.splice(index, 1);
    }
  }

  private emit(msg: AgentMessage): void {
    if (this.disposed) return;
    for (const listener of this.listeners) {
      try {
        listener(msg);
      } catch (error) {
        logger.warn('[AcpBackend] Error in message handler:', error);
      }
    }
  }

  async startSession(initialPrompt?: string): Promise<StartSessionResult> {
    if (this.disposed) {
      throw new Error('Backend has been disposed');
    }

    const sessionId = randomUUID();
    this.emit({ type: 'status', status: 'starting' });

    try {
      logger.debug(`[AcpBackend] Starting session: ${sessionId}`);
      this.process = spawnAgentProcess({
        command: this.options.command,
        args: this.options.args,
        cwd: this.options.cwd,
        env: this.options.env,
      });
      attachProcessListeners(this.process, {
        transport: this.transport,
        getActiveToolCalls: () => this.activeToolCalls,
        isDisposed: () => this.disposed,
        emit: (msg) => this.emit(msg),
      });

      // Bridge stdio to Web Streams + filter non-JSON noise per transport.
      const { writable, readable } = nodeToWebStreams(this.process.stdin!, this.process.stdout!);
      const filteredReadable = createFilteredStdoutStream(readable, this.transport);
      const stream = ndJsonStream(writable, filteredReadable);

      // Build the ACP Client implementation. Permission handling is fully
      // factored out — see permissionHandling.ts.
      const client: Client = {
        sessionUpdate: async (params: SessionNotification) => {
          this.handleSessionUpdate(params);
        },
        requestPermission: createPermissionHandler({
          transport: this.transport,
          permissionHandler: this.options.permissionHandler,
          getRecentPromptHadChangeTitle: () => this.recentPromptHadChangeTitle,
          getToolCallCountSincePrompt: () => this.toolCallCountSincePrompt,
          incrementToolCallCount: () => {
            this.toolCallCountSincePrompt++;
          },
          emit: (msg) => this.emit(msg),
        }),
      };

      this.connection = new ClientSideConnection((_agent: Agent) => client, stream);

      await initializeAcpConnection(this.connection, this.transport);
      this.acpSessionId = await createAcpSession(
        this.connection,
        this.transport,
        this.options.cwd,
        this.options.mcpServers
      );

      this.emitIdleStatus();

      if (initialPrompt) {
        this.sendPrompt(sessionId, initialPrompt).catch((error) => {
          logger.debug('[AcpBackend] Error sending initial prompt:', error);
          this.emit({ type: 'status', status: 'error', detail: String(error) });
        });
      }

      return { sessionId };
    } catch (error) {
      logger.debug('[AcpBackend] Error starting session:', error);
      this.emit({
        type: 'status',
        status: 'error',
        detail: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /** Build the per-update handler context shared with sessionUpdateHandlers. */
  private createHandlerContext(): HandlerContext {
    return {
      transport: this.transport,
      activeToolCalls: this.activeToolCalls,
      toolCallStartTimes: this.toolCallStartTimes,
      toolCallTimeouts: this.toolCallTimeouts,
      toolCallIdToNameMap: this.toolCallIdToNameMap,
      idleTimeout: this.idleTimeout,
      toolCallCountSincePrompt: this.toolCallCountSincePrompt,
      emit: (msg) => this.emit(msg),
      emitIdleStatus: () => this.emitIdleStatus(),
      clearIdleTimeout: () => {
        if (this.idleTimeout) {
          clearTimeout(this.idleTimeout);
          this.idleTimeout = null;
        }
      },
      setIdleTimeout: (callback, ms) => {
        this.idleTimeout = setTimeout(() => {
          callback();
          this.idleTimeout = null;
        }, ms);
      },
    };
  }

  private handleSessionUpdate(params: SessionNotification): void {
    const ctx = this.createHandlerContext();
    const result = dispatchSessionUpdate(params, ctx);
    if (result.toolCallCountSincePrompt !== undefined) {
      this.toolCallCountSincePrompt = result.toolCallCountSincePrompt;
    }
  }

  async sendPrompt(sessionId: SessionId, prompt: string): Promise<void> {
    const promptHasChangeTitle = this.options.hasChangeTitleInstruction?.(prompt) ?? false;

    // Reset per-prompt counters BEFORE the disposed/connection guards so callers
    // observing recentPromptHadChangeTitle see a consistent state on error.
    this.toolCallCountSincePrompt = 0;
    this.recentPromptHadChangeTitle = promptHasChangeTitle;

    if (promptHasChangeTitle) {
      logger.debug(
        '[AcpBackend] Prompt contains change_title instruction - will auto-approve first "other" tool call if it matches pattern'
      );
    }
    if (this.disposed) {
      throw new Error('Backend has been disposed');
    }
    if (!this.connection || !this.acpSessionId) {
      throw new Error('Session not started');
    }

    this.emit({ type: 'status', status: 'running' });
    this.waitingForResponse = true;

    try {
      logger.debug(
        `[AcpBackend] Sending prompt (length: ${prompt.length}): ${prompt.substring(0, 100)}...`
      );
      logger.debug(`[AcpBackend] Full prompt: ${prompt}`);

      const contentBlock: ContentBlock = { type: 'text', text: prompt };
      const promptRequest: PromptRequest = {
        sessionId: this.acpSessionId,
        prompt: [contentBlock],
      };

      logger.debug(`[AcpBackend] Prompt request:`, JSON.stringify(promptRequest, null, 2));
      await this.connection.prompt(promptRequest);
      logger.debug('[AcpBackend] Prompt request sent to ACP connection');

      // 'idle' is emitted after all message chunks are received; the idle
      // timeout in handleSessionUpdate fires it after the last chunk.
    } catch (error) {
      logger.debug('[AcpBackend] Error sending prompt:', error);
      this.waitingForResponse = false;
      this.emit({
        type: 'status',
        status: 'error',
        detail: extractSendPromptErrorDetail(error),
      });
      throw error;
    }
  }

  /**
   * Wait for the response to complete (idle status after all chunks received).
   * Call this after `sendPrompt` to wait for the agent to finish responding.
   *
   * @param timeoutMs - Maximum wait, default 120s.
   */
  async waitForResponseComplete(timeoutMs: number = 120000): Promise<void> {
    if (!this.waitingForResponse) {
      return;
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.idleResolver = null;
        this.waitingForResponse = false;
        reject(new Error('Timeout waiting for response to complete'));
      }, timeoutMs);

      this.idleResolver = () => {
        clearTimeout(timeout);
        this.idleResolver = null;
        this.waitingForResponse = false;
        resolve();
      };
    });
  }

  /** Emit idle status and resolve any waiting `waitForResponseComplete` promise. */
  private emitIdleStatus(): void {
    this.emit({ type: 'status', status: 'idle' });
    if (this.idleResolver) {
      logger.debug('[AcpBackend] Resolving idle waiter');
      this.idleResolver();
    }
  }

  async cancel(_sessionId: SessionId): Promise<void> {
    if (!this.connection || !this.acpSessionId) {
      return;
    }

    try {
      await this.connection.cancel({ sessionId: this.acpSessionId });
      this.emit({ type: 'status', status: 'stopped', detail: 'Cancelled by user' });
    } catch (error) {
      logger.debug('[AcpBackend] Error cancelling:', error);
    }
  }

  /**
   * Emit a permission-response event for UI/logging only.
   *
   * **IMPORTANT:** For ACP backends this method does NOT send the actual
   * permission response to the agent — the ACP protocol requires synchronous
   * permission handling, which is performed inside `requestPermission` via
   * `this.options.permissionHandler`. This method exists so other parts of
   * the CLI (UI dialogs, audit log) can still react to decisions.
   *
   * @param requestId - The ID of the permission request.
   * @param approved  - Whether the permission was granted.
   */
  async respondToPermission(requestId: string, approved: boolean): Promise<void> {
    logger.debug(`[AcpBackend] Permission response event (UI only): ${requestId} = ${approved}`);
    this.emit({ type: 'permission-response', id: requestId, approved });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;

    logger.debug('[AcpBackend] Disposing backend');
    this.disposed = true;

    // Try graceful shutdown first.
    if (this.connection && this.acpSessionId) {
      try {
        await Promise.race([
          this.connection.cancel({ sessionId: this.acpSessionId }),
          // 2s budget for the agent to acknowledge the cancel before we move on.
          new Promise((resolve) => setTimeout(resolve, 2000)),
        ]);
      } catch (error) {
        logger.debug('[AcpBackend] Error during graceful shutdown:', error);
      }
    }

    if (this.process) {
      // SIGTERM first; escalate to SIGKILL if the process hasn't exited in 1s.
      this.process.kill('SIGTERM');

      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          if (this.process) {
            logger.debug('[AcpBackend] Force killing process');
            this.process.kill('SIGKILL');
          }
          resolve();
        }, 1000);

        this.process?.once('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });

      this.process = null;
    }

    if (this.idleTimeout) {
      clearTimeout(this.idleTimeout);
      this.idleTimeout = null;
    }

    this.listeners = [];
    this.connection = null;
    this.acpSessionId = null;
    this.activeToolCalls.clear();
    for (const timeout of this.toolCallTimeouts.values()) {
      clearTimeout(timeout);
    }
    this.toolCallTimeouts.clear();
    this.toolCallStartTimes.clear();
    this.pendingPermissions.clear();
  }
}
