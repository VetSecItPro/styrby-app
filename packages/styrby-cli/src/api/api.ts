/**
 * API Client
 *
 * Main API client for connecting CLI to the Styrby relay.
 *
 * WHY: This is a stub module replacing Happy Coder's socket.io-based API.
 * The actual implementation will use Supabase Realtime for the relay.
 * For now, it provides the interface that the forked code expects.
 *
 * @module api/api
 */

import type { ApiConnectionState, ApiSession, ApiMessage } from './types';
import { logger } from '@/ui/logger';

/**
 * API client instance for connecting to Styrby relay.
 *
 * TODO: Implement with Supabase Realtime
 * - Connect to Supabase Realtime channel for session
 * - Handle incoming messages from mobile
 * - Send outgoing messages to mobile
 * - Manage connection state and reconnection
 */
export class StyrbyApi {
  private connectionState: ApiConnectionState = 'disconnected';
  private sessionId: string | null = null;

  /**
   * Connect to the Styrby relay.
   *
   * @param token - Authentication token from Supabase Auth
   * @returns Promise that resolves when connected
   */
  async connect(token: string): Promise<void> {
    logger.debug('API connect called (stub)', { token: token.slice(0, 10) + '...' });
    // TODO: Implement Supabase Realtime connection
    this.connectionState = 'connected';
  }

  /**
   * Disconnect from the relay.
   */
  async disconnect(): Promise<void> {
    logger.debug('API disconnect called (stub)');
    this.connectionState = 'disconnected';
    this.sessionId = null;
  }

  /**
   * Get current connection state.
   */
  getConnectionState(): ApiConnectionState {
    return this.connectionState;
  }

  /**
   * Check if connected to the relay.
   */
  isConnected(): boolean {
    return this.connectionState === 'connected';
  }

  /**
   * Send a message through the relay.
   *
   * @param message - The message to send
   */
  async sendMessage(message: ApiMessage): Promise<void> {
    logger.debug('API sendMessage called (stub)', { type: message.type });
    // TODO: Implement via Supabase Realtime
  }

  /**
   * Create a new session.
   *
   * @param session - Session configuration
   * @returns Created session
   */
  async createSession(session: Partial<ApiSession>): Promise<ApiSession> {
    logger.debug('API createSession called (stub)', session);
    // TODO: Implement via Supabase
    const created: ApiSession = {
      sessionId: crypto.randomUUID(),
      agentType: session.agentType || 'claude',
      status: 'starting',
      projectPath: session.projectPath || process.cwd(),
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
    };
    this.sessionId = created.sessionId;
    return created;
  }

  /**
   * End a session.
   *
   * @param sessionId - Session to end
   */
  async endSession(sessionId: string): Promise<void> {
    logger.debug('API endSession called (stub)', { sessionId });
    // TODO: Implement via Supabase
    if (this.sessionId === sessionId) {
      this.sessionId = null;
    }
  }
}

/**
 * Singleton API client instance
 */
export const api = new StyrbyApi();

/**
 * Default export for compatibility
 */
export default api;
