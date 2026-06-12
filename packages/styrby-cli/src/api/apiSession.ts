/**
 * API Session Management
 *
 * Handles session lifecycle and message routing between agents and the mobile app.
 * Creates sessions in Supabase, streams messages through the relay, and manages
 * the bidirectional bridge between agent processes and mobile devices.
 *
 * WHY: Replaces the stub that was standing in for Happy Coder's session management.
 * We use Supabase for persistent session state and Supabase Realtime for live message
 * streaming, keeping the architecture simple (one database for everything).
 *
 * @module api/apiSession
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ApiSession, ApiMessage, SessionUpdate } from './types';
import type { StyrbyApi } from './api';
import type { AgentBackend, AgentMessage, AgentMessageHandler } from '@/agent/core/AgentBackend';
import type { RelayMessage, AgentType as SharedAgentType } from 'styrby-shared';
import { logger } from '@/ui/logger';
import { classifyRelayMessage } from './relayMessageDispatch';
import { safeRelaySend } from './safeRelaySend';
import { createFileWatcher, type FileWatcherHandle } from '@/session/fileWatcher';

/**
 * Callback type for session updates (status changes, errors, completion).
 */
export type SessionUpdateHandler = (update: SessionUpdate) => void;

/**
 * Configuration for creating a managed session.
 */
export interface ManagedSessionConfig {
  /** Authenticated Supabase client for database operations */
  supabase: SupabaseClient;
  /** Connected StyrbyApi instance for relay communication */
  api: StyrbyApi;
  /** The agent backend to bridge with mobile */
  agent: AgentBackend;
  /** Agent type identifier */
  agentType: SharedAgentType;
  /** User ID from Supabase Auth */
  userId: string;
  /** Machine ID for this CLI instance */
  machineId: string;
  /** Working directory for the session */
  projectPath: string;
}

/**
 * Represents an active managed session that bridges agent output to the mobile relay.
 *
 * WHY: This is the core object that ties together the agent process, the relay
 * channel, and the Supabase database. It owns the lifecycle of a session:
 * create -> run (bridge messages) -> end (cleanup).
 */
export interface ActiveSession {
  /** Session ID (Supabase-generated UUID) */
  sessionId: string;
  /** Agent type running in this session */
  agentType: SharedAgentType;
  /** Working directory */
  projectPath: string;
  /** Current session status */
  status: ApiSession['status'];
  /** Stop the session and clean up all resources */
  stop: () => Promise<void>;
}

/**
 * Session manager that creates and manages agent sessions with relay bridging.
 *
 * Responsibilities:
 * - Create session records in Supabase `sessions` table
 * - Bridge agent output (model-output, tool-call, permission-request) to the relay
 * - Bridge mobile input (chat messages, permission responses, commands) to the agent
 * - Update session status in Supabase on state transitions
 * - Clean up resources when sessions end (agent dispose, relay presence clear)
 *
 * @example
 * ```typescript
 * const manager = new ApiSessionManager();
 * const session = await manager.startManagedSession({
 *   supabase,
 *   api,
 *   agent,
 *   agentType: 'claude',
 *   userId,
 *   machineId,
 *   projectPath: '/path/to/project',
 * });
 *
 * // Session is now bridging messages between agent and mobile
 * // Stop when done:
 * await session.stop();
 * ```
 */
export class ApiSessionManager {
  private sessions: Map<string, ApiSession> = new Map();
  private updateHandlers: Map<string, SessionUpdateHandler[]> = new Map();

  /**
   * Start a fully managed session that bridges an agent to the mobile app.
   *
   * This method:
   * 1. Creates a session record in Supabase
   * 2. Starts the agent process
   * 3. Sets up bidirectional message bridging (agent <-> relay <-> mobile)
   * 4. Returns an ActiveSession handle for controlling the session
   *
   * @param config - Session configuration including agent, API, and Supabase client
   * @returns An ActiveSession handle with stop() for cleanup
   * @throws {Error} When Supabase insert fails or agent fails to start
   */
  async startManagedSession(config: ManagedSessionConfig): Promise<ActiveSession> {
    const {
      supabase,
      api,
      agent,
      agentType,
      userId,
      machineId,
      projectPath,
    } = config;

    const sessionId = crypto.randomUUID();
    const now = new Date().toISOString();

    // 1. Create session record in Supabase
    const { error: insertError } = await supabase
      .from('sessions')
      .insert({
        id: sessionId,
        user_id: userId,
        machine_id: machineId,
        agent_type: agentType,
        status: 'starting',
        project_path: projectPath,
        started_at: now,
        last_activity_at: now,
      });

    if (insertError) {
      logger.error('Failed to create session in Supabase', { error: insertError.message });
      // Non-fatal: session works without remote record, just log and continue
      // WHY: The relay bridge is more important than the database record.
      // If Supabase is temporarily unavailable, we still want the session to work.
    }

    // Track locally
    // WHY: ApiSession.agentType is narrower ('claude' | 'codex' | 'gemini') than
    // SharedAgentType which also includes 'opencode' | 'aider'. We cast here because
    // the API types haven't been updated yet for the new agents, but the session
    // should still work with any agent type.
    const apiSession: ApiSession = {
      sessionId,
      agentType: agentType as ApiSession['agentType'],
      status: 'starting',
      projectPath,
      createdAt: now,
      lastActivityAt: now,
    };
    this.sessions.set(sessionId, apiSession);

    // 2. Set up agent -> relay bridge (agent output goes to mobile)
    const agentMessageHandler: AgentMessageHandler = (msg: AgentMessage) => {
      this.handleAgentMessage(sessionId, agentType, msg, api);
    };
    agent.onMessage(agentMessageHandler);

    // WHY: the manager owns the canonical session id (`sessionId`, written to
    // Supabase + addressed by mobile), but a backend mints its OWN id in
    // startSession() and validates against it in sendPrompt()/cancel(). We track
    // the backend's id and pass it on the agent calls so relay input reaches the
    // backend's session (the relay handler runs after startSession, so the
    // closure reads the updated value). Without this, every chat/cancel failed
    // with "Invalid session ID" — the manager id never matched the backend id.
    let backendSessionId: string = sessionId;

    // 3. Set up relay -> agent bridge (mobile input goes to agent)
    const relayMessageHandler = (message: RelayMessage) => {
      this.handleRelayMessage(sessionId, message, agent, agentType, api, backendSessionId);
    };
    api.onRelayMessage(relayMessageHandler);

    // 4. Start the agent process
    logger.debug('Starting agent session', { sessionId, agentType, projectPath });
    const startResult = await agent.startSession();
    backendSessionId = startResult.sessionId;
    logger.debug('Agent session started', { sessionId, agentSessionId: startResult.sessionId });

    // Update status to running
    await this.updateSessionStatus(supabase, sessionId, 'running');

    // 4b. Optional project file watcher → fs-edit events to mobile.
    //
    // WHY opt-in (STYRBY_SESSION_FILE_EVENTS): watching the project dir lets
    // mobile see which files the agent touches in real time, but it adds an
    // OS watcher per session and emits relay traffic. Gating it keeps the
    // default behavior unchanged; operators opt in (and can pair it with
    // STYRBY_NATIVE_WATCHER for the SIMD-fast recursive native backend). The
    // watcher already filters node_modules/.git/build noise. Each change is
    // bridged as an `fs-edit` AgentMessage through the SAME path as real agent
    // output, so it reaches mobile via the existing relay plumbing.
    let fileWatcher: FileWatcherHandle | undefined;
    if (process.env.STYRBY_SESSION_FILE_EVENTS === 'true' && projectPath) {
      try {
        fileWatcher = await createFileWatcher({
          dir: projectPath,
          onChange: (changes) => {
            for (const change of changes) {
              this.handleAgentMessage(
                sessionId,
                agentType,
                { type: 'fs-edit', description: `${change.kind} ${change.path}`, path: change.path },
                api,
              );
            }
          },
        });
        logger.debug('Session file watcher started', { sessionId, backend: fileWatcher.backend });
      } catch (error) {
        // Non-fatal: a session must run even if the watcher can't start.
        logger.debug('Session file watcher failed to start (non-fatal)', { sessionId, error });
      }
    }

    // 5. Build the ActiveSession handle
    let stopped = false;
    const activeSession: ActiveSession = {
      sessionId,
      agentType,
      projectPath,
      status: 'running',

      /**
       * Stop the session, dispose the agent, and clean up all resources.
       *
       * WHY: Centralized cleanup ensures we never leak agent processes, relay
       * handlers, or Supabase subscriptions regardless of how the session ends
       * (user request, Ctrl+C, agent crash, mobile disconnect).
       */
      stop: async () => {
        if (stopped) return;
        stopped = true;

        logger.debug('Stopping managed session', { sessionId });

        // Remove relay message handler first to stop accepting new mobile input
        api.offRelayMessage(relayMessageHandler);

        // Stop the project file watcher (releases the OS watcher + its threads).
        // Done before agent dispose so no fs-edit events fire mid-teardown.
        fileWatcher?.stop();

        // Dispose the agent process
        try {
          agent.offMessage?.(agentMessageHandler);
          await agent.dispose();
        } catch (error) {
          logger.debug('Error disposing agent', { error });
        }

        // Update session status in Supabase
        await this.updateSessionStatus(supabase, sessionId, 'stopped');

        // Send final session state to mobile (B4-Wave2: warn-on-failure
        // via safeRelaySend; relay may already be disconnected at stop time
        // so this is allowed to fail, but the failure is now visible).
        await safeRelaySend(
          api.sendSessionState(sessionId, agentType, 'idle'),
          { sessionId, messageType: 'session-state', detail: 'idle-on-stop' }
        );

        // End session on the API (clears relay presence)
        await api.endSession(sessionId);

        // Clean up local state
        this.sessions.delete(sessionId);
        this.updateHandlers.delete(sessionId);
        activeSession.status = 'stopped';

        logger.debug('Managed session stopped', { sessionId });
      },
    };

    return activeSession;
  }

  /**
   * Bridge an agent message to the mobile app via the relay.
   *
   * Transforms AgentMessage types into the corresponding relay message types:
   * - model-output -> agent_response (streaming text)
   * - status -> session_state (idle/thinking/executing/error)
   * - permission-request -> permission_request (tool approval)
   * - tool-call -> session_state:executing + agent_response (tool info)
   * - tool-result -> agent_response (tool result)
   *
   * @param sessionId - Session the message belongs to
   * @param agentType - Agent that produced the message
   * @param msg - The agent message to bridge
   * @param api - StyrbyApi instance for sending relay messages
   */
  private handleAgentMessage(
    sessionId: string,
    agentType: SharedAgentType,
    msg: AgentMessage,
    api: StyrbyApi
  ): void {
    // Update local last activity timestamp
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastActivityAt = new Date().toISOString();
    }

    switch (msg.type) {
      case 'model-output': {
        // Stream agent text output to mobile
        const content = msg.textDelta ?? msg.fullText ?? '';
        if (content) {
          void safeRelaySend(
            api.sendAgentResponse(sessionId, agentType, content, {
              isStreaming: !!msg.textDelta,
              isComplete: !!msg.fullText,
            }),
            { sessionId, messageType: 'agent-response', detail: 'model-output' }
          );
        }
        break;
      }

      case 'status': {
        // Map agent status to relay session state
        const stateMap: Record<string, 'idle' | 'thinking' | 'executing' | 'error'> = {
          starting: 'thinking',
          running: 'thinking',
          idle: 'idle',
          stopped: 'idle',
          error: 'error',
        };
        const relayState = stateMap[msg.status] || 'idle';

        void safeRelaySend(
          api.sendSessionState(
            sessionId,
            agentType,
            relayState,
            msg.status === 'error' && msg.detail
              ? { error: { type: 'agent', message: msg.detail, recoverable: true } }
              : undefined
          ),
          { sessionId, messageType: 'session-state', detail: relayState }
        );

        // Emit local update
        this.emitUpdate(sessionId, { type: 'status', payload: { status: msg.status, detail: msg.detail } });
        break;
      }

      case 'permission-request': {
        // Forward permission request to mobile for user approval
        const payload = msg.payload as Record<string, unknown>;
        void safeRelaySend(
          api.sendPermissionRequest(sessionId, agentType, {
            requestId: msg.id,
            toolName: msg.reason,
            toolArgs: payload || {},
            riskLevel: 'medium',
            description: `${agentType} wants to use: ${msg.reason}`,
          }),
          { sessionId, messageType: 'permission-request', detail: msg.reason }
        );
        break;
      }

      case 'tool-call': {
        // Notify mobile that agent is executing a tool
        void safeRelaySend(
          api.sendSessionState(sessionId, agentType, 'executing'),
          { sessionId, messageType: 'session-state', detail: 'executing-tool' }
        );

        // Also send tool info as an agent response so mobile can display it
        void safeRelaySend(
          api.sendAgentResponse(
            sessionId,
            agentType,
            JSON.stringify({ type: 'tool-call', toolName: msg.toolName, args: msg.args }),
            { isStreaming: false, isComplete: true }
          ),
          { sessionId, messageType: 'agent-response', detail: `tool-call:${msg.toolName}` }
        );
        break;
      }

      case 'tool-result': {
        // Send tool result back to mobile
        void safeRelaySend(
          api.sendAgentResponse(
            sessionId,
            agentType,
            JSON.stringify({ type: 'tool-result', toolName: msg.toolName, result: msg.result }),
            { isStreaming: false, isComplete: true }
          ),
          { sessionId, messageType: 'agent-response', detail: `tool-result:${msg.toolName}` }
        );
        break;
      }

      case 'fs-edit': {
        // Send file edit notification to mobile
        void safeRelaySend(
          api.sendAgentResponse(
            sessionId,
            agentType,
            JSON.stringify({ type: 'fs-edit', description: msg.description, path: msg.path }),
            { isStreaming: false, isComplete: true }
          ),
          { sessionId, messageType: 'agent-response', detail: 'fs-edit' }
        );
        break;
      }

      case 'terminal-output': {
        // Stream terminal output to mobile
        void safeRelaySend(
          api.sendAgentResponse(
            sessionId,
            agentType,
            msg.data,
            { isStreaming: true, isComplete: false }
          ),
          { sessionId, messageType: 'agent-response', detail: 'terminal-output' }
        );
        break;
      }

      default: {
        // Forward other message types as generic agent responses
        logger.debug('Unhandled agent message type in bridge', { type: msg.type });
        break;
      }
    }
  }

  /**
   * Bridge a relay message from mobile to the agent.
   *
   * Handles:
   * - chat -> agent.sendPrompt() (user typed a message)
   * - permission_response -> agent.respondToPermission() (user approved/denied)
   * - command:cancel -> agent.cancel() (user cancelled operation)
   * - command:end_session -> triggers session stop
   * - command:interrupt -> agent.cancel() (same as cancel for now)
   *
   * @param sessionId - Canonical (manager) session id the message targets; used
   *   for session-matching + relay responses.
   * @param message - The relay message from mobile
   * @param agent - Agent backend to forward input to
   * @param agentType - Agent type for logging
   * @param api - StyrbyApi for sending responses back
   * @param backendSessionId - The backend's OWN session id (from startSession);
   *   used on agent.sendPrompt()/cancel() since backends validate their own id.
   */
  private handleRelayMessage(
    sessionId: string,
    message: RelayMessage,
    agent: AgentBackend,
    agentType: SharedAgentType,
    api: StyrbyApi,
    backendSessionId: string
  ): void {
    // SECURITY: classification (schema validation + nonce verify + routing)
    // is delegated to the pure `classifyRelayMessage` helper. See
    // `relayMessageDispatch.ts` for the full decision sequence + the
    // CLI-008/CLI-009 audit context. Tests live in
    // `__tests__/relayMessageDispatch.test.ts` (the helper is fully
    // unit-tested in isolation; this method is pure dispatch on the
    // returned verdict).
    const verdict = classifyRelayMessage(
      sessionId,
      message,
      (id, nonce) => api.verifyAndConsumePermissionNonce(id, nonce),
    );

    switch (verdict.action) {
      case 'drop-schema-invalid':
        logger.warn('Dropping invalid relay message (schema validation failed)', {
          sessionId,
          type: verdict.type,
          issues: verdict.issues.map((i) => ({ path: i.path.join('.'), code: i.code })),
        });
        return;

      case 'drop-nonce-mismatch':
        logger.warn('Rejecting permission_response: nonce mismatch or unknown request_id', {
          sessionId,
          requestId: verdict.requestId,
        });
        return;

      case 'drop-wrong-session':
        logger.debug('Chat message for different session, ignoring', {
          targetSession: verdict.targetSession,
          ourSession: sessionId,
        });
        return;

      case 'drop-unhandled-command':
        logger.debug('Unhandled relay command', { action: verdict.commandAction });
        return;

      case 'drop-unhandled-type':
        logger.debug('Unhandled relay message type in bridge', { type: verdict.type });
        return;

      case 'chat':
        logger.debug('Relay chat received, forwarding to agent', {
          sessionId: verdict.sessionId,
          contentLength: verdict.content.length,
        });
        agent.sendPrompt(backendSessionId, verdict.content).catch((error) => {
          logger.error('Failed to send prompt to agent', { error });
          // Also surface the error to mobile via session-state. Wrapped in
          // safeRelaySend so a relay-down condition doesn't mask the
          // already-logged agent error.
          void safeRelaySend(
            api.sendSessionState(verdict.sessionId, agentType, 'error', {
              error: {
                type: 'agent',
                message: error instanceof Error ? error.message : String(error),
                recoverable: true,
              },
            }),
            {
              sessionId: verdict.sessionId,
              messageType: 'session-state-error',
              detail: 'sendPrompt-failed',
            }
          );
        });
        return;

      case 'permission-response':
        logger.debug('Relay permission response received', {
          requestId: verdict.requestId,
          approved: verdict.approved,
        });
        if (agent.respondToPermission) {
          agent.respondToPermission(verdict.requestId, verdict.approved).catch((error) => {
            logger.debug('Error responding to permission', { error });
          });
        }
        return;

      case 'cancel':
        agent.cancel(backendSessionId).catch((error) => {
          logger.debug('Error cancelling agent', { error });
        });
        return;

      case 'end-session':
        // Session stop is handled by the caller via ActiveSession.stop()
        this.emitUpdate(verdict.sessionId, { type: 'end_session_requested' });
        return;

      case 'ping':
        // Heartbeat — no action needed, relay handles it
        return;
    }
  }

  /**
   * Update session status in Supabase.
   *
   * @param supabase - Supabase client for database operations
   * @param sessionId - Session to update
   * @param status - New session status
   */
  private async updateSessionStatus(
    supabase: SupabaseClient,
    sessionId: string,
    status: ApiSession['status']
  ): Promise<void> {
    const now = new Date().toISOString();

    const { error } = await supabase
      .from('sessions')
      .update({
        status,
        last_activity_at: now,
        ...(status === 'stopped' ? { ended_at: now } : {}),
      })
      .eq('id', sessionId);

    if (error) {
      // Non-fatal: log and continue. The session still works without the DB update.
      logger.debug('Failed to update session status in Supabase', {
        sessionId,
        status,
        error: error.message,
      });
    }

    // Update local session record
    const session = this.sessions.get(sessionId);
    if (session) {
      session.status = status;
      session.lastActivityAt = now;
    }
  }

  /**
   * Register a session update handler.
   *
   * @param sessionId - Session to watch
   * @param handler - Callback for updates
   */
  onSessionUpdate(sessionId: string, handler: SessionUpdateHandler): void {
    const handlers = this.updateHandlers.get(sessionId) || [];
    handlers.push(handler);
    this.updateHandlers.set(sessionId, handlers);
  }

  /**
   * Remove a session update handler.
   *
   * @param sessionId - Session to unwatch
   * @param handler - Handler to remove
   */
  offSessionUpdate(sessionId: string, handler: SessionUpdateHandler): void {
    const handlers = this.updateHandlers.get(sessionId) || [];
    const index = handlers.indexOf(handler);
    if (index !== -1) {
      handlers.splice(index, 1);
    }
  }

  /**
   * Emit a session update to registered handlers.
   *
   * @param sessionId - Session that was updated
   * @param update - The update payload
   */
  emitUpdate(sessionId: string, update: SessionUpdate): void {
    const handlers = this.updateHandlers.get(sessionId) || [];
    for (const handler of handlers) {
      try {
        handler(update);
      } catch (error) {
        logger.error('Session update handler error', error);
      }
    }
  }

  /**
   * Get a session by ID.
   *
   * @param sessionId - Session ID to look up
   * @returns Session or undefined
   */
  getSession(sessionId: string): ApiSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Set/update a session.
   *
   * @param session - Session to store
   */
  setSession(session: ApiSession): void {
    this.sessions.set(session.sessionId, session);
  }

  /**
   * Remove a session.
   *
   * @param sessionId - Session to remove
   */
  removeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.updateHandlers.delete(sessionId);
  }

  /**
   * Send a message for a session (legacy compatibility).
   *
   * @param sessionId - Session to send to
   * @param message - Message to send
   */
  async sendMessage(sessionId: string, message: Omit<ApiMessage, 'id' | 'sessionId' | 'timestamp'>): Promise<void> {
    logger.debug('ApiSession sendMessage', { sessionId, type: message.type });
    // WHY: This method exists for backward compatibility with the forked agent code.
    // New code should use the StyrbyApi directly via the ActiveSession's bridging.
  }
}

/**
 * Singleton session manager.
 */
export const apiSession = new ApiSessionManager();

/**
 * Default export for compatibility
 */
export default apiSession;
