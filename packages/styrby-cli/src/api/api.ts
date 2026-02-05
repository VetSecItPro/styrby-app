/**
 * API Client
 *
 * Connects the CLI to the Styrby relay via Supabase Realtime.
 * This is the primary communication layer between the CLI and the mobile app.
 *
 * WHY: Replaces the stub that was standing in for Happy Coder's socket.io-based API.
 * We use Supabase Realtime channels for the relay because:
 * - It integrates natively with Supabase Auth (RLS-protected channels)
 * - It provides presence tracking (CLI/mobile online status) out of the box
 * - It handles reconnection with exponential backoff automatically
 * - No additional infrastructure to maintain (no separate WebSocket server)
 *
 * @module api/api
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ApiConnectionState, ApiSession, ApiMessage } from './types';
import type { RelayClient, RelayClientConfig } from 'styrby-shared';
import type { RelayMessage, AgentType as SharedAgentType } from 'styrby-shared';
import { logger } from '@/ui/logger';

/**
 * Configuration for creating a StyrbyApi instance.
 */
export interface StyrbyApiConfig {
  /** Authenticated Supabase client (with user's access token) */
  supabase: SupabaseClient;
  /** User ID from Supabase Auth */
  userId: string;
  /** Machine ID for this CLI instance */
  machineId: string;
  /** Human-readable machine name (e.g., hostname) */
  machineName?: string;
  /** Enable verbose relay debug logging */
  debug?: boolean;
}

/**
 * Callback type for incoming relay messages from the mobile app.
 */
export type RelayMessageHandler = (message: RelayMessage) => void;

/**
 * API client for connecting to the Styrby relay via Supabase Realtime.
 *
 * Wraps the shared RelayClient to provide a CLI-specific interface for:
 * - Connecting and disconnecting from the user's relay channel
 * - Sending agent output and session state updates to mobile
 * - Receiving chat messages and commands from mobile
 * - Tracking connection state for the CLI UI
 *
 * @example
 * ```typescript
 * const api = new StyrbyApi({
 *   supabase,
 *   userId: data.userId,
 *   machineId: data.machineId,
 * });
 *
 * await api.connect();
 * api.onRelayMessage((msg) => {
 *   if (msg.type === 'chat') {
 *     agent.sendPrompt(sessionId, msg.payload.content);
 *   }
 * });
 * ```
 */
export class StyrbyApi {
  private connectionState: ApiConnectionState = 'disconnected';
  private sessionId: string | null = null;
  private relay: RelayClient | null = null;
  private config: StyrbyApiConfig | null = null;
  private messageHandlers: Set<RelayMessageHandler> = new Set();

  /**
   * Initialize the API client with Supabase credentials and relay config.
   *
   * WHY: Separated from constructor so the class can be instantiated as a singleton
   * and configured later when credentials become available (after auth flow).
   *
   * @param config - Supabase client, user ID, and machine info
   */
  configure(config: StyrbyApiConfig): void {
    this.config = config;
    logger.debug('StyrbyApi configured', {
      userId: config.userId.slice(0, 8) + '...',
      machineId: config.machineId.slice(0, 8) + '...',
    });
  }

  /**
   * Connect to the Styrby relay channel via Supabase Realtime.
   *
   * Creates a RelayClient from styrby-shared and subscribes to the user's
   * private channel. Sets up presence tracking so the mobile app can see
   * the CLI is online, and registers message handlers for incoming commands.
   *
   * @throws {Error} When not configured (call configure() first)
   * @throws {Error} When connection times out or channel subscription fails
   */
  async connect(): Promise<void> {
    if (!this.config) {
      throw new Error('StyrbyApi not configured. Call configure() first.');
    }

    if (this.connectionState === 'connected' || this.connectionState === 'connecting') {
      logger.debug('StyrbyApi already connected or connecting');
      return;
    }

    this.connectionState = 'connecting';

    try {
      const { createRelayClient } = await import('styrby-shared');

      this.relay = createRelayClient({
        supabase: this.config.supabase,
        userId: this.config.userId,
        deviceId: this.config.machineId,
        deviceType: 'cli',
        deviceName: this.config.machineName || 'CLI',
        platform: process.platform,
        debug: this.config.debug || process.env.STYRBY_LOG_LEVEL === 'debug',
      });

      // Forward relay messages to registered handlers
      this.relay.on('message', (message: RelayMessage) => {
        logger.debug('StyrbyApi received relay message', { type: message.type });
        for (const handler of this.messageHandlers) {
          try {
            handler(message);
          } catch (error) {
            logger.error('Error in relay message handler', error);
          }
        }
      });

      // Track connection state changes from relay events
      this.relay.on('error', (err: { message: string }) => {
        logger.error('Relay error', { error: err.message });
        this.connectionState = 'error';
      });

      this.relay.on('closed', () => {
        logger.debug('Relay channel closed');
        this.connectionState = 'disconnected';
      });

      await this.relay.connect();
      this.connectionState = 'connected';
      logger.debug('StyrbyApi connected to relay');
    } catch (error) {
      this.connectionState = 'error';
      logger.error('StyrbyApi connection failed', error);
      throw error;
    }
  }

  /**
   * Disconnect from the relay channel and clean up resources.
   *
   * Unsubscribes from the Supabase Realtime channel, stops heartbeat,
   * and clears presence. Safe to call multiple times.
   */
  async disconnect(): Promise<void> {
    if (this.relay) {
      try {
        await this.relay.disconnect();
      } catch (error) {
        logger.debug('Error during relay disconnect', { error });
      }
      this.relay = null;
    }

    this.connectionState = 'disconnected';
    this.sessionId = null;
    logger.debug('StyrbyApi disconnected');
  }

  /**
   * Get the underlying RelayClient instance.
   *
   * WHY: Callers sometimes need direct relay access for operations like
   * updatePresence() or checking connected devices, which are relay-level
   * concerns that don't belong in the API abstraction.
   *
   * @returns The RelayClient or null if not connected
   */
  getRelay(): RelayClient | null {
    return this.relay;
  }

  /**
   * Get current connection state.
   *
   * @returns The current connection state ('connecting' | 'connected' | 'disconnected' | 'error')
   */
  getConnectionState(): ApiConnectionState {
    return this.connectionState;
  }

  /**
   * Check if connected to the relay.
   *
   * @returns True if the relay channel is subscribed and active
   */
  isConnected(): boolean {
    return this.connectionState === 'connected' && (this.relay?.isConnected() ?? false);
  }

  /**
   * Register a handler for incoming relay messages from the mobile app.
   *
   * @param handler - Callback invoked for each incoming RelayMessage
   */
  onRelayMessage(handler: RelayMessageHandler): void {
    this.messageHandlers.add(handler);
  }

  /**
   * Remove a previously registered relay message handler.
   *
   * @param handler - The handler to remove
   */
  offRelayMessage(handler: RelayMessageHandler): void {
    this.messageHandlers.delete(handler);
  }

  /**
   * Send a message through the relay to the mobile app.
   *
   * This is a low-level method. Prefer the typed methods (sendAgentResponse,
   * sendSessionState, sendCostUpdate) for specific message types.
   *
   * @param message - The API message to send
   * @throws {Error} When not connected to the relay
   */
  async sendMessage(message: ApiMessage): Promise<void> {
    if (!this.relay || !this.isConnected()) {
      logger.warn('Cannot send message: not connected to relay');
      return;
    }

    logger.debug('StyrbyApi sendMessage', { type: message.type });

    await this.relay.send({
      type: 'agent_response',
      payload: {
        content: JSON.stringify(message.payload),
        agent: (message.type as SharedAgentType) || 'claude',
        session_id: message.sessionId,
        is_streaming: false,
        is_complete: true,
      },
    });
  }

  /**
   * Send an agent response (text output) to the mobile app.
   *
   * @param sessionId - The session this response belongs to
   * @param agentType - Which agent produced this output
   * @param content - The response text content
   * @param options - Streaming options (is_streaming, is_complete)
   * @throws {Error} When not connected to the relay
   */
  async sendAgentResponse(
    sessionId: string,
    agentType: SharedAgentType,
    content: string,
    options: { isStreaming?: boolean; isComplete?: boolean } = {}
  ): Promise<void> {
    if (!this.relay || !this.isConnected()) {
      logger.debug('Cannot send agent response: not connected');
      return;
    }

    await this.relay.send({
      type: 'agent_response',
      payload: {
        content,
        agent: agentType,
        session_id: sessionId,
        is_streaming: options.isStreaming ?? false,
        is_complete: options.isComplete ?? true,
      },
    });
  }

  /**
   * Send a session state update to the mobile app.
   *
   * WHY: The mobile app needs to know the agent's current state
   * (thinking, executing, idle, error) to show appropriate UI indicators.
   *
   * @param sessionId - The session this state belongs to
   * @param agentType - Which agent is running
   * @param state - Current agent state
   * @param details - Optional additional state details
   */
  async sendSessionState(
    sessionId: string,
    agentType: SharedAgentType,
    state: 'idle' | 'thinking' | 'executing' | 'waiting_permission' | 'error',
    details?: { cwd?: string; error?: { type: string; message: string; recoverable: boolean } }
  ): Promise<void> {
    if (!this.relay || !this.isConnected()) {
      logger.debug('Cannot send session state: not connected');
      return;
    }

    await this.relay.send({
      type: 'session_state',
      payload: {
        session_id: sessionId,
        agent: agentType,
        state,
        cwd: details?.cwd,
        error: details?.error ? {
          type: details.error.type as 'agent' | 'network' | 'build' | 'styrby',
          message: details.error.message,
          recoverable: details.error.recoverable,
        } : undefined,
      },
    });
  }

  /**
   * Send a permission request to the mobile app.
   *
   * WHY: When agents want to perform risky operations (file edits, terminal commands),
   * the CLI needs to relay the permission request to the mobile app for user approval.
   *
   * @param sessionId - The session requesting permission
   * @param agentType - Which agent is requesting
   * @param request - Permission request details (tool name, args, risk level)
   */
  async sendPermissionRequest(
    sessionId: string,
    agentType: SharedAgentType,
    request: {
      requestId: string;
      toolName: string;
      toolArgs: Record<string, unknown>;
      riskLevel: 'low' | 'medium' | 'high' | 'critical';
      description: string;
      affectedFiles?: string[];
    }
  ): Promise<void> {
    if (!this.relay || !this.isConnected()) {
      logger.debug('Cannot send permission request: not connected');
      return;
    }

    await this.relay.send({
      type: 'permission_request',
      payload: {
        request_id: request.requestId,
        session_id: sessionId,
        agent: agentType,
        tool_name: request.toolName,
        tool_args: request.toolArgs,
        risk_level: request.riskLevel,
        description: request.description,
        affected_files: request.affectedFiles,
        expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      },
    });
  }

  /**
   * Create a new session record.
   *
   * WHY: Sessions are tracked both locally (for the CLI UI) and remotely
   * (in Supabase, for the mobile app and web dashboard). This method
   * creates the local record; the remote record is created by ApiSessionManager.
   *
   * @param session - Partial session configuration
   * @returns The created session with a generated ID and timestamps
   */
  async createSession(session: Partial<ApiSession>): Promise<ApiSession> {
    const created: ApiSession = {
      sessionId: crypto.randomUUID(),
      agentType: session.agentType || 'claude',
      status: 'starting',
      projectPath: session.projectPath || process.cwd(),
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
    };
    this.sessionId = created.sessionId;

    // Update relay presence with session info
    if (this.relay && this.isConnected()) {
      await this.relay.updatePresence({
        session_id: created.sessionId,
        active_agent: created.agentType as SharedAgentType,
      });
    }

    logger.debug('StyrbyApi session created', { sessionId: created.sessionId });
    return created;
  }

  /**
   * End a session and clean up relay presence.
   *
   * @param sessionId - Session to end
   */
  async endSession(sessionId: string): Promise<void> {
    logger.debug('StyrbyApi endSession', { sessionId });

    if (this.sessionId === sessionId) {
      this.sessionId = null;
    }

    // Clear session from relay presence
    if (this.relay && this.isConnected()) {
      await this.relay.updatePresence({
        session_id: undefined,
        active_agent: undefined,
      });
    }
  }

  /**
   * Check if the mobile app is currently connected to the relay.
   *
   * @returns True if at least one mobile device is online in the user's relay channel
   */
  isMobileOnline(): boolean {
    return this.relay?.isDeviceTypeOnline('mobile') ?? false;
  }
}

/**
 * Singleton API client instance.
 *
 * WHY: A single API client is shared across the CLI because there's only
 * one relay connection per CLI process (one user, one channel).
 */
export const api = new StyrbyApi();

/**
 * Default export for compatibility
 */
export default api;
