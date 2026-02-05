/**
 * RPC Handler Manager
 *
 * Manages RPC-style handlers for CLI commands from mobile.
 *
 * Architecture Decision: Supabase Realtime Messages (WebSocket)
 *
 * WHY: Styrby uses Supabase Realtime channels for bidirectional CLI <-> mobile
 * communication. The RelayClient in styrby-shared establishes a WebSocket
 * connection to Supabase Realtime, and RPC calls are dispatched as typed
 * messages on those channels. This was chosen over Edge Functions (HTTP)
 * because:
 * - WebSocket provides persistent, low-latency bidirectional messaging
 * - Realtime channels already exist for session state and streaming
 * - No additional HTTP round-trips for each RPC call
 * - The apiSession relay bridge (api/apiSession.ts) handles the high-level
 *   session lifecycle; this manager handles the lower-level per-handler
 *   dispatch used by forked agent code (claude/codex/gemini launchers,
 *   registerCommonHandlers, permissionHandlers, etc.)
 *
 * @module api/rpc/RpcHandlerManager
 */

import { logger } from '@/ui/logger';

/**
 * RPC handler function type.
 *
 * @typeParam T - Parameter type the handler accepts
 * @typeParam R - Return type the handler produces
 */
export type RpcHandler<T = unknown, R = unknown> = (params: T) => Promise<R> | R;

/**
 * Manages RPC handlers for remote procedure calls dispatched over Supabase
 * Realtime channels.
 *
 * Used by agent launchers and common modules to register method handlers
 * (bash, readFile, writeFile, abort, killSession, permission, etc.) that
 * are invoked when the mobile app sends an RPC message via the relay.
 */
export class RpcHandlerManager {
  private handlers: Map<string, RpcHandler> = new Map();

  /**
   * Register an RPC handler for a given method name.
   *
   * @param method - RPC method name (e.g., 'bash', 'readFile', 'abort')
   * @param handler - Handler function to invoke when this method is called
   */
  registerHandler<T = unknown, R = unknown>(method: string, handler: RpcHandler<T, R>): void {
    this.handlers.set(method, handler as RpcHandler);
    logger.debug(`RPC handler registered: ${method}`);
  }

  /**
   * Unregister an RPC handler.
   *
   * @param method - RPC method name to remove
   */
  unregisterHandler(method: string): void {
    this.handlers.delete(method);
    logger.debug(`RPC handler unregistered: ${method}`);
  }

  /**
   * Call an RPC handler by method name.
   *
   * @param method - RPC method name to invoke
   * @param params - Parameters to pass to the handler
   * @returns Handler result
   * @throws {Error} When no handler is registered for the given method
   */
  async call<T = unknown, R = unknown>(method: string, params: T): Promise<R> {
    const handler = this.handlers.get(method);
    if (!handler) {
      throw new Error(`RPC handler not found: ${method}`);
    }
    return handler(params) as Promise<R>;
  }

  /**
   * Check if a handler is registered for a method.
   *
   * @param method - RPC method name
   * @returns True if a handler exists for this method
   */
  has(method: string): boolean {
    return this.handlers.has(method);
  }

  /**
   * Get all registered method names.
   *
   * @returns Array of registered RPC method names
   */
  getMethods(): string[] {
    return Array.from(this.handlers.keys());
  }
}

/**
 * Singleton RPC handler manager instance.
 *
 * WHY: A single instance is shared across the CLI process so that agent
 * launchers, common handlers, and permission handlers all register into
 * the same dispatch table.
 */
export const rpcHandlerManager = new RpcHandlerManager();

/**
 * Default export for compatibility with forked code that uses default imports.
 */
export default rpcHandlerManager;
