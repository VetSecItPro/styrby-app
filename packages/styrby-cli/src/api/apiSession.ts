/**
 * API Session Management
 *
 * Handles session lifecycle and message routing for agent sessions.
 *
 * WHY: This is a stub module replacing Happy Coder's session management.
 * The actual implementation will use Supabase for session state.
 *
 * @module api/apiSession
 */

import type { ApiSession, ApiMessage, SessionUpdate } from './types';
import { logger } from '@/ui/logger';

/**
 * Callback type for session updates
 */
export type SessionUpdateHandler = (update: SessionUpdate) => void;

/**
 * Session manager for handling agent sessions.
 *
 * TODO: Implement with Supabase
 * - Store session state in Supabase
 * - Use Supabase Realtime for session updates
 * - Handle session resume/recovery
 */
export class ApiSessionManager {
  private sessions: Map<string, ApiSession> = new Map();
  private updateHandlers: Map<string, SessionUpdateHandler[]> = new Map();

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
   * Emit a session update.
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
   * Send a message for a session.
   *
   * @param sessionId - Session to send to
   * @param message - Message to send
   */
  async sendMessage(sessionId: string, message: Omit<ApiMessage, 'id' | 'sessionId' | 'timestamp'>): Promise<void> {
    logger.debug('ApiSession sendMessage (stub)', { sessionId, type: message.type });
    // TODO: Implement via Supabase Realtime
  }
}

/**
 * Singleton session manager
 */
export const apiSession = new ApiSessionManager();

/**
 * Default export for compatibility
 */
export default apiSession;
